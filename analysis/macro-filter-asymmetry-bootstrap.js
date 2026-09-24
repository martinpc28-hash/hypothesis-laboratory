#!/usr/bin/env node
// Robustness checks for the win/loss magnitude asymmetry in the XLE/XLK fixed macro filter
// (Seasonality Hypothesis Lab). The app's UI only quotes the RESULTS of this analysis (see the
// "¿Es real esa asimetría? Puesta a prueba" callout in
// frontend/src/tabs/SeasonalityTab.jsx, inside MacroFilteredStrategySection) — this script is
// what actually produces them, so the numbers there can be re-derived and audited instead of
// taken on faith.
//
// What it measures: each year, the macro-filtered strategy either beats the S&P 500 or it
// doesn't. The observation (first run 2026-09-24) was that WIN years beat it by a lot more than
// LOSS years lose by (~3x), which is most of why the compounded total return is so large despite
// only winning ~63% of years. Two independent checks on whether that's a real pattern or a
// small-sample artifact:
//
//   1. Bootstrap — resample the 27 actual (macro-filtered return, S&P 500 return) yearly pairs
//      WITH replacement, 20,000 times, and see how often the asymmetry direction and the total
//      compounded alpha survive. Tests estimation/sampling uncertainty given this exact
//      27-year sample; does NOT test whether those 27 years generalize to the future.
//   2. Subperiod split — cut the SAME 27 years into two contiguous, unmixed real halves
//      (2000-2012 vs 2013-2026, two very different market regimes) and check the asymmetry
//      holds in each separately. Tests regime-dependence, which the bootstrap can't.
//
// Usage:
//   node analysis/macro-filter-asymmetry-bootstrap.js [baseUrl] [seed]
//
//   baseUrl  API base to pull live data from (default: production EC2 instance)
//   seed     integer RNG seed for the bootstrap, for reproducibility (default: 20260924)
//
// Requires Node 18+ (uses global fetch). No dependencies.

const baseUrl = process.argv[2] || "http://3.227.208.53:8080";
const seed = Number(process.argv[3] || 20260924);
const N_BOOT = 20000;
const TICKERS = ["XLE", "XLK"];
const YEAR_FROM = 2000;
const YEAR_TO = 2026;
const SUBPERIOD_SPLIT_YEAR = 2013; // first year of the second half

function mulberry32(seedValue) {
  let seedState = seedValue | 0;
  return function () {
    seedState = (seedState + 0x6d2b79f5) | 0;
    let t = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sortedAsc, p) {
  const idx = Math.floor(p * (sortedAsc.length - 1));
  return sortedAsc[idx];
}
function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

async function fetchPairs() {
  const body = JSON.stringify({
    tickers: TICKERS,
    dataSource: "YAHOO_FINANCE",
    currencyMode: "USD",
    yearFrom: YEAR_FROM,
    yearTo: YEAR_TO,
    signalStartMonth: 1,
    signalLengthMonths: 2,
    minAssetsPerYear: 1,
  });
  const headers = { "Content-Type": "application/json" };

  const [macroRes, testRes] = await Promise.all([
    fetch(`${baseUrl}/api/seasonality/macro-insights`, { method: "POST", headers, body }),
    fetch(`${baseUrl}/api/seasonality/test`, { method: "POST", headers, body }),
  ]);
  if (!macroRes.ok || !testRes.ok) {
    throw new Error(`API error: macro-insights=${macroRes.status} test=${testRes.status}`);
  }
  const macro = await macroRes.json();
  const test = await testRes.json();

  const sp500ByYear = new Map(test.strategy.perYear.map((p) => [p.year, p.sp500Return]));
  const pairs = macro.macroFilteredStrategy.perYear
    .map((m) => ({ year: m.year, macroReturn: m.chosenReturn, spyReturn: sp500ByYear.get(m.year) }))
    .filter((r) => r.spyReturn !== undefined && r.spyReturn !== null)
    .sort((a, b) => a.year - b.year);

  if (!macro.assetSplit || macro.assetSplit.fixed !== true) {
    console.warn(
      "WARNING: assetSplit.fixed is not true for this combo — the analysis assumes the FIXED XLE/XLK rule, not a dynamically-refit split."
    );
  }
  return pairs;
}

function winLossStats(pairs) {
  const diffs = pairs.map((r) => r.macroReturn - r.spyReturn);
  const wins = diffs.filter((d) => d > 0);
  const losses = diffs.filter((d) => d <= 0);
  const avgWin = wins.length ? mean(wins) : null;
  const avgLoss = losses.length ? mean(losses) : null;
  const ratio = avgWin !== null && avgLoss ? Math.abs(avgWin / avgLoss) : null;
  return { n: pairs.length, winYears: wins.length, avgWin, avgLoss, ratio };
}

function compounded(pairs) {
  let macroProduct = 1;
  let spyProduct = 1;
  for (const r of pairs) {
    macroProduct *= 1 + r.macroReturn;
    spyProduct *= 1 + r.spyReturn;
  }
  const years = pairs.length;
  return {
    macroTotal: macroProduct - 1,
    spyTotal: spyProduct - 1,
    macroCagr: Math.pow(macroProduct, 1 / years) - 1,
    spyCagr: Math.pow(spyProduct, 1 / years) - 1,
    alphaTotal: macroProduct - spyProduct,
  };
}

function runBootstrap(pairs, bootSeed) {
  const rng = mulberry32(bootSeed);
  const n = pairs.length;
  const ratios = [];
  const totalAlphas = [];
  const winRates = [];
  let alphaPositiveCount = 0;
  let ratioAbove1Count = 0;
  let ratioUsableCount = 0;
  // Standalone totals (not just the macro-vs-SPY diff) — lets us check whether a wide CI is
  // something SPECIAL about the strategy, or just what n=13/14 resampled years does to ANY
  // buy-and-hold return, including the benchmark itself.
  const macroTotals = [];
  const spyTotals = [];

  for (let b = 0; b < N_BOOT; b++) {
    const sample = [];
    for (let i = 0; i < n; i++) sample.push(pairs[Math.floor(rng() * n)]);
    const { alphaTotal, macroTotal, spyTotal } = compounded(sample);
    totalAlphas.push(alphaTotal);
    macroTotals.push(macroTotal);
    spyTotals.push(spyTotal);
    if (alphaTotal > 0) alphaPositiveCount++;

    const { winYears, avgWin, avgLoss, ratio } = winLossStats(sample);
    winRates.push(winYears / n);
    if (ratio !== null) {
      ratioUsableCount++;
      ratios.push(ratio);
      if (ratio > 1) ratioAbove1Count++;
    }
  }

  ratios.sort((a, b) => a - b);
  totalAlphas.sort((a, b) => a - b);
  winRates.sort((a, b) => a - b);
  macroTotals.sort((a, b) => a - b);
  spyTotals.sort((a, b) => a - b);

  return {
    nBoot: N_BOOT,
    ratioUsableCount,
    ratioMean: mean(ratios),
    ratioMedian: percentile(ratios, 0.5),
    ratioCi95: [percentile(ratios, 0.025), percentile(ratios, 0.975)],
    ratioAbove1Pct: ratioAbove1Count / ratioUsableCount,
    alphaMean: mean(totalAlphas),
    alphaMedian: percentile(totalAlphas, 0.5),
    alphaCi95: [percentile(totalAlphas, 0.025), percentile(totalAlphas, 0.975)],
    alphaPositivePct: alphaPositiveCount / N_BOOT,
    winRateMean: mean(winRates),
    winRateCi95: [percentile(winRates, 0.025), percentile(winRates, 0.975)],
    macroTotalMedian: percentile(macroTotals, 0.5),
    macroTotalCi95: [percentile(macroTotals, 0.025), percentile(macroTotals, 0.975)],
    spyTotalMedian: percentile(spyTotals, 0.5),
    spyTotalCi95: [percentile(spyTotals, 0.025), percentile(spyTotals, 0.975)],
  };
}

function pct(x, digits = 1) {
  return x === null || x === undefined ? "—" : `${(x * 100).toFixed(digits)}%`;
}
function pp(x, digits = 1) {
  return x === null || x === undefined ? "—" : `${(x * 100).toFixed(digits)}pp`;
}

async function main() {
  console.log(`Fetching live data from ${baseUrl} (${TICKERS.join("/")}, ${YEAR_FROM}-${YEAR_TO})...`);
  const pairs = await fetchPairs();
  console.log(`Got ${pairs.length} years of data.\n`);

  const observed = winLossStats(pairs);
  const observedTotal = compounded(pairs);
  console.log("=== OBSERVED (full sample) ===");
  console.log(`Win years: ${observed.winYears}/${observed.n} (${pct(observed.winYears / observed.n, 0)})`);
  console.log(`Avg win: +${pp(observed.avgWin)}  Avg loss: ${pp(observed.avgLoss)}  Ratio: ${observed.ratio.toFixed(2)}x`);
  console.log(`Macro filter total: ${pct(observedTotal.macroTotal)}  S&P 500 total: ${pct(observedTotal.spyTotal)}`);
  console.log(`Total alpha (compounded): ${pp(observedTotal.alphaTotal)}\n`);

  console.log(`=== BOOTSTRAP (${N_BOOT} resamples, seed=${seed}) ===`);
  const boot = runBootstrap(pairs, seed);
  console.log(`Ratio: mean=${boot.ratioMean.toFixed(2)}x median=${boot.ratioMedian.toFixed(2)}x  95% CI: [${boot.ratioCi95[0].toFixed(2)}x, ${boot.ratioCi95[1].toFixed(2)}x]`);
  console.log(`% of resamples with ratio > 1x (wins bigger than losses): ${pct(boot.ratioAbove1Pct, 1)}`);
  console.log(`Total alpha: 95% CI: [${pp(boot.alphaCi95[0], 0)}, ${pp(boot.alphaCi95[1], 0)}]`);
  console.log(`% of resamples with total alpha > 0 (still beats S&P 500): ${pct(boot.alphaPositivePct, 1)}`);
  console.log(`Win rate: mean=${pct(boot.winRateMean)}  95% CI: [${pct(boot.winRateCi95[0])}, ${pct(boot.winRateCi95[1])}]`);
  console.log(`S&P 500 alone: median total return=${pct(boot.spyTotalMedian)}  95% CI: [${pct(boot.spyTotalCi95[0])}, ${pct(boot.spyTotalCi95[1])}]`);
  console.log(`Macro filter alone: median total return=${pct(boot.macroTotalMedian)}  95% CI: [${pct(boot.macroTotalCi95[0])}, ${pct(boot.macroTotalCi95[1])}]\n`);

  console.log(`=== SUBPERIOD SPLIT (unmixed, real chronological halves) ===`);
  const half1 = pairs.filter((r) => r.year < SUBPERIOD_SPLIT_YEAR);
  const half2 = pairs.filter((r) => r.year >= SUBPERIOD_SPLIT_YEAR);
  const halves = [
    [`${half1[0].year}-${half1[half1.length - 1].year}`, half1],
    [`${half2[0].year}-${half2[half2.length - 1].year}`, half2],
  ];
  for (const [label, half] of halves) {
    const s = winLossStats(half);
    const t = compounded(half);
    console.log(
      `${label} (n=${s.n}): win rate ${pct(s.winYears / s.n, 0)}, ratio ${s.ratio.toFixed(2)}x, ` +
        `macro filter ${pct(t.macroTotal)} vs S&P 500 ${pct(t.spyTotal)}, alpha ${pp(t.alphaTotal, 0)}`
    );
  }

  // Bootstrap EACH half on its own (resampling only within that half's n=13/14 years) — the
  // point estimates above (3.64x, 2.47x) carry a lot of uncertainty on their own with a sample
  // this small; this quantifies exactly how much, the same way the full-sample bootstrap does.
  console.log(`\n=== BOOTSTRAP WITHIN EACH SUBPERIOD (${N_BOOT} resamples each, seed=${seed}) ===`);
  let halfIdx = 0;
  for (const [label, half] of halves) {
    halfIdx++;
    const hb = runBootstrap(half, seed + halfIdx);
    console.log(`${label} (n=${half.length}):`);
    console.log(
      `  Ratio: mean=${hb.ratioMean.toFixed(2)}x median=${hb.ratioMedian.toFixed(2)}x  95% CI: [${hb.ratioCi95[0].toFixed(2)}x, ${hb.ratioCi95[1].toFixed(2)}x]  (usable in ${hb.ratioUsableCount}/${N_BOOT} resamples)`
    );
    console.log(`  % of resamples with ratio > 1x: ${pct(hb.ratioAbove1Pct, 1)}`);
    console.log(`  Total alpha: 95% CI: [${pp(hb.alphaCi95[0], 0)}, ${pp(hb.alphaCi95[1], 0)}]  % positive: ${pct(hb.alphaPositivePct, 1)}`);
    console.log(`  Win rate: mean=${pct(hb.winRateMean)}  95% CI: [${pct(hb.winRateCi95[0])}, ${pct(hb.winRateCi95[1])}]`);
    console.log(`  S&P 500 alone: median=${pct(hb.spyTotalMedian)}  95% CI: [${pct(hb.spyTotalCi95[0])}, ${pct(hb.spyTotalCi95[1])}]`);
    console.log(`  Macro filter alone: median=${pct(hb.macroTotalMedian)}  95% CI: [${pct(hb.macroTotalCi95[0])}, ${pct(hb.macroTotalCi95[1])}]`);
  }

  console.log();
  console.log(
    "Caveat: all of these checks are bounded by the SAME 27 real years — the full-sample bootstrap\n" +
      "tests sampling uncertainty within them, the split tests regime-dependence within them, and the\n" +
      "per-half bootstrap tests sampling uncertainty within each half on its own (n=13/14, so its CIs\n" +
      "are necessarily much wider than the full-sample one). None of them can test genuine out-of-sample\n" +
      "risk, since 2000-2026 is the full trading history for these ETFs."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
