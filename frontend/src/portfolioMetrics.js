// Full risk/return profile of one series, for the Calculadora's "Métricas completas" table.
// Annual figures (best/worst calendar year, CAGR) come from the calendar-year returns the blend is
// built on; everything finer (drawdown dates, weeks, VaR, Sortino, beta) comes from the weekly
// closes (Friday) of the same window, annualised with sqrt(52).

const WEEKS_PER_YEAR = 52;
const MIN_WEEKS = 26;

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function stdev(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1));
}

// years: ascending calendar years; annual: matching returns; weekly: [[date, wealthLevel]] ascending
// or null; refs: [{name, weekly}] with each reference's week-to-week returns on the SAME grid.
export function computeMetrics({ years, annual, weekly, refs }) {
  const m = {};

  if (annual.length) {
    let wealth = 1;
    annual.forEach((r) => (wealth *= 1 + r));
    m.totalReturn = wealth - 1;
    m.cagr = Math.pow(wealth, 1 / annual.length) - 1;
    let best = 0, worst = 0;
    annual.forEach((r, i) => {
      if (r > annual[best]) best = i;
      if (r < annual[worst]) worst = i;
    });
    m.bestYear = { year: years[best], value: annual[best] };
    m.worstYear = { year: years[worst], value: annual[worst] };
    m.positiveYears = annual.filter((r) => r > 0).length;
    m.totalYears = annual.length;
  }

  if (!weekly || weekly.length < MIN_WEEKS + 1) return m;

  const rets = [];
  for (let i = 1; i < weekly.length; i++) {
    const prev = weekly[i - 1][1];
    rets.push(prev ? weekly[i][1] / prev - 1 : 0);
  }
  m.weeks = rets.length;

  let bw = 0, ww = 0;
  rets.forEach((r, i) => {
    if (r > rets[bw]) bw = i;
    if (r < rets[ww]) ww = i;
  });
  m.bestWeek = { date: weekly[bw + 1][0], value: rets[bw] };
  m.worstWeek = { date: weekly[ww + 1][0], value: rets[ww] };
  m.positiveWeeks = rets.filter((r) => r > 0).length / rets.length;

  const sd = stdev(rets);
  m.volatility = sd === null ? null : sd * Math.sqrt(WEEKS_PER_YEAR);
  const sortedRets = [...rets].sort((a, b) => a - b);
  m.var95 = percentile(sortedRets, 0.05);
  const tail = sortedRets.filter((r) => r <= m.var95);
  m.cvar95 = mean(tail);
  const downside = Math.sqrt(mean(rets.map((r) => Math.min(r, 0) ** 2)));
  m.downsideDeviation = downside * Math.sqrt(WEEKS_PER_YEAR);

  // Drawdown walk: deepest fall (with its peak, trough and recovery dates) and the longest stretch
  // spent below a previous high.
  let peakIdx = 0, maxDD = 0, ddPeak = 0, ddTrough = 0;
  let longest = 0, longestStart = 0;
  for (let i = 0; i < weekly.length; i++) {
    if (weekly[i][1] >= weekly[peakIdx][1]) {
      const under = i - peakIdx;
      if (under > longest) { longest = under; longestStart = peakIdx; }
      peakIdx = i;
    }
    const dd = weekly[i][1] / weekly[peakIdx][1] - 1;
    if (dd < maxDD) { maxDD = dd; ddPeak = peakIdx; ddTrough = i; }
  }
  const lastUnder = weekly.length - 1 - peakIdx;
  if (lastUnder > longest) { longest = lastUnder; longestStart = peakIdx; }
  m.maxDrawdown = maxDD;
  m.currentDrawdown = weekly[weekly.length - 1][1] / weekly[peakIdx][1] - 1;
  if (maxDD < 0) {
    m.ddPeakDate = weekly[ddPeak][0];
    m.ddTroughDate = weekly[ddTrough][0];
    m.ddRecoveryDate = null;
    for (let i = ddTrough + 1; i < weekly.length; i++) {
      if (weekly[i][1] >= weekly[ddPeak][1]) { m.ddRecoveryDate = weekly[i][0]; break; }
    }
  }
  m.longestUnderwaterWeeks = longest;
  m.longestUnderwaterStart = weekly[longestStart][0];

  if (m.cagr !== undefined) {
    if (m.volatility) m.sharpe = m.cagr / m.volatility;
    if (m.downsideDeviation) m.sortino = m.cagr / m.downsideDeviation;
    if (maxDD < 0) m.calmar = m.cagr / Math.abs(maxDD);
  }

  m.rel = [];
  for (const ref of refs || []) {
    const bw = ref.weekly;
    if (!bw || bw.length !== rets.length) continue;
    const mb = mean(bw), mr = mean(rets);
    let cov = 0, vb = 0;
    for (let i = 0; i < rets.length; i++) {
      cov += (rets[i] - mr) * (bw[i] - mb);
      vb += (bw[i] - mb) ** 2;
    }
    const r = { name: ref.name, correlation: pearson(rets, bw) };
    if (vb) r.beta = cov / vb;
    const excess = rets.map((x, i) => x - bw[i]);
    const sdx = stdev(excess);
    if (sdx) {
      r.trackingError = sdx * Math.sqrt(WEEKS_PER_YEAR);
      r.informationRatio = (mean(excess) / sdx) * Math.sqrt(WEEKS_PER_YEAR);
    }
    const up = [], down = [];
    bw.forEach((x, i) => (x > 0 ? up : down).push(i));
    const ratio = (idx) => {
      const x = mean(idx.map((i) => bw[i]));
      return x ? mean(idx.map((i) => rets[i])) / x : null;
    };
    if (up.length) r.upCapture = ratio(up);
    if (down.length) r.downCapture = ratio(down);
    m.rel.push(r);
  }
  return m;
}

export function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  const mx = mean(xs.slice(0, n)), my = mean(ys.slice(0, n));
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    cov += (xs[i] - mx) * (ys[i] - my);
    vx += (xs[i] - mx) ** 2;
    vy += (ys[i] - my) ** 2;
  }
  return vx && vy ? cov / Math.sqrt(vx * vy) : null;
}
