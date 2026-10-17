const valueOf = (p) => (p.num !== undefined ? (p.den ? p.num / p.den : null) : p.value);
const daysOf = (p) => p.days ?? 7;

function se(p, den) {
  if (!den) return Infinity;
  return Math.sqrt((p * (1 - p)) / den);
}

function pointsText(n) {
  const v = Math.abs(n);
  const digits = v >= 1 ? 2 : 2;
  return `${n < 0 ? 'Down' : 'Up'} ${v.toFixed(digits)} points`;
}

function countText(n) {
  const v = Math.abs(Math.round(n));
  return `${n < 0 ? 'Down' : 'Up'} ${v.toLocaleString()}`;
}

export function classify(points, i, { kind = 'rate', floor = { den: 100, num: 10 }, sigma = 2 } = {}) {
  const cur = points[i];
  const prev = points[i - 1];
  if (!cur || !prev) return { label: 'partial', delta: null, noise: null, maxPriorMove: null, reason: 'There is no previous week to judge.' };
  if (daysOf(cur) !== 7 || daysOf(prev) !== 7) {
    return { label: 'partial', delta: null, noise: null, maxPriorMove: null, reason: 'One of these weeks is partial, so there is no judgement.' };
  }
  const v1 = valueOf(cur);
  const v0 = valueOf(prev);
  const delta = v1 === null || v0 === null ? null : v1 - v0;

  if (kind === 'rate') {
    const thinDen = cur.den < floor.den || prev.den < floor.den;
    const thinNum = (cur.num ?? 0) < floor.num && (prev.num ?? 0) < floor.num;
    if (thinDen || thinNum) {
      return { label: 'thin', delta, noise: null, maxPriorMove: null, reason: 'Too few sessions or orders to call this a change.' };
    }
  } else if (kind === 'count') {
    if ((cur.value ?? 0) < 100 || (prev.value ?? 0) < 100) {
      return { label: 'thin', delta, noise: null, maxPriorMove: null, reason: 'Too few to call this a change.' };
    }
  }

  const moves = [];
  for (let k = 1; k <= i; k += 1) {
    if (daysOf(points[k]) !== 7 || daysOf(points[k - 1]) !== 7) continue;
    const a = valueOf(points[k]);
    const b = valueOf(points[k - 1]);
    if (a === null || b === null) continue;
    moves.push(a - b);
  }
  const prior = moves.slice(0, -1);
  const maxPriorMove = prior.length ? Math.max(...prior.map((m) => Math.abs(m))) : null;
  const noise = kind === 'rate' && cur.den && prev.den
    ? sigma * Math.sqrt(se(v1, cur.den) ** 2 + se(v0, prev.den) ** 2)
    : null;

  const abs = delta === null ? 0 : Math.abs(delta);
  const historyOk = maxPriorMove !== null && prior.length >= 2 && abs > maxPriorMove;
  const noiseOk = kind !== 'rate' || (noise !== null && abs > noise);
  if (historyOk && noiseOk) {
    const dir = pointsText(kind === 'rate' ? delta * 100 : delta);
    let reason;
    if (kind === 'rate') {
      reason = `${pointsText(delta * 100)}. Noise is about ±${(noise * 100).toFixed(2)} points, and the largest move in the ${prior.length} weeks before was ${(maxPriorMove * 100).toFixed(2)} points.`;
    } else if (kind === 'money') {
      reason = `${countText(delta).replace(/[\d,]+/, (n) => `$${n}`)}. Directional: money values are not tested against sampling noise. The largest move in the ${prior.length} weeks before was ${Math.abs(maxPriorMove).toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}.`;
    } else {
      reason = `${countText(delta)}. The largest move in the ${prior.length} weeks before was ${Math.round(maxPriorMove).toLocaleString()}.`;
    }
    return { label: 'unusual', delta, noise, maxPriorMove, reason };
  }

  const wholeValues = [];
  for (let k = 0; k <= i; k += 1) if (daysOf(points[k]) === 7 && valueOf(points[k]) !== null) wholeValues.push(valueOf(points[k]));
  const lastMoves = moves.slice(-4);
  if (wholeValues.length && lastMoves.length >= 4) {
    const lowest = v1 === Math.min(...wholeValues);
    const highest = v1 === Math.max(...wholeValues);
    const downs = lastMoves.filter((m) => m < 0).length;
    const ups = lastMoves.filter((m) => m > 0).length;
    if (lowest && downs >= 3) {
      return { label: 'slide', delta, noise, maxPriorMove, reason: `${kind === 'rate' ? pointsText(delta * 100) : countText(delta)}, the lowest of these weeks, with ${downs} of the last ${lastMoves.length} moves down.` };
    }
    if (highest && ups >= 3) {
      return { label: 'climb', delta, noise, maxPriorMove, reason: `${kind === 'rate' ? pointsText(delta * 100) : countText(delta)}, the highest of these weeks, with ${ups} of the last ${lastMoves.length} moves up.` };
    }
  }

  let reason = 'Within the recent range.';
  if (kind === 'rate' && noise !== null && abs <= noise) reason = `${pointsText(delta * 100)}. Noise is about ±${(noise * 100).toFixed(2)} points.`;
  else if (maxPriorMove !== null && abs <= maxPriorMove) {
    const scale = kind === 'rate' ? 100 : 1;
    reason = `${kind === 'rate' ? pointsText(delta * 100) : countText(delta)}. The largest move in the ${prior.length} weeks before was ${(maxPriorMove * scale).toFixed(kind === 'rate' ? 2 : 0)} ${kind === 'rate' ? 'points' : ''}.`.trim();
  }
  return { label: 'normal', delta, noise, maxPriorMove, reason };
}
