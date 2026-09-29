import { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { ui, colors } from "../theme.js";
import LineChart from "../LineChart.jsx";

const CURRENT_YEAR = new Date().getFullYear();

function pct(v, digits = 1) {
  return v === null || v === undefined || Number.isNaN(v) ? "—" : `${(v * 100).toFixed(digits)}%`;
}

// Every strategy tab already exposes a year-end CUMULATIVE return series (the same shape used for
// their own charts). This derives each year's own isolated return from two consecutive cumulative
// points — the same technique VixTimingTab uses for its "en dinero" per-year table — so the
// calculator can blend strategies without needing a new backend endpoint: it just re-reads
// whatever the other three tabs already computed.
function yearlyReturnMap(cumulative, key) {
  const map = new Map();
  let prev = 0;
  for (const c of cumulative || []) {
    const cur = c[key];
    if (cur === undefined || cur === null) continue;
    map.set(c.year, (1 + cur) / (1 + prev) - 1);
    prev = cur;
  }
  return map;
}

// Converts a leg's own (native-currency) ANNUAL returns to the other currency using year-end
// EUR/USD rates — the same "ret_other = (fx_prev/fx_cur) * (1+ret_native) - 1" formula already
// used server-side (VixTimingService.fxAdjust, CreditRotationService), just applied once a year
// instead of once a day since this calculator never has daily granularity to begin with. Only
// used for Seasonality/VIX Timing, which only ever run in ONE currency at a time — Credit
// Rotation already returns real, independently-computed USD AND EUR series and never needs this.
function fxConvert(nativeReturns, nativeCurrency, fxByYear) {
  const out = new Map();
  for (const [year, r] of nativeReturns) {
    const fxCur = fxByYear.get(year);
    const fxPrev = fxByYear.get(year - 1);
    if (fxCur === undefined || fxPrev === undefined) continue;
    const converted = nativeCurrency === "USD" ? (fxPrev / fxCur) * (1 + r) - 1 : (fxCur / fxPrev) * (1 + r) - 1;
    out.set(year, converted);
  }
  return out;
}

// Stats from a plain array of ANNUAL returns (not daily) — CAGR/vol/drawdown computed directly
// from the yearly series, not annualized with a √252 factor like every other tab in this project
// (those work from daily returns; this only has what the source tabs expose, one point per year).
// This is a real, disclosed limitation: a "max drawdown" computed only from year-END values can
// miss a sharp intra-year drop that recovered by December, and volatility of 27 yearly numbers is
// a much noisier estimate than volatility of ~6,700 daily ones.
function statsFromYearlyReturns(returnsInOrder) {
  let wealth = 1, peak = 1, maxDD = 0;
  for (const r of returnsInOrder) {
    wealth *= 1 + r;
    peak = Math.max(peak, wealth);
    maxDD = Math.min(maxDD, (wealth - peak) / peak);
  }
  const n = returnsInOrder.length;
  const totalReturn = wealth - 1;
  const cagr = n > 0 ? Math.pow(wealth, 1 / n) - 1 : 0;
  const mean = n ? returnsInOrder.reduce((a, b) => a + b, 0) / n : 0;
  const variance = n > 1 ? returnsInOrder.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / (n - 1) : 0;
  const vol = Math.sqrt(variance);
  return { totalReturn, cagr, volatility: vol, maxDrawdown: maxDD };
}

// Picks the real (daily-based) stats for one currency's leg row when the combined window doesn't
// clip it down further than what it was originally computed over — a real stat for a DIFFERENT
// (wider) period than what's actually being blended would be misleading. Falls back to the
// annual-return approximation otherwise (always the case for the FX-converted currency, since
// there's no backend daily series to fall back on there).
function pickLegStats(returns, realStats, sortedYears) {
  const legYears = [...returns.keys()];
  const notClipped =
    realStats && legYears.length === sortedYears.length && Math.min(...legYears) === sortedYears[0] &&
    Math.max(...legYears) === sortedYears[sortedYears.length - 1];
  const legReturns = sortedYears.map((y) => returns.get(y) ?? 0);
  return { stats: notClipped ? realStats : statsFromYearlyReturns(legReturns), isReal: !!notClipped };
}

// Wraps a return map that only exists in ONE currency into a {returnsUsd, returnsEur} pair,
// FX-converting whichever side isn't native — shared by legs (Seasonality, VIX Timing) and by the
// S&P 500 / MSCI World benchmark overlays, which have the exact same "only ever computed in one
// currency" limitation.
function toDualCurrency(nativeReturns, nativeCurrency, fxByYear) {
  const converted = fxConvert(nativeReturns, nativeCurrency, fxByYear);
  return {
    returnsUsd: nativeCurrency === "USD" ? nativeReturns : converted,
    returnsEur: nativeCurrency === "EUR" ? nativeReturns : converted,
  };
}

// Pearson correlation between two equal-length annual-return arrays.
function correlation(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  return vx === 0 || vy === 0 ? null : cov / Math.sqrt(vx * vy);
}

// Information ratio = mean(excess return over benchmark) / stdev(excess return) — both computed
// from the same ANNUAL return series as everything else in this calculator (see
// statsFromYearlyReturns' own disclosed limitation), so this is a real number but a noisier
// estimate than an information ratio built from daily active returns would be.
function informationRatio(portfolioReturns, benchmarkReturns) {
  const n = portfolioReturns.length;
  if (n < 2) return null;
  const excess = portfolioReturns.map((r, i) => r - benchmarkReturns[i]);
  const mean = excess.reduce((a, b) => a + b, 0) / n;
  const variance = excess.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / (n - 1);
  const trackingError = Math.sqrt(variance);
  return trackingError === 0 ? null : mean / trackingError;
}

const LEG_COLORS = [colors.primary, colors.warning, colors.success, colors.danger];
const BENCHMARK_COLORS = [colors.warning, "#a78bfa"];

// ---- Weekly-resolution chart data --------------------------------------------------------------
// Everything above (weights, annual rebalancing, CAGR/vol/drawdown, the whole "Riesgo y retorno"
// table) stays exactly as before — purely annual, the authoritative numbers. Everything below is
// ADDITIONAL, chart-only: each source tab now also exposes a `weekly` wealth curve (Friday closes),
// so the two LineCharts can show real week-to-week movement instead of a near-straight line
// between a couple dozen year-end dots. It never changes a single number in the tables.

// [date, wealthSinceThatSeriesOwnInception] pairs, ascending (backend already emits them in order).
function weeklyWealthEntries(weekly, key) {
  const entries = [];
  for (const p of weekly || []) {
    const v = p[key];
    if (v === undefined || v === null) continue;
    entries.push([p.date, 1 + v]);
  }
  return entries;
}

// Last entry with date <= asOf ("floorEntry", same technique the backend uses for cross-calendar
// series like the EUR fund NAVs) — binary search since entries are sorted ascending by date.
function floorLookup(entries, asOf) {
  let lo = 0, hi = entries.length - 1, res = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid][0] <= asOf) { res = entries[mid][1]; lo = mid + 1; } else hi = mid - 1;
  }
  return res;
}

// A leg's weekly curve only exists in its NATIVE currency. To show it on the OTHER currency's
// chart, each calendar year is rescaled by a single constant factor so that year's END lands
// exactly on the same number the authoritative annual FX conversion already produces (see
// fxConvert) — every week WITHIN that year keeps the native asset's real relative movement, just
// uniformly stretched/compressed by that year's factor. This is the honest limit of what's
// possible with only YEAR-END FX rates available (see /api/fx/eur-usd-year-end) — not a claim
// that the within-year FX path itself is accurate, only that the underlying asset's movement is.
function convertWeeklyEntries(nativeEntries, nativeCurrency, fxByYear) {
  if (nativeEntries.length === 0) return [];
  const byYear = new Map();
  for (const e of nativeEntries) {
    const year = Number(e[0].slice(0, 4));
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(e);
  }
  const years = [...byYear.keys()].sort((a, b) => a - b);
  const out = [];
  let convertedYearStartWealth = 1;
  let nativeYearStartWealth = nativeEntries[0][1];
  for (const year of years) {
    const yearEntries = byYear.get(year);
    const nativeYearEndWealth = yearEntries[yearEntries.length - 1][1];
    const nativeYearMultiple = nativeYearStartWealth ? nativeYearEndWealth / nativeYearStartWealth : 1;
    const fxCur = fxByYear.get(year), fxPrev = fxByYear.get(year - 1);
    const targetYearMultiple =
      fxCur !== undefined && fxPrev !== undefined
        ? (nativeCurrency === "USD" ? (fxPrev / fxCur) : (fxCur / fxPrev)) * nativeYearMultiple
        : nativeYearMultiple; // no FX data that far back — better to fall back unconverted than drop the year
    const scale = nativeYearMultiple === 0 ? 1 : targetYearMultiple / nativeYearMultiple;
    for (const [date, wealth] of yearEntries) {
      out.push([date, convertedYearStartWealth * (wealth / nativeYearStartWealth) * scale]);
    }
    convertedYearStartWealth *= targetYearMultiple;
    nativeYearStartWealth = nativeYearEndWealth;
  }
  return out;
}

// Clips a [date, wealth] series to (windowStartYear-1's Dec 31, windowEndYear's Dec 31] and rebases
// it so its value right at the window start is 1 — same convention the annual blend uses (a leg
// with more history than the common window starts the chart at 0%, not at its own all-time total).
function restrictAndRebase(entries, sortedYears) {
  const startBoundary = `${sortedYears[0] - 1}-12-31`;
  const endBoundary = `${sortedYears[sortedYears.length - 1]}-12-31`;
  const base = floorLookup(entries, startBoundary) ?? (entries.length ? entries[0][1] : 1);
  if (!base) return [];
  return entries.filter(([d]) => d > startBoundary && d <= endBoundary).map(([d, w]) => [d, w / base]);
}

// Blends already same-currency, already-rebased leg entries onto one shared weekly grid, with the
// SAME annual rebalancing the stats table's blend uses — each leg's own line stays un-rebalanced
// (matches what that leg's own tab would show), only the "Cartera combinada" line rebalances.
function blendWeeklyGrid(legEntries, grid, normalizedWeights) {
  if (grid.length === 0) return [];
  const shareWealth = [...normalizedWeights];
  const legWealth = normalizedWeights.map(() => 1);
  let lastLevel = legEntries.map((e) => floorLookup(e, grid[0]) ?? 1);
  let lastYear = Number(grid[0].slice(0, 4));
  const points = [];
  for (let i = 0; i < grid.length; i++) {
    const date = grid[i];
    const year = Number(date.slice(0, 4));
    if (i > 0) {
      legEntries.forEach((entries, li) => {
        const level = floorLookup(entries, date) ?? lastLevel[li];
        const stepReturn = lastLevel[li] ? level / lastLevel[li] - 1 : 0;
        shareWealth[li] *= 1 + stepReturn;
        legWealth[li] *= 1 + stepReturn;
        lastLevel[li] = level;
      });
    }
    if (year !== lastYear) {
      const total = shareWealth.reduce((a, b) => a + b, 0);
      normalizedWeights.forEach((wt, li) => {
        shareWealth[li] = total * wt;
      });
      lastYear = year;
    }
    const point = { date };
    legWealth.forEach((w, li) => {
      point[`cumulativeLeg${li}`] = w - 1;
    });
    point.cumulativePortfolio = shareWealth.reduce((a, b) => a + b, 0) - 1;
    points.push(point);
  }
  return points;
}

// A pure-reference series (S&P 500, MSCI World) has no weight to rebalance — just its own
// compounded wealth across the grid.
function benchmarkWeeklyPoints(entries, grid, key) {
  let lastLevel = floorLookup(entries, grid[0]) ?? 1;
  let wealth = 1;
  const out = [];
  for (let i = 0; i < grid.length; i++) {
    const date = grid[i];
    if (i > 0) {
      const level = floorLookup(entries, date) ?? lastLevel;
      wealth *= lastLevel ? level / lastLevel : 1;
      lastLevel = level;
    }
    out.push({ date, [key]: wealth - 1 });
  }
  return out;
}

// Ties the pieces above together: restricts+rebases every leg's and benchmark's weekly entries
// (already resolved to ONE currency by the caller) to the common window, builds the shared date
// grid, blends the legs with annual rebalancing, and lays the benchmark curves on top. Returns
// null (not an empty array) when nothing has weekly data at all, so the caller can fall back to
// the annual `points` instead of rendering an empty chart.
function buildWeeklyChart(normalized, benchmarks, sortedYears, entriesKey) {
  const legEntries = normalized.map((l) => restrictAndRebase(l[entriesKey] || [], sortedYears));
  const benchEntries = benchmarks.map((b) => restrictAndRebase(b[entriesKey] || [], sortedYears));
  const allDates = new Set();
  legEntries.forEach((e) => e.forEach(([d]) => allDates.add(d)));
  benchEntries.forEach((e) => e.forEach(([d]) => allDates.add(d)));
  if (allDates.size === 0) return null;
  const grid = [...allDates].sort();
  const points = blendWeeklyGrid(
    legEntries,
    grid,
    normalized.map((l) => l.normWeight)
  );
  benchEntries.forEach((entries, bi) => {
    const key = `cumulativeBenchmark${bi}`;
    const bp = benchmarkWeeklyPoints(entries, grid, key);
    bp.forEach((p, i) => {
      points[i][key] = p[key];
    });
  });
  return points;
}

export default function PortfolioCalculatorTab({
  seasonalityTestResult,
  seasonalityMacroResult,
  vixTimingResult,
  creditRotationResult,
}) {
  const seasonalityAvailable = !!seasonalityTestResult?.strategy?.cumulative;
  const seasonalityMacroAvailable = !!seasonalityMacroResult?.macroFilteredStrategy?.cumulative;
  const vixAvailable = !!vixTimingResult?.cumulative;
  const creditAvailable = !!creditRotationResult?.cumulative;

  const [seasonalityIncluded, setSeasonalityIncluded] = useState(true);
  const [seasonalityWeight, setSeasonalityWeight] = useState(34);
  const [seasonalityVariant, setSeasonalityVariant] = useState("MACRO");

  const [vixIncluded, setVixIncluded] = useState(true);
  const [vixWeight, setVixWeight] = useState(33);

  const [creditIncluded, setCreditIncluded] = useState(true);
  const [creditWeight, setCreditWeight] = useState(33);

  const [yearFrom, setYearFrom] = useState("");
  const [yearTo, setYearTo] = useState("");
  const [error, setError] = useState(null);
  const [calc, setCalc] = useState(null);

  // Year-end USD-per-EUR rates, fetched once (covers the whole app's usable range) — used to
  // convert whichever currency a Seasonality/VIX Timing leg was run in into the other one, so the
  // calculator can always show BOTH regardless of which strategy/variant is picked. Credit
  // Rotation never needs this: it already returns real, independent USD and EUR series.
  const [fxRates, setFxRates] = useState(null);
  const [fxError, setFxError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.getEurUsdYearEnd(1999, CURRENT_YEAR);
        setFxRates(new Map(res.rates.map((r) => [r.year, r.usdPerEur])));
      } catch (e) {
        setFxError(`No se pudo cargar el tipo de cambio EUR/USD: ${e.message}`);
      }
    })();
  }, []);

  const totalEnteredWeight =
    (seasonalityIncluded ? Number(seasonalityWeight) || 0 : 0) +
    (vixIncluded ? Number(vixWeight) || 0 : 0) +
    (creditIncluded ? Number(creditWeight) || 0 : 0);

  // Wraps a USD/EUR pair of return maps + real stats into one leg entry — shared by both
  // single-currency sources (Seasonality, VIX Timing) after FX-converting the missing side. Also
  // resolves the weekly chart-only entries into both currencies the same way (see
  // convertWeeklyEntries) so the chart never has to know which side was native.
  function makeDualCurrencyLeg({ name, weight, nativeCurrency, nativeReturns, realStatsNative, weeklyNativeEntries }) {
    const { returnsUsd, returnsEur } = toDualCurrency(nativeReturns, nativeCurrency, fxRates);
    const convertedWeekly = convertWeeklyEntries(weeklyNativeEntries, nativeCurrency, fxRates);
    return {
      name,
      weight,
      returnsUsd,
      returnsEur,
      realStatsUsd: nativeCurrency === "USD" ? realStatsNative : null,
      realStatsEur: nativeCurrency === "EUR" ? realStatsNative : null,
      fxConvertedCurrency: nativeCurrency === "USD" ? "EUR" : "USD",
      weeklyUsdEntries: nativeCurrency === "USD" ? weeklyNativeEntries : convertedWeekly,
      weeklyEurEntries: nativeCurrency === "EUR" ? weeklyNativeEntries : convertedWeekly,
    };
  }

  // S&P 500 / MSCI World as REFERENCE overlays on the chart + what the metrics table compares the
  // combined portfolio against — never part of the weighted blend itself. Prefers whichever
  // included leg already has the benchmark in BOTH real currencies (Credit Rotation) over one that
  // needs FX-converting (Seasonality, VIX Timing), so the comparison is as real as possible.
  function buildBenchmarks() {
    const benchmarks = [];

    if (creditIncluded && creditAvailable && creditRotationResult.spyAvailable) {
      benchmarks.push({
        name: "S&P 500",
        returnsUsd: yearlyReturnMap(creditRotationResult.cumulative, "cumulativeSp500Usd"),
        returnsEur: yearlyReturnMap(creditRotationResult.cumulative, "cumulativeSp500Eur"),
        weeklyUsdEntries: weeklyWealthEntries(creditRotationResult.weekly, "cumulativeSp500Usd"),
        weeklyEurEntries: weeklyWealthEntries(creditRotationResult.weekly, "cumulativeSp500Eur"),
      });
    } else if (seasonalityIncluded && seasonalityAvailable && seasonalityTestResult.strategy.sp500Available) {
      const nativeCurrency = seasonalityTestResult?.meta?.currency || "USD";
      const weeklyNative = weeklyWealthEntries(seasonalityTestResult.strategy.weeklySp500, "cumulativeSp500");
      const weeklyConverted = convertWeeklyEntries(weeklyNative, nativeCurrency, fxRates);
      benchmarks.push({
        name: "S&P 500",
        ...toDualCurrency(yearlyReturnMap(seasonalityTestResult.strategy.cumulative, "cumulativeSp500"), nativeCurrency, fxRates),
        weeklyUsdEntries: nativeCurrency === "USD" ? weeklyNative : weeklyConverted,
        weeklyEurEntries: nativeCurrency === "EUR" ? weeklyNative : weeklyConverted,
      });
    } else if (vixIncluded && vixAvailable) {
      const nativeCurrency = vixTimingResult?.meta?.currency || "USD";
      const weeklyNative = weeklyWealthEntries(vixTimingResult.weekly, "cumulativeSp500");
      const weeklyConverted = convertWeeklyEntries(weeklyNative, nativeCurrency, fxRates);
      benchmarks.push({
        name: "S&P 500",
        ...toDualCurrency(yearlyReturnMap(vixTimingResult.cumulative, "cumulativeSp500"), nativeCurrency, fxRates),
        weeklyUsdEntries: nativeCurrency === "USD" ? weeklyNative : weeklyConverted,
        weeklyEurEntries: nativeCurrency === "EUR" ? weeklyNative : weeklyConverted,
      });
    }

    if (seasonalityIncluded && seasonalityAvailable && seasonalityTestResult.strategy.msciWorldAvailable) {
      const nativeCurrency = seasonalityTestResult?.meta?.currency || "USD";
      const weeklyNative = weeklyWealthEntries(seasonalityTestResult.strategy.weeklyMsciWorld, "cumulativeMsciWorld");
      const weeklyConverted = convertWeeklyEntries(weeklyNative, nativeCurrency, fxRates);
      benchmarks.push({
        name: "MSCI World",
        ...toDualCurrency(yearlyReturnMap(seasonalityTestResult.strategy.cumulative, "cumulativeMsciWorld"), nativeCurrency, fxRates),
        weeklyUsdEntries: nativeCurrency === "USD" ? weeklyNative : weeklyConverted,
        weeklyEurEntries: nativeCurrency === "EUR" ? weeklyNative : weeklyConverted,
      });
    }

    return benchmarks;
  }

  function buildLegs() {
    const legs = [];
    if (seasonalityIncluded && seasonalityAvailable) {
      const useMacro = seasonalityVariant === "MACRO" && seasonalityMacroAvailable;
      const cumulative = useMacro
        ? seasonalityMacroResult.macroFilteredStrategy.cumulative
        : seasonalityTestResult.strategy.cumulative;
      const key = useMacro ? "cumulativeMacroFiltered" : "cumulativeStrategy";
      const tickers = seasonalityTestResult?.meta?.tickers?.join("+") || "Seasonality";
      const realStats = useMacro ? seasonalityMacroResult.macroFilteredStrategy.stats : seasonalityTestResult.strategy.stats.strategy;
      const useMacroKeyWeekly = useMacro ? "cumulativeMacroFiltered" : "cumulativeStrategy";
      const weeklySource = useMacro ? seasonalityMacroResult.macroFilteredStrategy.weekly : seasonalityTestResult.strategy.weekly;
      legs.push(
        makeDualCurrencyLeg({
          name: `Seasonality ${tickers} (${useMacro ? "con filtro macro" : "top quartile"})`,
          weight: Number(seasonalityWeight) || 0,
          nativeCurrency: seasonalityTestResult?.meta?.currency || "USD",
          nativeReturns: yearlyReturnMap(cumulative, key),
          realStatsNative: realStats,
          weeklyNativeEntries: weeklyWealthEntries(weeklySource, useMacroKeyWeekly),
        })
      );
    }
    if (vixIncluded && vixAvailable) {
      const nativeCurrency = vixTimingResult?.meta?.currency || "USD";
      legs.push(
        makeDualCurrencyLeg({
          name: `VIX Timing (corrida en ${nativeCurrency})`,
          weight: Number(vixWeight) || 0,
          nativeCurrency,
          nativeReturns: yearlyReturnMap(vixTimingResult.cumulative, "cumulativeStrategy"),
          realStatsNative: vixTimingResult.stats?.strategy,
          weeklyNativeEntries: weeklyWealthEntries(vixTimingResult.weekly, "cumulativeStrategy"),
        })
      );
    }
    if (creditIncluded && creditAvailable) {
      legs.push({
        name: "Credit Rotation",
        weight: Number(creditWeight) || 0,
        returnsUsd: yearlyReturnMap(creditRotationResult.cumulative, "cumulativeStrategyUsd"),
        returnsEur: yearlyReturnMap(creditRotationResult.cumulative, "cumulativeStrategyEur"),
        realStatsUsd: creditRotationResult.stats?.usd?.strategy,
        realStatsEur: creditRotationResult.stats?.eur?.strategy,
        fxConvertedCurrency: null, // both sides are real for this one — never FX-converted
        weeklyUsdEntries: weeklyWealthEntries(creditRotationResult.weekly, "cumulativeStrategyUsd"),
        weeklyEurEntries: weeklyWealthEntries(creditRotationResult.weekly, "cumulativeStrategyEur"),
      });
    }
    return legs;
  }

  // Blends one currency's worth of legs (returnsKey/statsKey picks which side of each leg to use)
  // into a portfolio cumulative series + per-leg/portfolio stats — run twice (USD, EUR) with the
  // SAME weights and SAME year window, so the two results are directly comparable.
  function blendCurrency(normalized, sortedYears, returnsKey, statsKey) {
    const legWealths = normalized.map(() => 1);
    const blendedReturns = [];
    const points = [];
    for (const y of sortedYears) {
      let blended = 0;
      normalized.forEach((l) => {
        blended += l.normWeight * (l[returnsKey].get(y) ?? 0);
      });
      blendedReturns.push(blended);
      const point = { year: y };
      normalized.forEach((l, i) => {
        legWealths[i] *= 1 + (l[returnsKey].get(y) ?? 0);
        point[`cumulativeLeg${i}`] = legWealths[i] - 1;
      });
      points.push(point);
    }
    let portfolioWealth = 1;
    blendedReturns.forEach((r, i) => {
      portfolioWealth *= 1 + r;
      points[i].cumulativePortfolio = portfolioWealth - 1;
    });

    const portfolioStats = statsFromYearlyReturns(blendedReturns);
    const legStats = normalized.map((l) => {
      const { stats, isReal } = pickLegStats(l[returnsKey], l[statsKey], sortedYears);
      return { name: l.name, weight: l.normWeight, stats, isReal };
    });
    return { points, portfolioStats, legStats, blendedReturns };
  }

  // Adds each benchmark's own cumulative curve to an already-blended currency's `points` (rebased
  // to 1.0 at the start of the common window, same convention the legs' own curves use), and
  // returns per-benchmark correlation/information-ratio/own-stats against the portfolio's blended
  // annual returns — only over the years where BOTH the portfolio and that benchmark have data.
  function addBenchmarks(benchmarks, points, sortedYears, blendedReturns, returnsKey) {
    const byYear = new Map(points.map((p) => [p.year, p]));
    return benchmarks.map((b, bi) => {
      let wealth = 1;
      const pr = [], br = [];
      sortedYears.forEach((y, i) => {
        const r = b[returnsKey].get(y);
        if (r === undefined) return;
        wealth *= 1 + r;
        byYear.get(y)[`cumulativeBenchmark${bi}`] = wealth - 1;
        pr.push(blendedReturns[i]);
        br.push(r);
      });
      const benchStats = statsFromYearlyReturns(br);
      return {
        name: b.name,
        n: pr.length,
        correlation: correlation(pr, br),
        informationRatio: informationRatio(pr, br),
        stats: benchStats,
      };
    });
  }

  function calculate() {
    setError(null);
    setCalc(null);
    if (!fxRates) {
      setError(fxError || "Cargando el tipo de cambio EUR/USD — probá de nuevo en un segundo.");
      return;
    }
    const legs = buildLegs();
    if (legs.length === 0) {
      setError("Elegí al menos una estrategia (y corré esa pestaña primero si todavía no tiene resultado).");
      return;
    }
    const totalWeight = legs.reduce((a, l) => a + l.weight, 0);
    if (totalWeight <= 0) {
      setError("Los pesos de las estrategias incluidas suman 0% — poné al menos un peso mayor a 0.");
      return;
    }
    const normalized = legs.map((l) => ({ ...l, normWeight: l.weight / totalWeight }));

    // USD and EUR maps should cover the same years (FX data spans the app's full range), but
    // intersect independently per currency just in case, then intersect those two — belt and
    // braces so a gap in either currency's data can't silently misalign the two blends.
    function commonYears(returnsKey) {
      let years = null;
      for (const l of normalized) {
        const legYears = new Set(l[returnsKey].keys());
        years = years === null ? legYears : new Set([...years].filter((y) => legYears.has(y)));
      }
      return years || new Set();
    }
    const usdYears = commonYears("returnsUsd");
    const eurYears = commonYears("returnsEur");
    let sortedYears = [...usdYears].filter((y) => eurYears.has(y)).sort((a, b) => a - b);
    if (yearFrom !== "") sortedYears = sortedYears.filter((y) => y >= Number(yearFrom));
    if (yearTo !== "") sortedYears = sortedYears.filter((y) => y <= Number(yearTo));
    if (sortedYears.length === 0) {
      setError("No hay años en común entre las estrategias elegidas (y el rango de años) — probá un rango más amplio.");
      return;
    }

    const usd = blendCurrency(normalized, sortedYears, "returnsUsd", "realStatsUsd");
    const eur = blendCurrency(normalized, sortedYears, "returnsEur", "realStatsEur");

    const benchmarks = buildBenchmarks();
    const benchmarkMetricsUsd = addBenchmarks(benchmarks, usd.points, sortedYears, usd.blendedReturns, "returnsUsd");
    const benchmarkMetricsEur = addBenchmarks(benchmarks, eur.points, sortedYears, eur.blendedReturns, "returnsEur");

    // Weekly-resolution chart data — see the "Weekly-resolution chart data" block above. Purely
    // additional: falls back to the annual `points` above (already computed, unaffected) if a leg
    // is missing `weekly` data for some reason (e.g. a stale cached tab result).
    usd.weeklyPoints = buildWeeklyChart(normalized, benchmarks, sortedYears, "weeklyUsdEntries");
    eur.weeklyPoints = buildWeeklyChart(normalized, benchmarks, sortedYears, "weeklyEurEntries");

    setCalc({
      years: sortedYears,
      usd,
      eur,
      legNames: normalized.map((l) => l.name),
      fxConvertedNames: normalized.filter((l) => l.fxConvertedCurrency).map((l) => l.name),
      benchmarkNames: benchmarks.map((b) => b.name),
      benchmarkMetricsUsd,
      benchmarkMetricsEur,
      sharpeUsd: usd.portfolioStats.volatility ? usd.portfolioStats.cagr / usd.portfolioStats.volatility : null,
      sharpeEur: eur.portfolioStats.volatility ? eur.portfolioStats.cagr / eur.portfolioStats.volatility : null,
    });
  }

  // Same keys/labels/colors describe both charts — only the underlying `points` (calc.usd.points
  // vs. calc.eur.points, passed separately to each LineChart) differ between the USD and EUR view.
  const series = useMemo(() => {
    if (!calc) return [];
    const s = [{ key: "cumulativePortfolio", label: "Cartera combinada", color: colors.text }];
    calc.legNames.forEach((name, i) => {
      s.push({ key: `cumulativeLeg${i}`, label: name, color: LEG_COLORS[i % LEG_COLORS.length] });
    });
    calc.benchmarkNames.forEach((name, i) => {
      s.push({ key: `cumulativeBenchmark${i}`, label: `${name} (referencia)`, color: BENCHMARK_COLORS[i % BENCHMARK_COLORS.length] });
    });
    return s;
  }, [calc]);

  return (
    <div>
      <div style={ui.card}>
        <h2 style={ui.cardTitle}>Calculadora de cartera combinada</h2>
        <p style={ui.cardSubtitle}>
          Combina los resultados YA corridos en Seasonality, VIX Timing y Credit Rotation con el % que le asignes a
          cada uno, y calcula qué rentabilidad hubiera dado la mezcla en el período en común — siempre en USD Y en
          EUR por separado, sea cual sea la estrategia elegida. Corré esas 3 pestañas primero — esta calculadora no
          vuelve a pedir datos, solo mezcla lo que ya calculaste ahí. El rebalanceo es anual (a fin de cada año se
          vuelve a los % originales), y la volatilidad/drawdown de la mezcla se calculan sobre retornos ANUALES (no
          diarios, como en las otras pestañas) — con menos puntos, son estimaciones más ruidosas, y un drawdown solo
          de fin de año puede no capturar una caída fuerte que se recuperó antes de diciembre.
        </p>
        <p style={ui.cardSubtitle}>
          Credit Rotation ya tiene fondos reales independientes en USD y en EUR (sin conversión). Seasonality y VIX
          Timing solo corren en UNA moneda a la vez (la que elegiste en su propia pestaña) — acá esa moneda se toma
          como la real, y la otra se estima aplicando el tipo de cambio EUR/USD de fin de año a su retorno anual
          (misma fórmula que ya usa VIX Timing internamente para su propio modo EUR, aplicada una vez al año en vez
          de una vez al día).
        </p>

        <div style={ui.tableScroll}>
          <table style={ui.table}>
            <thead>
              <tr>
                <th style={ui.th}></th>
                <th style={ui.th}>Estrategia</th>
                <th style={ui.th}>Variante</th>
                <th style={ui.th}>Peso (%)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={ui.td}>
                  <input
                    type="checkbox"
                    checked={seasonalityIncluded}
                    disabled={!seasonalityAvailable}
                    onChange={(e) => setSeasonalityIncluded(e.target.checked)}
                  />
                </td>
                <td style={ui.td}>
                  Seasonality
                  {!seasonalityAvailable && <div style={ui.muted}>Corré Seasonality primero</div>}
                </td>
                <td style={ui.td}>
                  {seasonalityAvailable && (
                    <select
                      style={ui.input}
                      value={seasonalityVariant}
                      onChange={(e) => setSeasonalityVariant(e.target.value)}
                      disabled={!seasonalityIncluded}
                    >
                      {seasonalityMacroAvailable && <option value="MACRO">Con filtro macro</option>}
                      <option value="TOP_QUARTILE">Top quartile (solo señal)</option>
                    </select>
                  )}
                </td>
                <td style={ui.td}>
                  <input
                    style={{ ...ui.input, width: 80 }}
                    type="number"
                    value={seasonalityWeight}
                    disabled={!seasonalityIncluded || !seasonalityAvailable}
                    onChange={(e) => setSeasonalityWeight(e.target.value)}
                  />
                </td>
              </tr>
              <tr>
                <td style={ui.td}>
                  <input
                    type="checkbox"
                    checked={vixIncluded}
                    disabled={!vixAvailable}
                    onChange={(e) => setVixIncluded(e.target.checked)}
                  />
                </td>
                <td style={ui.td}>
                  VIX Timing
                  {!vixAvailable && <div style={ui.muted}>Corré VIX Timing primero</div>}
                </td>
                <td style={ui.td}>—</td>
                <td style={ui.td}>
                  <input
                    style={{ ...ui.input, width: 80 }}
                    type="number"
                    value={vixWeight}
                    disabled={!vixIncluded || !vixAvailable}
                    onChange={(e) => setVixWeight(e.target.value)}
                  />
                </td>
              </tr>
              <tr>
                <td style={ui.td}>
                  <input
                    type="checkbox"
                    checked={creditIncluded}
                    disabled={!creditAvailable}
                    onChange={(e) => setCreditIncluded(e.target.checked)}
                  />
                </td>
                <td style={ui.td}>
                  Credit Rotation
                  {!creditAvailable && <div style={ui.muted}>Corré Credit Rotation primero</div>}
                </td>
                <td style={ui.td}>—</td>
                <td style={ui.td}>
                  <input
                    style={{ ...ui.input, width: 80 }}
                    type="number"
                    value={creditWeight}
                    disabled={!creditIncluded || !creditAvailable}
                    onChange={(e) => setCreditWeight(e.target.value)}
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p style={{ ...ui.muted, marginTop: 8 }}>
          Suma de pesos ingresados: {totalEnteredWeight}% — no hace falta que sumen 100, se normalizan
          automáticamente entre las estrategias marcadas.
        </p>

        <div style={{ ...ui.form, marginTop: 12 }}>
          <label style={ui.label}>
            Año desde (opcional)
            <input style={ui.input} type="number" value={yearFrom} onChange={(e) => setYearFrom(e.target.value)} />
          </label>
          <label style={ui.label}>
            Año hasta (opcional)
            <input style={ui.input} type="number" value={yearTo} onChange={(e) => setYearTo(e.target.value)} />
          </label>
          <button style={ui.button("primary")} onClick={calculate} disabled={!fxRates}>
            {fxRates ? "Calcular cartera combinada" : "Cargando tipo de cambio…"}
          </button>
        </div>
        {error && <p style={{ color: colors.danger, marginTop: 8 }}>{error}</p>}
      </div>

      {calc && (
        <>
          {calc.fxConvertedNames.length > 0 && (
            <div style={ui.card}>
              <p style={{ ...ui.muted, margin: 0 }}>
                Convertidas por tipo de cambio (no son un fondo real en esa moneda):{" "}
                {calc.fxConvertedNames.join(" · ")}.
              </p>
            </div>
          )}

          <div style={ui.card}>
            <h3 style={ui.cardTitle}>
              Evolución del dinero — USD ({calc.years[0]}–{calc.years[calc.years.length - 1]})
            </h3>
            <p style={{ ...ui.muted, marginTop: -4, marginBottom: 8 }}>
              {calc.usd.weeklyPoints
                ? "Cierres semanales (viernes) — se ve el movimiento real dentro de cada año, no solo el punto de fin de año."
                : "Solo hay datos de fin de año disponibles para esta combinación — sin resolución semanal."}
            </p>
            <LineChart
              points={calc.usd.weeklyPoints || calc.usd.points}
              series={series}
              xKey={calc.usd.weeklyPoints ? "date" : "year"}
            />
          </div>

          <div style={ui.card}>
            <h3 style={ui.cardTitle}>
              Evolución del dinero — EUR ({calc.years[0]}–{calc.years[calc.years.length - 1]})
            </h3>
            <p style={{ ...ui.muted, marginTop: -4, marginBottom: 8 }}>
              {calc.eur.weeklyPoints
                ? "Cierres semanales (viernes) — se ve el movimiento real dentro de cada año, no solo el punto de fin de año."
                : "Solo hay datos de fin de año disponibles para esta combinación — sin resolución semanal."}
            </p>
            <LineChart
              points={calc.eur.weeklyPoints || calc.eur.points}
              series={series}
              xKey={calc.eur.weeklyPoints ? "date" : "year"}
            />
          </div>

          <div style={ui.card}>
            <h3 style={ui.cardTitle}>Riesgo y retorno</h3>
            <div style={ui.tableScroll}>
              <table style={ui.table}>
                <thead>
                  <tr>
                    <th style={ui.th}></th>
                    <th style={ui.th}>Peso efectivo</th>
                    <th style={ui.th} colSpan={4}>
                      USD
                    </th>
                    <th style={{ ...ui.th, borderLeft: `1px solid ${colors.border}` }} colSpan={4}>
                      EUR
                    </th>
                  </tr>
                  <tr>
                    <th style={ui.th}>Serie</th>
                    <th style={ui.th}></th>
                    <th style={ui.th}>Retorno total</th>
                    <th style={ui.th}>CAGR</th>
                    <th style={ui.th}>Vol. (anual)</th>
                    <th style={ui.th}>Máx. DD (fin de año)</th>
                    <th style={{ ...ui.th, borderLeft: `1px solid ${colors.border}` }}>Retorno total</th>
                    <th style={ui.th}>CAGR</th>
                    <th style={ui.th}>Vol. (anual)</th>
                    <th style={ui.th}>Máx. DD (fin de año)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style={{ ...ui.td, fontWeight: 700 }}>Cartera combinada</td>
                    <td style={ui.td}>100%</td>
                    <td style={{ ...ui.td, color: calc.usd.portfolioStats.totalReturn >= 0 ? colors.success : colors.danger, fontWeight: 700 }}>
                      {pct(calc.usd.portfolioStats.totalReturn)}
                    </td>
                    <td style={{ ...ui.td, color: calc.usd.portfolioStats.cagr >= 0 ? colors.success : colors.danger }}>
                      {pct(calc.usd.portfolioStats.cagr)}
                    </td>
                    <td style={ui.td}>{pct(calc.usd.portfolioStats.volatility)}</td>
                    <td style={{ ...ui.td, color: colors.danger }}>{pct(calc.usd.portfolioStats.maxDrawdown)}</td>
                    <td
                      style={{
                        ...ui.td,
                        color: calc.eur.portfolioStats.totalReturn >= 0 ? colors.success : colors.danger,
                        fontWeight: 700,
                        borderLeft: `1px solid ${colors.border}`,
                      }}
                    >
                      {pct(calc.eur.portfolioStats.totalReturn)}
                    </td>
                    <td style={{ ...ui.td, color: calc.eur.portfolioStats.cagr >= 0 ? colors.success : colors.danger }}>
                      {pct(calc.eur.portfolioStats.cagr)}
                    </td>
                    <td style={ui.td}>{pct(calc.eur.portfolioStats.volatility)}</td>
                    <td style={{ ...ui.td, color: colors.danger }}>{pct(calc.eur.portfolioStats.maxDrawdown)}</td>
                  </tr>
                  {calc.usd.legStats.map((lu, i) => {
                    const le = calc.eur.legStats[i];
                    return (
                      <tr key={i}>
                        <td style={ui.td}>
                          {lu.name}
                          {(lu.isReal || le.isReal) && (
                            <span
                              title="Volatilidad y drawdown reales (diarios) en al menos una de las dos monedas, calculados por su propia pestaña — no una aproximación anual."
                              style={{ marginLeft: 6, color: colors.success, cursor: "help" }}
                            >
                              ✓
                            </span>
                          )}
                        </td>
                        <td style={ui.td}>{pct(lu.weight, 0)}</td>
                        <td style={{ ...ui.td, color: lu.stats.totalReturn >= 0 ? colors.success : colors.danger }}>
                          {pct(lu.stats.totalReturn)}
                        </td>
                        <td style={ui.td}>{pct(lu.stats.cagr)}</td>
                        <td style={ui.td}>{pct(lu.stats.volatility)}</td>
                        <td style={{ ...ui.td, color: colors.danger }}>{pct(lu.stats.maxDrawdown)}</td>
                        <td
                          style={{
                            ...ui.td,
                            color: le.stats.totalReturn >= 0 ? colors.success : colors.danger,
                            borderLeft: `1px solid ${colors.border}`,
                          }}
                        >
                          {pct(le.stats.totalReturn)}
                        </td>
                        <td style={ui.td}>{pct(le.stats.cagr)}</td>
                        <td style={ui.td}>{pct(le.stats.volatility)}</td>
                        <td style={{ ...ui.td, color: colors.danger }}>{pct(le.stats.maxDrawdown)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p style={{ ...ui.muted, marginTop: 8 }}>
              Las filas con <span style={{ color: colors.success }}>✓</span> muestran, en al menos una de las dos
              columnas de moneda, la volatilidad y el máximo drawdown REALES (calculados sobre retornos diarios por
              esa misma pestaña) — la otra columna de esa fila sigue siendo una conversión/aproximación. Las
              columnas EUR de Seasonality y VIX Timing son siempre conversión por tipo de cambio, nunca un fondo
              real en euros. Todas las filas están recortadas al período {calc.years[0]}–{calc.years[calc.years.length - 1]}.
            </p>
          </div>

          {calc.benchmarkNames.length > 0 && (
            <div style={ui.card}>
              <h3 style={ui.cardTitle}>Métricas vs. benchmarks</h3>
              <p style={ui.cardSubtitle}>
                Sharpe acá es CAGR ÷ volatilidad (sin restar una tasa libre de riesgo — mismo criterio que ya usa
                Credit Rotation para "ajustado por riesgo"). Correlación e Information Ratio se calculan sobre los
                mismos retornos ANUALES que el resto de esta calculadora, no diarios — una estimación real pero más
                ruidosa que la que daría un IR calculado sobre retornos diarios.
              </p>
              <div style={ui.tableScroll}>
                <table style={ui.table}>
                  <thead>
                    <tr>
                      <th style={ui.th}></th>
                      <th style={ui.th} colSpan={2}>
                        USD
                      </th>
                      <th style={{ ...ui.th, borderLeft: `1px solid ${colors.border}` }} colSpan={2}>
                        EUR
                      </th>
                    </tr>
                    <tr>
                      <th style={ui.th}></th>
                      <th style={ui.th}>Cartera combinada</th>
                      <th style={ui.th}></th>
                      <th style={{ ...ui.th, borderLeft: `1px solid ${colors.border}` }}>Cartera combinada</th>
                      <th style={ui.th}></th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td style={{ ...ui.td, fontWeight: 700 }}>Sharpe (CAGR ÷ Vol.)</td>
                      <td style={ui.td} colSpan={2}>
                        {calc.sharpeUsd === null ? "—" : calc.sharpeUsd.toFixed(2)}
                      </td>
                      <td style={{ ...ui.td, borderLeft: `1px solid ${colors.border}` }} colSpan={2}>
                        {calc.sharpeEur === null ? "—" : calc.sharpeEur.toFixed(2)}
                      </td>
                    </tr>
                    {calc.benchmarkMetricsUsd.map((mu, i) => {
                      const me = calc.benchmarkMetricsEur[i];
                      return (
                        <tr key={i}>
                          <td style={ui.td}>vs. {mu.name}</td>
                          <td style={ui.td}>
                            Correlación: <strong>{mu.correlation === null ? "—" : mu.correlation.toFixed(2)}</strong>
                          </td>
                          <td style={ui.td}>
                            IR: <strong>{mu.informationRatio === null ? "—" : mu.informationRatio.toFixed(2)}</strong>
                          </td>
                          <td style={{ ...ui.td, borderLeft: `1px solid ${colors.border}` }}>
                            Correlación: <strong>{me.correlation === null ? "—" : me.correlation.toFixed(2)}</strong>
                          </td>
                          <td style={ui.td}>
                            IR: <strong>{me.informationRatio === null ? "—" : me.informationRatio.toFixed(2)}</strong>
                          </td>
                        </tr>
                      );
                    })}
                    {calc.benchmarkMetricsUsd.map((mu, i) => {
                      const me = calc.benchmarkMetricsEur[i];
                      return (
                        <tr key={`stats-${i}`}>
                          <td style={{ ...ui.td, color: colors.textMuted }}>{mu.name} — CAGR / Vol. propios</td>
                          <td style={ui.td} colSpan={2}>
                            {pct(mu.stats.cagr)} / {pct(mu.stats.volatility)}
                          </td>
                          <td style={{ ...ui.td, borderLeft: `1px solid ${colors.border}` }} colSpan={2}>
                            {pct(me.stats.cagr)} / {pct(me.stats.volatility)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
