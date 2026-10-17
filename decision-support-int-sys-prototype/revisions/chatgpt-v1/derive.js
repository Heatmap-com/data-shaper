// Scope totals, comparisons, the revenue bridge, mix versus rate, and the brief.
import { coverage, coverageSentence, formatDay, rankWindow } from './contracts.js';
import { combineCoverage, screenRate, trustState, wilson } from './screening.js';

const COUNTS = ['sessions', 'product_viewed', 'added_to_cart', 'checkout_started', 'buyers', 'orders', 'revenue'];
const EVENTS = [
  ['product_viewed', 'Product viewed'],
  ['added_to_cart', 'Added to cart'],
  ['checkout_started', 'Checkout started'],
  ['buyers', 'Bought'],
];

export function scopeId({ dataset = 'funnel', segment = 'all', segmentValue = 'all', device = 'all', entry = null }) {
  let id = `${dataset}|seg=${segment}:${segmentValue}|dev=${device}`;
  if (entry && entry !== 'all') id += `|entry=${entry}`;
  return id;
}

function add(into, row) {
  for (const c of COUNTS) {
    const n = row[c];
    if (n === null || n === undefined || n === '') continue;
    into[c] = (into[c] ?? 0) + Number(n);
  }
}

export function scopeWeekly(rows, { segment = 'all', segmentValue = 'all', device = 'all', entry = null } = {}) {
  if ((segment === 'all') !== (segmentValue === 'all')) {
    throw new Error('refusing to mix segment = all with a member value');
  }
  const id = scopeId({ segment, segmentValue, device, entry });
  const byWeek = new Map();
  for (const r of rows) {
    if (String(r.segment) !== String(segment) || String(r.segment_value) !== String(segmentValue)) continue;
    if (String(r.viewport_type) !== String(device)) continue;
    if (entry && entry !== 'all' && String(r.entry) !== String(entry)) continue;
    let g = byWeek.get(r.week);
    if (!g) {
      g = { scope_id: id, week: r.week };
      for (const c of COUNTS) g[c] = null;
      byWeek.set(r.week, g);
    }
    add(g, r);
  }
  return [...byWeek.values()].sort((a, b) => (a.week < b.week ? -1 : 1));
}

function blank() {
  const g = {};
  for (const c of COUNTS) g[c] = null;
  return g;
}

function groupPartition(rows, { segment, device, week, keyOf, members }) {
  const acc = new Map();
  for (const r of rows) {
    if (r.week !== week) continue;
    if (segment) {
      if (r.segment !== segment.family) continue;
      if (segment.value !== undefined && r.segment_value !== segment.value) continue;
    }
    if (device && r.viewport_type !== device) continue;
    const key = keyOf(r);
    if (members && !members.includes(key)) continue;
    let g = acc.get(key);
    if (!g) { g = blank(); acc.set(key, g); }
    add(g, r);
  }
  return acc;
}

export function factorize(row) {
  if (!row || row.sessions === null || row.sessions === undefined) return null;
  const sessions = row.sessions;
  const buyers = row.buyers ?? 0;
  const orders = row.orders ?? 0;
  const revenue = row.revenue ?? 0;
  if (!sessions) return null;
  if (!buyers || !orders) return { defined: false, sessions, rps: revenue / sessions, revenue };
  return {
    defined: true,
    sessions,
    rate: buyers / sessions,
    ops: orders / buyers,
    aov: revenue / orders,
    revenue,
  };
}

function permutations(n) {
  const out = [];
  const rec = (a, i) => {
    if (i === a.length) { out.push(a.slice()); return; }
    for (let j = i; j < a.length; j += 1) {
      [a[i], a[j]] = [a[j], a[i]];
      rec(a, i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
  };
  rec([...Array(n).keys()], 0);
  return out;
}

const FACTOR_LABELS = {
  sessions: 'Sessions',
  rate: 'Buying-session rate',
  ops: 'Orders per buying session',
  aov: 'Average order',
  rps: 'Revenue per session',
};

export function shapleyBridge(priorRow, currentRow) {
  const observed = (currentRow?.revenue ?? 0) - (priorRow?.revenue ?? 0);
  const p = factorize(priorRow);
  const c = factorize(currentRow);
  if (!p || !c) return { defined: false, fallback: false, contributions: [], observed, residual: observed, note: 'comparison unavailable' };
  if (!p.defined || !c.defined) {
    const rps0 = p.sessions ? (priorRow.revenue ?? 0) / p.sessions : 0;
    const rps1 = c.sessions ? (currentRow.revenue ?? 0) / c.sessions : 0;
    const sessions = ((c.sessions - p.sessions) * (rps0 + rps1)) / 2;
    const rps = ((rps1 - rps0) * (p.sessions + c.sessions)) / 2;
    const contributions = [
      { factor: 'sessions', label: FACTOR_LABELS.sessions, value: sessions },
      { factor: 'rps', label: FACTOR_LABELS.rps, value: rps },
    ];
    const residual = observed - sessions - rps;
    return { defined: false, fallback: true, contributions, observed, residual, note: 'A ratio was undefined, so this is the two-factor split of sessions × revenue per session.' };
  }
  const keys = ['sessions', 'rate', 'ops', 'aov'];
  const pv = keys.map((k) => p[k]);
  const cv = keys.map((k) => c[k]);
  const acc = [0, 0, 0, 0];
  const prod = (v) => v[0] * v[1] * v[2] * v[3];
  for (const perm of permutations(4)) {
    const cur = pv.slice();
    let before = prod(cur);
    for (const i of perm) {
      cur[i] = cv[i];
      const after = prod(cur);
      acc[i] += after - before;
      before = after;
    }
  }
  const contributions = keys.map((k, i) => ({ factor: k, label: FACTOR_LABELS[k], value: acc[i] / 24 }));
  const sum = contributions.reduce((s, x) => s + x.value, 0);
  return { defined: true, fallback: false, contributions, observed, residual: observed - sum, note: null };
}

export function mixRateSplit(members) {
  const N0 = members.reduce((s, m) => s + (m.n0 || 0), 0);
  const N1 = members.reduce((s, m) => s + (m.n1 || 0), 0);
  const X0 = members.reduce((s, m) => s + (m.x0 || 0), 0);
  const X1 = members.reduce((s, m) => s + (m.x1 || 0), 0);
  const p0 = N0 ? X0 / N0 : null;
  const p1 = N1 ? X1 / N1 : null;
  let mix = 0; let rate = 0; let entered = 0; let exited = 0;
  const rows = members.map((m) => {
    const in0 = m.n0 > 0; const in1 = m.n1 > 0;
    const row = { key: m.key, n0: m.n0 || 0, n1: m.n1 || 0, x0: m.x0 || 0, x1: m.x1 || 0, w0: null, w1: null, p0: null, p1: null, mix: 0, rate: 0, entered: 0, exited: 0 };
    if (in0 && in1 && N0 && N1) {
      row.w0 = m.n0 / N0; row.w1 = m.n1 / N1;
      row.p0 = m.x0 / m.n0; row.p1 = m.x1 / m.n1;
      row.mix = (row.w1 - row.w0) * (row.p0 + row.p1) / 2;
      row.rate = (row.p1 - row.p0) * (row.w0 + row.w1) / 2;
      mix += row.mix; rate += row.rate;
    } else if (in1 && !in0 && N1) {
      row.w1 = m.n1 / N1; row.p1 = m.x1 / m.n1;
      row.entered = row.w1 * row.p1;
      entered += row.entered;
    } else if (in0 && !in1 && N0) {
      row.w0 = m.n0 / N0; row.p0 = m.x0 / m.n0;
      row.exited = -row.w0 * row.p0;
      exited += row.exited;
    }
    return row;
  });
  const observed = p0 === null || p1 === null ? null : p1 - p0;
  return { mix, rate, entered, exited, observed, p0, p1, rows };
}

function pairMembers(rows, spec, week, compareWeek) {
  const a = groupPartition(rows, { ...spec, week });
  const b = compareWeek ? groupPartition(rows, { ...spec, week: compareWeek }) : new Map();
  const keys = [...new Set([...a.keys(), ...b.keys()])];
  return keys.map((key) => ({
    key,
    n0: b.get(key)?.sessions ?? 0,
    x0: b.get(key)?.buyers ?? 0,
    rev0: b.get(key)?.revenue ?? 0,
    n1: a.get(key)?.sessions ?? 0,
    x1: a.get(key)?.buyers ?? 0,
    rev1: a.get(key)?.revenue ?? 0,
  }));
}

export const PARTITIONS = {
  traffic_source: {
    label: 'Traffic source',
    spec: (device) => ({ segment: { family: 'traffic_source' }, device, keyOf: (r) => r.segment_value }),
  },
  device: {
    label: 'Device',
    spec: () => ({ segment: { family: 'all', value: 'all' }, keyOf: (r) => r.viewport_type, members: ['mobile', 'desktop', 'tablet'] }),
  },
  entry: {
    label: 'Entry type',
    spec: (device) => ({ segment: { family: 'all', value: 'all' }, device, keyOf: (r) => r.entry }),
  },
  returning: {
    label: 'New or returning',
    spec: (device) => ({ segment: { family: 'returning' }, device, keyOf: (r) => r.segment_value }),
  },
};

export function partitionEffects(rows, partition, device, week, compareWeek) {
  const spec = PARTITIONS[partition].spec(device);
  const members = pairMembers(rows, spec, week, compareWeek);
  const split = mixRateSplit(members);
  const revenue = members.map((m) => ({ key: m.key, delta: (m.rev1 || 0) - (m.rev0 || 0), revenue: m.rev1 || 0 }));
  const revenueSum = revenue.reduce((s, m) => s + m.delta, 0);
  return { ...split, revenue, revenueSum };
}

export function summarizeJourneys(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = [r.kind, r.path, r.viewport_type, r.segment, r.segment_value, r.week].join('|');
    const g = groups.get(key) ?? { kind: r.kind, path: r.path, rank: r.rank, viewport_type: r.viewport_type, segment: r.segment, segment_value: r.segment_value, week: r.week, steps: [] };
    if (r.row_key === 'step') g.steps.push(r);
    groups.set(key, g);
  }
  const out = [];
  for (const g of groups.values()) {
    if (!g.steps.length) continue;
    g.steps.sort((a, b) => a.step_index - b.step_index);
    const first = g.steps[0];
    const last = g.steps[g.steps.length - 1];
    out.push({
      kind: g.kind, path: g.path, rank: first.rank, viewport_type: g.viewport_type, segment: g.segment, segment_value: g.segment_value, week: g.week,
      start_sessions: first.sessions, end_sessions: last.sessions, bought: last.buyers,
    });
  }
  return out;
}

function covOf(manifest, dataset, week) {
  return coverage(manifest, dataset).get(week)?.state ?? 'unverified-complete';
}

function makeRate(base, config, M) {
  const trust = trustState({
    x0: base.x0, n0: base.n0, x1: base.x1, n1: base.n1,
    coverage: base.coverage, capped: false, buyerDefined: base.buyerDefined,
  });
  const current = base.n1 ? base.x1 / base.n1 : null;
  const prior = base.n0 ? base.x0 / base.n0 : null;
  const showDelta = trust === 'ok' || trust === 'small' || trust === 'unverified-complete';
  const rec = {
    ...base,
    kind: 'rate',
    trust,
    current,
    prior,
    delta: showDelta && current !== null && prior !== null ? current - prior : null,
    wilson1: wilson(base.x1, base.n1),
    wilson0: wilson(base.x0, base.n0),
  };
  rec.screen = screenRate({ ...rec, trust }, { M, config });
  return rec;
}

const STEP_LABEL = {
  content: 'content', pdp: 'product page', home: 'home', plp: 'collection', cart: 'cart',
  search: 'search', other: 'other', '(no page view)': 'no page view',
};
const SOURCE_LABEL = {
  meta: 'Meta', search: 'Search', campaign: 'Campaign', direct: 'Direct', social: 'Social', website: 'Website',
  new: 'New', returning: 'Returning', mobile: 'Mobile', desktop: 'Desktop', tablet: 'Tablet',
};

export function labelOf(value) {
  if (SOURCE_LABEL[value]) return SOURCE_LABEL[value];
  if (STEP_LABEL[value]) return STEP_LABEL[value];
  const text = String(value ?? '');
  if (!text || text === 'null') return 'All';
  return text.replace(/_/g, ' ');
}

export function pathLabel(path) {
  const parts = String(path).split(' > ').map((p) => STEP_LABEL[p] ?? labelOf(p));
  if (parts[0]) parts[0] = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  return parts.join(' → ');
}

export function fmtPct(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${(v * 100).toFixed(2)}%`;
}

export function fmtShare(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

export function fmtPoints(delta, digits = 2) {
  if (delta === null || delta === undefined || Number.isNaN(delta)) return '—';
  const pts = Math.abs(delta * 100).toFixed(digits);
  if (delta > 0) return `+${pts}`;
  if (delta < 0) return `−${pts}`;
  return (0).toFixed(digits);
}

function claimFor(rule, fields) {
  return rule.claimTemplate.replace(/\{(\w+)\}/g, (_, k) => (fields[k] === undefined || fields[k] === null ? '—' : String(fields[k])));
}

const CAVEAT_TEXT = {
  last_touch: 'Last touch.',
  no_spend_data: 'On-site value only: no spend, so nothing here says a channel is or isn\'t profitable.',
  unordered: 'Actions recorded anywhere in the session. Not an ordered sequence.',
  frozen_rank: 'Ranked once for the whole site, not re-ranked for this segment.',
};

function caveatLines(rule) {
  return (rule.requiredCaveats ?? []).map((id) => CAVEAT_TEXT[id] ?? id).filter(Boolean);
}

export function buildAnalysis({ funnelRows, journeyRows, manifest, context, screening, rules, emptyState }) {
  const { week, compareWeek, segment = 'all', segmentValue = 'all', device = 'all' } = context;
  const buyerDefined = segment === 'buyer';
  const cov = (dataset, w) => (w ? covOf(manifest, dataset, w) : null);
  const rateCoverage = combineCoverage(cov('funnel', week), compareWeek ? cov('funnel', compareWeek) : 'verified');
  const site = scopeWeekly(funnelRows, { segment, segmentValue, device });
  const cur = site.find((r) => r.week === week) ?? null;
  const prev = compareWeek ? site.find((r) => r.week === compareWeek) ?? null : null;

  const family = [];
  const eventReach = EVENTS.map(([metric, subject]) => {
    const rec = {
      subject, metric, theme: 'event_reach', family: true, scope_id: cur?.scope_id,
      x1: cur?.[metric] ?? null, n1: cur?.sessions ?? null,
      x0: prev?.[metric] ?? null, n0: prev?.sessions ?? null,
      coverage: rateCoverage, buyerDefined: buyerDefined && metric === 'buyers',
      dataset: 'funnel',
    };
    family.push(rec);
    return rec;
  });

  const channelMembers = segment === 'all' || segment === 'traffic_source'
    ? pairMembers(funnelRows, PARTITIONS.traffic_source.spec(device), week, compareWeek)
    : [];
  const channels = channelMembers.map((m) => ({
    ...m,
    subject: labelOf(m.key),
    key: m.key,
    share1: null,
    share0: null,
  }));
  const n1sum = channels.reduce((s, m) => s + m.n1, 0);
  const n0sum = channels.reduce((s, m) => s + m.n0, 0);
  for (const m of channels) {
    m.share1 = n1sum ? m.n1 / n1sum : null;
    m.share0 = n0sum ? m.n0 / n0sum : null;
    const rec = {
      subject: m.subject, metric: 'session_conversion', theme: 'channel', family: segment === 'all', key: m.key,
      x1: m.x1, n1: m.n1, x0: compareWeek ? m.x0 : null, n0: compareWeek ? m.n0 : null,
      coverage: rateCoverage, buyerDefined: false, dataset: 'funnel',
      revenue1: m.rev1, revenue0: m.rev0,
    };
    if (segment === 'all') family.push(rec);
    m.rate = rec;
  }

  const summaries = summarizeJourneys(journeyRows).filter((r) => r.kind === 'general' && r.segment === segment && r.segment_value === segmentValue && r.viewport_type === device);
  const paths = [...new Set(summaries.map((r) => r.path))];
  const journeys = paths.map((path) => {
    const a = summaries.find((r) => r.path === path && r.week === week);
    const b = compareWeek ? summaries.find((r) => r.path === path && r.week === compareWeek) : null;
    const rec = {
      subject: pathLabel(path), path, metric: 'completion', theme: 'journey', family: true, rank: a?.rank ?? b?.rank ?? 99,
      x1: a?.end_sessions ?? null, n1: a?.start_sessions ?? null,
      x0: b?.end_sessions ?? null, n0: b?.start_sessions ?? null,
      bought1: a?.bought ?? null, end1: a?.end_sessions ?? null,
      coverage: combineCoverage(cov('journey_summary', week), compareWeek ? cov('journey_summary', compareWeek) : 'verified'),
      buyerDefined: false, dataset: 'journey_summary',
    };
    family.push(rec);
    return rec;
  }).sort((a, b) => a.rank - b.rank);

  const M = family.length;
  const screened = {};
  const finish = (rec) => {
    const done = makeRate(rec, screening, M);
    screened[`${rec.theme}:${rec.metric}:${rec.subject}`] = done;
    return done;
  };
  const eventsDone = eventReach.map(finish);
  const channelsDone = channels.map((m) => ({ ...m, rate: finish(m.rate) }));
  const journeysDone = journeys.map(finish);

  const others = (key) => {
    const rest = channelsDone.filter((m) => m.key !== key);
    const n = rest.reduce((s, m) => s + m.n1, 0);
    const x = rest.reduce((s, m) => s + m.x1, 0);
    const top = [...rest].sort((a, b) => b.n1 - a.n1)[0];
    return { rate: n ? x / n : null, top };
  };

  const byId = Object.fromEntries((rules ?? []).map((r) => [r.id, r]));
  const candidates = [];
  const journeyRule = byId.journey_completion_decline;
  const levelRule = byId.channel_on_site_value;
  const reachRule = byId.event_reach_movement;
  const changeRule = byId.channel_rate_change;

  if (journeyRule) {
    for (const j of journeysDone) {
      if (!(j.delta < 0) || !j.screen.review) continue;
      const fields = {
        path: j.subject,
        completion: fmtPct(j.current),
        completion_pct: fmtPct(j.current),
        delta_pp: fmtPoints(j.delta),
        compare_week: formatDay(compareWeek),
        starts: (j.n1 ?? 0).toLocaleString(),
      };
      candidates.push({
        ruleId: journeyRule.id, theme: 'journey', tier: 1, exposure: j.n1 ?? 0,
        claim: `${fields.path}: ${fields.completion} completed, ${fields.delta_pp} points versus the week of ${fields.compare_week}, across ${fields.starts} starts.`,
        fields, caveats: caveatLines(journeyRule), prohibited: journeyRule.prohibitedClaims ?? [],
        evidence: j, go: { tab: 'paths', focus: j.path },
      });
    }
  }
  if (reachRule) {
    for (const e of eventsDone) {
      if (e.metric === 'buyers') continue;
      if (!e.screen.review) continue;
      const fields = { action: e.subject, current: fmtPct(e.current), delta_pp: fmtPoints(e.delta), compare_week: formatDay(compareWeek) };
      const tier = e.delta < 0 ? 1 : 3;
      candidates.push({
        ruleId: reachRule.id, theme: 'event_reach', tier, exposure: e.n1 ?? 0,
        claim: `${fields.action}: ${fields.current} of sessions, ${fields.delta_pp} points versus the week of ${fields.compare_week}.`,
        fields, caveats: caveatLines(reachRule), prohibited: reachRule.prohibitedClaims ?? [],
        evidence: e, go: { tab: 'paths' },
      });
    }
  }
  if (levelRule && segment === 'all' && channelsDone.length) {
    const top = [...channelsDone].sort((a, b) => b.n1 - a.n1)[0];
    const o = others(top.key);
    if (top.rate.current !== null && o.rate !== null && top.rate.current < o.rate) {
      const fields = {
        source: top.subject, segment_label: top.subject,
        share: fmtPct(top.share1), current_pct: fmtPct(top.rate.current), rate: fmtPct(top.rate.current),
        others_rate: fmtPct(o.rate), comparison_pct: fmtPct(o.rate), comparison_label: 'all other sources',
        top2_label: o.top ? o.top.subject : '', top2_rate: o.top ? fmtPct(o.top.rate.current) : '',
      };
      candidates.push({
        ruleId: levelRule.id, theme: 'channel', tier: 2, exposure: top.n1,
        claim: `${fields.source}: ${fmtShare(top.share1)} of sessions, ${fields.rate} of them bought, versus ${fields.others_rate} for all other sources (${fields.top2_label} ${fields.top2_rate}).`,
        fields, caveats: caveatLines(levelRule), prohibited: levelRule.prohibitedClaims ?? [],
        evidence: top.rate, go: { tab: 'channels', seg: 'traffic_source', segv: top.key },
      });
    }
  }
  if (changeRule && segment === 'all') {
    for (const m of channelsDone) {
      if (!m.rate.screen.review) continue;
      const tier = m.rate.delta < 0 ? 1 : 3;
      const fields = { source: m.subject, prior: fmtPct(m.rate.prior), current: fmtPct(m.rate.current) };
      candidates.push({
        ruleId: changeRule.id, theme: 'channel', tier, exposure: m.n1,
        claim: `${fields.source} sessions that bought: ${fields.prior} → ${fields.current}.`,
        fields, caveats: caveatLines(changeRule), prohibited: changeRule.prohibitedClaims ?? [],
        evidence: m.rate, go: { tab: 'channels', seg: 'traffic_source', segv: m.key },
      });
    }
  }

  const ranked = [...candidates].sort((a, b) => a.tier - b.tier || b.exposure - a.exposure);
  const seen = new Set();
  const findings = [];
  const improvements = [];
  for (const c of ranked) {
    if (c.tier === 3) {
      if (seen.has(`imp:${c.theme}`)) continue;
      seen.add(`imp:${c.theme}`);
      improvements.push(c);
      continue;
    }
    if (seen.has(c.theme)) continue;
    seen.add(c.theme);
    if (findings.length < 3) findings.push(c);
  }

  const bridge = shapleyBridge(prev, cur);
  const outcomes = { current: cur, prior: prev, buying: eventsDone.find((e) => e.metric === 'buyers') };

  return {
    M,
    week,
    compareWeek,
    scope: site,
    outcomes,
    eventReach: eventsDone,
    channels: channelsDone,
    journeys: journeysDone,
    bridge,
    findings,
    improvements,
    emptyState: findings.length < 3 ? (emptyState ?? '') : '',
    limits: limits(manifest, context),
    rateCoverage,
  };
}

function limits(manifest, context) {
  const lines = [];
  if (context.rowsOf) lines.push(coverageSentence(manifest, context.rowsOf));
  lines.push('No ad spend: channel profitability can\'t be judged.');
  lines.push('Funnel actions are not ordered: no step-to-step rates.');
  const capped = Object.entries(manifest?.datasets ?? {}).filter(([, d]) => d.capped).map(([name, d]) => `${name} (${d.rows.toLocaleString()} of ${d.cappedFrom.toLocaleString()})`);
  if (capped.length) lines.push(`Incomplete sources: ${capped.join('; ')}. Totals from those tables are not shown.`);
  return lines;
}

export function outcomeFacts(outcomes) {
  const c = outcomes.current; const p = outcomes.prior;
  const rate = (row) => (row && row.sessions ? row.buyers / row.sessions : null);
  const ops = (row) => (row && row.buyers ? row.orders / row.buyers : null);
  const aov = (row) => (row && row.orders ? row.revenue / row.orders : null);
  return {
    sessions: { current: c?.sessions ?? null, prior: p?.sessions ?? null },
    rate: { current: rate(c), prior: rate(p), screen: outcomes.buying?.screen },
    ops: { current: ops(c), prior: ops(p) },
    aov: { current: aov(c), prior: aov(p) },
    revenue: { current: c?.revenue ?? null, prior: p?.revenue ?? null },
  };
}

export function fixedVolume(starts, current, prior) {
  if (starts === null || current === null || prior === null || current >= prior) return null;
  return starts * (prior - current);
}

export { formatDay, rankWindow, wilson };
