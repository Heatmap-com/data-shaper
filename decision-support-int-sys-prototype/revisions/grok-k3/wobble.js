// The wobble band: twice the median week-over-week change over the whole weeks before the judged week.
export const BAND = { mult: 2, minChanges: 3 };

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

// Rates move in points, counts and money in percent.
export function changeOf(cur, prev, unit) {
  if (cur === null || prev === null || cur === undefined || prev === undefined) return null;
  if (unit === 'pp') return (cur - prev) * 100;
  if (unit === 'abs') return cur - prev;
  if (!prev) return null;
  return (cur / prev - 1) * 100;
}

// values[i] is the measure in week i, full[i] whether week i is whole. Uses the changes that end before week idx.
export function bandFor(values, full, idx, unit, opts = BAND) {
  const changes = [];
  for (let i = 1; i < idx; i += 1) {
    if (!full[i] || !full[i - 1]) continue;
    const c = changeOf(values[i], values[i - 1], unit);
    if (c !== null && Number.isFinite(c)) changes.push(Math.abs(c));
  }
  if (changes.length < opts.minChanges) return { band: null, median: null, n: changes.length };
  const m = median(changes);
  return { band: opts.mult * m, median: m, n: changes.length };
}

// badge: moved | within | cantsay, plus thin when volume is under the floor.
export function judge({ delta, band, partial, thin }) {
  let badge;
  let reason = null;
  if (partial) { badge = 'cantsay'; reason = 'partial week'; }
  else if (delta === null || delta === undefined || !Number.isFinite(delta)) { badge = 'cantsay'; reason = 'no comparison'; }
  else if (band === null || band === undefined) { badge = 'cantsay'; reason = 'fewer than 4 whole weeks'; }
  else badge = Math.abs(delta) > band ? 'moved' : 'within';
  return { badge, thin: Boolean(thin), reason };
}

export const fmtDelta = (d, unit, digits) => {
  if (d === null || d === undefined || !Number.isFinite(d)) return '–';
  const n = digits ?? (unit === 'pp' ? 2 : 1);
  return `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d).toFixed(n)}${unit === 'pp' ? ' pts' : '%'}`;
};
export const fmtBand = (b, unit) => (b === null || b === undefined ? '–' : `±${b.toFixed(unit === 'pp' ? 2 : 1)}${unit === 'pp' ? ' pts' : '%'}`);

export function badgeText(j) {
  if (j.badge === 'moved') return 'moved';
  if (j.badge === 'within') return 'within wobble';
  return "can't say";
}

export function tooltip({ label, unit, band, median, n, delta, j, scope }) {
  if (j.badge === 'cantsay') return `${label}: can't say — ${j.reason}.${j.thin ? ' Also below the volume floor.' : ''}`;
  const who = scope === 'site' ? 'on this site' : 'for this row';
  const lines = [
    `${label} usually moves about ${fmtBand(median, unit).replace('±', '±')} a week ${who} (median of ${n} whole-week changes); the band is twice that, ${fmtBand(band, unit)}.`,
    `This moved ${fmtDelta(delta, unit)}: ${j.badge === 'moved' ? 'outside the band' : 'inside the band'}.`,
  ];
  if (j.thin) lines.push('Thin: below the volume floor, so read it as directional.');
  return lines.join(' ');
}
