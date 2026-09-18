package com.martin.fullreval.service;

import com.martin.fullreval.dto.SeasonalityMonteCarloRequest;
import com.martin.fullreval.dto.SeasonalitySweepRequest;
import com.martin.fullreval.dto.SeasonalityTestRequest;
import com.martin.fullreval.service.marketdata.MarketDataSource;
import com.martin.fullreval.service.marketdata.MarketDataSourceRegistry;
import org.apache.commons.math3.stat.correlation.SpearmansCorrelation;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.math.MathContext;
import java.time.LocalDate;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NavigableMap;
import java.util.Random;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Seasonality Hypothesis Lab: tests whether an asset's return in a "signal"
 * window (default: Jan-Feb) predicts its relative performance for the rest
 * of the year — the classic "January effect" style hypothesis, generalized to
 * any window so it can be reused for other seasonality questions later.
 *
 * Methodology notes (also surfaced in the UI — read before trusting a number):
 *   - Signal-vs-full-year correlation is shown because it's the hypothesis's
 *     literal original form, but it's partly mechanical: the signal window IS
 *     part of the full year's return. Signal-vs-rest-of-year isolates whether
 *     the effect persists once the signal window itself is over, which is the
 *     comparison that actually tests persistence rather than arithmetic.
 *   - The window sweep exists to tell a genuinely seasonal effect apart from
 *     generic momentum: if Jan-Feb stands out against same-length windows
 *     starting elsewhere in the year, that's seasonality; if all 2-month
 *     windows look similar, it's momentum and the New Year is incidental.
 *   - Per-year Spearman rhos are shown but NOT given their own p-value — a
 *     universe of ~10-12 assets is too small per year for a permutation test
 *     to mean much. p-values are computed only on the pooled (panel) rho.
 *   - A (ticker, year) only counts as "covered" if it has a valid signal,
 *     rest-of-year, AND full-year return; years below minAssetsPerYear are
 *     flagged and excluded from every statistic (but still shown in the
 *     coverage grid) — a rank correlation over 3 assets isn't comparable to
 *     one over 12.
 */
@Service
public class SeasonalityService {

    private static final int PERMUTATION_ITERATIONS = 2000;
    private static final int PERMUTATION_SEED = 42; // reproducible p-values across runs

    private final MarketDataSourceRegistry sourceRegistry;
    private final FxRateService fxRateService;
    private final AssetUniverseService assetUniverseService;

    public SeasonalityService(MarketDataSourceRegistry sourceRegistry, FxRateService fxRateService,
                               AssetUniverseService assetUniverseService) {
        this.sourceRegistry = sourceRegistry;
        this.fxRateService = fxRateService;
        this.assetUniverseService = assetUniverseService;
    }

    /** One return calculation, kept with everything needed to audit it in the UI: the
     * requested window, and the actual trading date/price pair the calc landed on (the
     * ceiling/floor of that window — may differ from the window itself around holidays or
     * data gaps). value = (endPrice - startPrice) / startPrice, null if there's no data. */
    private record ReturnCalc(Double value, LocalDate windowStart, LocalDate windowEnd,
                               LocalDate startDate, BigDecimal startPrice, LocalDate endDate, BigDecimal endPrice) {
        static ReturnCalc empty(LocalDate windowStart, LocalDate windowEnd) {
            return new ReturnCalc(null, windowStart, windowEnd, null, null, null, null);
        }
    }

    private record Point(String ticker, int year, ReturnCalc signal, ReturnCalc rest, ReturnCalc fullYear) {
        boolean coveredForStats() { return signal.value() != null && rest.value() != null && fullYear.value() != null; }
        Double signalValue() { return signal.value(); }
        Double restValue() { return rest.value(); }
        Double fullYearValue() { return fullYear.value(); }
    }

    // ------------------------------------------------------------------
    // Main test
    // ------------------------------------------------------------------

    public Map<String, Object> runTest(SeasonalityTestRequest req) {
        validateWindow(req.signalStartMonth, req.signalLengthMonths);
        MarketDataSource source = sourceRegistry.get(req.dataSource);

        Map<String, NavigableMap<LocalDate, BigDecimal>> closesByTicker = fetchAllCloses(source, req.tickers, req.currencyMode);

        List<Point> allPoints = new ArrayList<>();
        for (String ticker : req.tickers) {
            NavigableMap<LocalDate, BigDecimal> closes = closesByTicker.get(ticker);
            for (int year = req.yearFrom; year <= req.yearTo; year++) {
                allPoints.add(computePoint(ticker, year, closes, req.signalStartMonth, req.signalLengthMonths));
            }
        }

        Map<Integer, Long> assetCountByYear = allPoints.stream()
                .filter(Point::coveredForStats)
                .collect(Collectors.groupingBy(Point::year, Collectors.counting()));

        List<Point> statsPoints = allPoints.stream()
                .filter(Point::coveredForStats)
                .filter(p -> assetCountByYear.getOrDefault(p.year(), 0L) >= req.minAssetsPerYear)
                .collect(Collectors.toList());

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("meta", Map.of(
                "source", source.getDisplayName(),
                "currency", "LOCAL".equalsIgnoreCase(req.currencyMode) ? "Moneda local" : "USD",
                "yearFrom", req.yearFrom, "yearTo", req.yearTo,
                "signalStartMonth", req.signalStartMonth, "signalLengthMonths", req.signalLengthMonths,
                "tickers", req.tickers
        ));
        result.put("panel", allPoints.stream().map(this::pointToMap).toList());
        result.put("coverage", coverageReport(allPoints, req.tickers, req.yearFrom, req.yearTo, req.minAssetsPerYear));
        result.put("correlationVsRest", correlationBlock(statsPoints, Point::signalValue, Point::restValue, true));
        result.put("correlationVsFullYear", correlationBlock(statsPoints, Point::signalValue, Point::fullYearValue, true));
        result.put("persistenceVsRest", quartilePersistence(statsPoints, Point::restValue));
        result.put("persistenceVsFullYear", quartilePersistence(statsPoints, Point::fullYearValue));

        // Fixed reference lines for the strategy chart — always USD, same source, regardless of
        // what the user picked for their own universe/currency (comparing against "the market"
        // and "the world" only makes sense in one consistent currency). Unlike the strategy/
        // universe series (only invested from the day after the signal window through year-end
        // — that's the whole point of avoiding look-ahead bias), SPY/URTH here use their FULL
        // calendar-year return: they're a "what if you'd just bought and held the index all
        // along" reference, not a like-for-like same-holding-period comparison. Closes kept
        // around (not just the derived yearly returns) because the daily-return volatility calc
        // below needs the actual price series, not just one number per year.
        NavigableMap<LocalDate, BigDecimal> spyCloses = source.fetchDailyCloses("SPY");
        NavigableMap<LocalDate, BigDecimal> urthCloses = source.fetchDailyCloses("URTH");
        List<Point> sp500Points = new ArrayList<>();
        List<Point> msciWorldPoints = new ArrayList<>();
        for (int year = req.yearFrom; year <= req.yearTo; year++) {
            sp500Points.add(computePoint("SPY", year, spyCloses, req.signalStartMonth, req.signalLengthMonths));
            msciWorldPoints.add(computePoint("URTH", year, urthCloses, req.signalStartMonth, req.signalLengthMonths));
        }
        Map<Integer, ReturnCalc> sp500FullYear = sp500Points.stream()
                .filter(p -> p.fullYearValue() != null)
                .collect(Collectors.toMap(Point::year, Point::fullYear));
        Map<Integer, ReturnCalc> msciWorldFullYear = msciWorldPoints.stream()
                .filter(p -> p.fullYearValue() != null)
                .collect(Collectors.toMap(Point::year, Point::fullYear));
        result.put("strategy", strategyBacktest(statsPoints, sp500FullYear, msciWorldFullYear, closesByTicker, spyCloses, urthCloses,
                req.signalStartMonth, req.signalLengthMonths));

        // S&P 500 signal/rest/full-year returns per year, as a fixed reference row for the
        // return heatmaps — kept separate from "panel" (rather than just adding "SPY" into it)
        // so it never collides with a user-selected SPY (the COUNTRY universe's "United States"
        // ticker is SPY itself) and never leaks into the correlation/persistence/winner stats,
        // which must stay scoped to the user's own chosen universe. Reuses the sp500Points
        // computed above, so this is free of extra network calls.
        result.put("sp500Panel", sp500Points.stream().map(this::pointToMap).toList());
        return result;
    }

    // ------------------------------------------------------------------
    // Window sweep
    // ------------------------------------------------------------------

    public Map<String, Object> runSweep(SeasonalitySweepRequest req) {
        MarketDataSource source = sourceRegistry.get(req.dataSource);
        Map<String, NavigableMap<LocalDate, BigDecimal>> closesByTicker = fetchAllCloses(source, req.tickers, req.currencyMode);

        List<Map<String, Object>> cells = new ArrayList<>();
        for (int startMonth = 1; startMonth <= 12; startMonth++) {
            for (int lengthMonths = 1; lengthMonths <= 3; lengthMonths++) {
                if (startMonth + lengthMonths - 1 > 12) {
                    // Cross-year window (e.g. Nov start + 3 months) — excluded, see class javadoc.
                    continue;
                }
                List<Point> points = new ArrayList<>();
                for (String ticker : req.tickers) {
                    NavigableMap<LocalDate, BigDecimal> closes = closesByTicker.get(ticker);
                    for (int year = req.yearFrom; year <= req.yearTo; year++) {
                        points.add(computePoint(ticker, year, closes, startMonth, lengthMonths));
                    }
                }
                Map<Integer, Long> countByYear = points.stream()
                        .filter(Point::coveredForStats)
                        .collect(Collectors.groupingBy(Point::year, Collectors.counting()));
                List<Point> covered = points.stream()
                        .filter(Point::coveredForStats)
                        .filter(p -> countByYear.getOrDefault(p.year(), 0L) >= req.minAssetsPerYear)
                        .toList();

                Map<String, Object> corr = correlationBlock(covered, Point::signalValue, Point::restValue, false); // no p-value: 33 cells x permutation would be slow
                Map<String, Object> cell = new LinkedHashMap<>();
                cell.put("startMonth", startMonth);
                cell.put("lengthMonths", lengthMonths);
                cell.put("rho", corr.get("rho"));
                cell.put("n", corr.get("n"));
                cells.add(cell);
            }
        }

        return Map.of(
                "meta", Map.of("source", source.getDisplayName(), "yearFrom", req.yearFrom, "yearTo", req.yearTo,
                        "tickers", req.tickers, "comparison", "signal vs. rest of year"),
                "cells", cells
        );
    }

    // ------------------------------------------------------------------
    // Combinatorial optimizer ("Monte Carlo" in the UI, though it's an exhaustive grid
    // search, not random sampling — every valid window is actually evaluated)
    // ------------------------------------------------------------------

    /** One (universe, window) combination's top-quartile strategy result, evaluated exactly
     * like strategyBacktest's "Cuartil superior" series: buy the signal-window top quartile
     * at the end of the signal window, hold to year-end, repeat every year, compound. score is
     * CAGR / volatility — a Sharpe-ratio-shaped number (no risk-free rate subtracted) used only
     * to RANK combinations against each other, not as a standalone risk-adjusted metric. */
    private record ComboResult(String universe, int startMonth, int lengthMonths, int yearsUsed,
                                double totalReturn, double cagr, double volatility, double maxDrawdown, double score,
                                Map<Integer, List<String>> topQuartileByYear) {}

    public Map<String, Object> runMonteCarlo(SeasonalityMonteCarloRequest req) {
        validateYearRange(req.yearFrom, req.yearTo);
        String modeUpper = req.mode == null ? "ROTATING" : req.mode.toUpperCase();
        boolean fixedMode = "FIXED".equals(modeUpper);
        boolean rotatingSubsetMode = "ROTATING_SUBSET".equals(modeUpper);
        if ((fixedMode || rotatingSubsetMode) && (req.fixedSize == null || req.fixedSize < 2)) {
            throw new IllegalArgumentException("For this mode, pick a number of assets >= 2");
        }
        MarketDataSource source = sourceRegistry.get(req.dataSource);
        List<Integer> lengths = (req.lengthMonths == null || req.lengthMonths.isEmpty()) ? List.of(1, 2, 3) : req.lengthMonths;
        List<String> universes = (req.universes == null || req.universes.isEmpty()) ? List.of("SECTOR", "COUNTRY") : req.universes;
        List<Integer> startMonths;
        if (req.startMonths == null || req.startMonths.isEmpty()) {
            startMonths = new ArrayList<>();
            for (int m = 1; m <= 12; m++) startMonths.add(m);
        } else {
            startMonths = req.startMonths;
        }
        // Computed up front (not after the sweep) because FIXED/ROTATING_SUBSET only keep the
        // SINGLE best-scoring candidate per window — if that filtering happened only after the
        // sweep, a short-sample fluke that outscored a longer-history runner-up would already
        // have won the "best for this window" slot, discarding the runner-up along with it.
        int totalRequestedYears = req.yearTo - req.yearFrom + 1;
        int minYearsUsed = req.minYearsUsed != null ? req.minYearsUsed : Math.max(2, totalRequestedYears / 2);

        List<ComboResult> results = new ArrayList<>();
        for (String universe : universes) {
            boolean isCountry = "COUNTRY".equalsIgnoreCase(universe);
            List<String> tickers = isCountry ? assetUniverseService.countryTickers() : assetUniverseService.sectorTickers();
            String currencyMode = isCountry ? req.currencyMode : "USD";
            Map<String, NavigableMap<LocalDate, BigDecimal>> closesByTicker = fetchAllCloses(source, tickers, currencyMode);

            if ((fixedMode || rotatingSubsetMode) && req.fixedSize > tickers.size()) continue; // universe too small

            for (int startMonth : startMonths) {
                for (int lengthMonths : lengths) {
                    if (startMonth + lengthMonths - 1 > 12) continue; // cross-year window — excluded, see class javadoc

                    ComboResult combo;
                    if (fixedMode) {
                        combo = bestFixedCombo(universe, tickers, closesByTicker, startMonth, lengthMonths,
                                req.yearFrom, req.yearTo, req.fixedSize, minYearsUsed);
                    } else if (rotatingSubsetMode) {
                        combo = bestRotatingSubsetCombo(universe, tickers, closesByTicker, startMonth, lengthMonths,
                                req.yearFrom, req.yearTo, req.fixedSize, minYearsUsed);
                    } else {
                        List<Point> allPoints = new ArrayList<>();
                        for (String ticker : tickers) {
                            NavigableMap<LocalDate, BigDecimal> closes = closesByTicker.get(ticker);
                            for (int year = req.yearFrom; year <= req.yearTo; year++) {
                                allPoints.add(computePoint(ticker, year, closes, startMonth, lengthMonths));
                            }
                        }
                        Map<Integer, Long> assetCountByYear = allPoints.stream()
                                .filter(Point::coveredForStats)
                                .collect(Collectors.groupingBy(Point::year, Collectors.counting()));
                        List<Point> statsPoints = allPoints.stream()
                                .filter(Point::coveredForStats)
                                .filter(p -> assetCountByYear.getOrDefault(p.year(), 0L) >= req.minAssetsPerYear)
                                .toList();
                        combo = evaluateCombo(universe, statsPoints, closesByTicker, startMonth, lengthMonths);
                    }
                    if (combo != null) results.add(combo);
                }
            }
        }

        // Safety-net re-filter: FIXED/ROTATING_SUBSET already enforce minYearsUsed while picking
        // each window's single best candidate (see above); plain ROTATING has no such per-window
        // search step, so this is where its short-sample combos actually get discarded.
        int discardedForShortSample = (int) results.stream().filter(r -> r.yearsUsed() < minYearsUsed).count();
        results = new ArrayList<>(results.stream().filter(r -> r.yearsUsed() >= minYearsUsed).toList());

        results.sort(Comparator.comparingDouble(ComboResult::score).reversed());
        List<Map<String, Object>> combosJson = results.stream().map(this::comboToMap).toList();

        Map<String, Object> result = new LinkedHashMap<>();
        Map<String, Object> meta = new LinkedHashMap<>();
        meta.put("source", source.getDisplayName());
        meta.put("yearFrom", req.yearFrom);
        meta.put("yearTo", req.yearTo);
        meta.put("universes", universes);
        meta.put("lengthsTested", lengths);
        meta.put("startMonths", startMonths);
        meta.put("minAssetsPerYear", req.minAssetsPerYear);
        meta.put("mode", modeUpper);
        meta.put("fixedSize", req.fixedSize);
        meta.put("minYearsUsed", minYearsUsed);
        meta.put("discardedForShortSample", discardedForShortSample);
        meta.put("combosEvaluated", combosJson.size());
        result.put("meta", meta);
        result.put("combos", combosJson);
        result.put("best", combosJson.isEmpty() ? null : combosJson.get(0));
        return result;
    }

    /** FIXED mode: searches EVERY possible fixedSize-ticker subset of this universe for this
     * specific (startMonth, lengthMonths) window and keeps the single best one by score — the
     * answer to "if I have to commit to N assets and never rotate them, which N give the best
     * risk-adjusted return for this window?" (as opposed to evaluateCombo's top-quartile-by-
     * signal, which re-picks the basket every year).
     *
     * A ticker's rest-of-year return for this window depends only on (ticker, year) — never on
     * which subset it happens to be in — so it's computed ONCE per ticker/year here (restCache)
     * instead of once per subset that contains it (which was C(12,6)=924 subsets × up to 6
     * memberships each, i.e. redundant by roughly the size of the universe). Building the real
     * daily wealth curve (buildDailySeries, for volatility+drawdown) genuinely does depend on
     * the exact subset, so it's still per-subset, but capped to a CAGR-shortlist. */
    private static final int MAX_FIXED_CANDIDATES_PER_WINDOW = 150;

    private ComboResult bestFixedCombo(String universeLabel, List<String> tickers,
                                        Map<String, NavigableMap<LocalDate, BigDecimal>> closesByTicker,
                                        int startMonth, int lengthMonths, int yearFrom, int yearTo, int fixedSize, int minYearsUsed) {
        List<Integer> years = new ArrayList<>();
        for (int year = yearFrom; year <= yearTo; year++) years.add(year);

        Map<String, Map<Integer, Double>> restCache = new HashMap<>();
        for (String ticker : tickers) {
            Map<Integer, Double> byYear = new HashMap<>();
            NavigableMap<LocalDate, BigDecimal> closes = closesByTicker.get(ticker);
            for (int year : years) {
                Double v = restOnlyValue(closes, year, startMonth, lengthMonths);
                if (v != null) byYear.put(year, v);
            }
            restCache.put(ticker, byYear);
        }

        record QuickCandidate(List<String> subset, double cagr) {}
        List<QuickCandidate> quick = new ArrayList<>();
        for (List<String> subset : combinations(tickers, fixedSize)) {
            Double cagr = quickCagr(subset, restCache, yearFrom, yearTo);
            if (cagr != null) quick.add(new QuickCandidate(subset, cagr));
        }
        if (quick.isEmpty()) return null;
        // A combo with mediocre CAGR essentially never ends up with the best risk-adjusted
        // score among ~11-12 correlated sector/country ETFs, so only the top-CAGR shortlist
        // gets the expensive full evaluation — evaluated exactly, not sampled, just fewer of them.
        quick.sort(Comparator.comparingDouble(QuickCandidate::cagr).reversed());

        // Each ticker's daily return series (aligned to one shared reference calendar) is
        // computed ONCE here and reused by every shortlisted subset below — see
        // precomputeDailyReturns for why that matters (this used to be the actual bottleneck).
        Map<String, Map<Integer, double[]>> precomputed = precomputeDailyReturns(tickers, closesByTicker, years, startMonth, lengthMonths);

        ComboResult best = null;
        int shortlistSize = Math.min(quick.size(), MAX_FIXED_CANDIDATES_PER_WINDOW);
        for (int i = 0; i < shortlistSize; i++) {
            ComboResult candidate = evaluateFixedCombo(universeLabel, quick.get(i).subset(), restCache, precomputed, startMonth, lengthMonths, yearFrom, yearTo);
            // minYearsUsed is enforced HERE, not as a filter after this method returns — this
            // method only ever returns its single best candidate for the window, so if a
            // short-sample fluke won on score alone, a longer-history runner-up would already
            // be gone by the time a post-hoc filter got to look at it.
            if (candidate != null && candidate.yearsUsed() >= minYearsUsed && (best == null || candidate.score() > best.score())) {
                best = candidate;
            }
        }
        return best;
    }

    /** Per-ticker daily return series for FIXED mode's subset search, aligned to ONE shared
     * reference trading calendar per year (this universe's first ticker's calendar — the same
     * "these ETFs all share essentially the NYSE calendar" approximation portfolioDailyReturns
     * already makes, just computed once up front instead of re-deriving a date list from a
     * TreeMap for every single subset). NaN marks a day this ticker has no price for one of the
     * two dates — skipped when averaging a subset's members, same as portfolioDailyReturns'
     * count>0 check. This exists because bestFixedCombo evaluates far more baskets than
     * buildDailySeries's normal TreeMap-lookups-per-basket approach can afford. */
    private Map<String, Map<Integer, double[]>> precomputeDailyReturns(List<String> tickers,
            Map<String, NavigableMap<LocalDate, BigDecimal>> closesByTicker, List<Integer> years,
            int startMonth, int lengthMonths) {
        NavigableMap<LocalDate, BigDecimal> reference = closesByTicker.get(tickers.get(0));
        Map<Integer, List<LocalDate>> datesByYear = new HashMap<>();
        for (int year : years) {
            LocalDate windowStart = LocalDate.of(year, startMonth, 1);
            LocalDate windowEnd = windowStart.plusMonths(lengthMonths).minusDays(1);
            LocalDate holdStart = windowEnd.plusDays(1);
            LocalDate holdEnd = LocalDate.of(year, 12, 31);
            datesByYear.put(year, (reference == null || reference.isEmpty() || !holdStart.isBefore(holdEnd))
                    ? List.of()
                    : new ArrayList<>(reference.subMap(holdStart, true, holdEnd, true).keySet()));
        }

        Map<String, Map<Integer, double[]>> result = new HashMap<>();
        for (String ticker : tickers) {
            NavigableMap<LocalDate, BigDecimal> closes = closesByTicker.get(ticker);
            Map<Integer, double[]> byYear = new HashMap<>();
            for (int year : years) {
                List<LocalDate> dates = datesByYear.get(year);
                double[] returns = new double[Math.max(0, dates.size() - 1)];
                for (int i = 1; i < dates.size(); i++) {
                    BigDecimal p0 = closes == null ? null : closes.get(dates.get(i - 1));
                    BigDecimal p1 = closes == null ? null : closes.get(dates.get(i));
                    returns[i - 1] = (p0 == null || p1 == null || p0.signum() == 0)
                            ? Double.NaN
                            : p1.subtract(p0).divide(p0, MathContext.DECIMAL64).doubleValue();
                }
                byYear.put(year, returns);
            }
            result.put(ticker, byYear);
        }
        return result;
    }

    /** Same wealth-curve mechanics as buildDailySeries (compounds daily returns, tracks
     * peak-to-trough drawdown), but reads from precomputeDailyReturns' arrays instead of
     * re-walking closesByTicker's TreeMaps — pure array arithmetic, safe to call once per
     * shortlisted subset. */
    private DailySeries buildDailySeriesFromPrecomputed(List<Integer> years, java.util.function.Function<Integer, List<String>> basketForYear,
                                                         Map<String, Map<Integer, double[]>> precomputed) {
        List<Double> allDailyReturns = new ArrayList<>();
        double wealth = 1.0;
        double peak = 1.0;
        double maxDrawdown = 0.0;
        Map<Integer, Double> maxDrawdownByYear = new LinkedHashMap<>();

        for (int year : years) {
            List<String> basket = basketForYear.apply(year);
            double[][] memberReturns = new double[basket.size()][];
            for (int m = 0; m < basket.size(); m++) {
                memberReturns[m] = precomputed.get(basket.get(m)).get(year);
            }
            int dayCount = memberReturns.length == 0 ? 0 : memberReturns[0].length;
            for (int d = 0; d < dayCount; d++) {
                double sum = 0;
                int count = 0;
                for (double[] arr : memberReturns) {
                    double v = arr[d];
                    if (!Double.isNaN(v)) { sum += v; count++; }
                }
                if (count > 0) {
                    double r = sum / count;
                    allDailyReturns.add(r);
                    wealth *= 1.0 + r;
                    peak = Math.max(peak, wealth);
                    maxDrawdown = Math.min(maxDrawdown, (wealth - peak) / peak);
                }
            }
            maxDrawdownByYear.put(year, maxDrawdown);
        }
        return new DailySeries(annualizedVolFromDaily(allDailyReturns), maxDrawdown, maxDrawdownByYear);
    }

    /** Just the rest-of-year ReturnCalc's value — skips computing the signal-window and
     * full-year ReturnCalc that computePoint/Point always build alongside it, which FIXED mode
     * never uses (there's no signal-based ranking when the basket never changes). */
    private Double restOnlyValue(NavigableMap<LocalDate, BigDecimal> closes, int year, int startMonth, int lengthMonths) {
        LocalDate windowStart = LocalDate.of(year, startMonth, 1);
        LocalDate windowEnd = windowStart.plusMonths(lengthMonths).minusDays(1);
        LocalDate yearEnd = LocalDate.of(year, 12, 31);
        if (!windowEnd.isBefore(yearEnd)) return null;
        return computeReturnCalc(closes, windowEnd.plusDays(1), yearEnd).value();
    }

    /** Cheap first pass for bestFixedCombo's shortlist: just the compounded CAGR of holding this
     * fixed basket every year, skipping buildDailySeries entirely. Null if fewer than 2 years
     * have data for every member of the basket. */
    private Double quickCagr(List<String> subset, Map<String, Map<Integer, Double>> restCache, int yearFrom, int yearTo) {
        double cumStrategy = 1.0;
        int usableYears = 0;
        for (int year = yearFrom; year <= yearTo; year++) {
            List<Double> memberReturns = new ArrayList<>(subset.size());
            boolean allCovered = true;
            for (String ticker : subset) {
                Double v = restCache.get(ticker).get(year);
                if (v == null) { allCovered = false; break; }
                memberReturns.add(v);
            }
            if (!allCovered) continue;
            cumStrategy *= 1.0 + memberReturns.stream().mapToDouble(Double::doubleValue).average().orElse(0);
            usableYears++;
        }
        if (usableYears < 2) return null;
        return Math.pow(cumStrategy, 1.0 / usableYears) - 1.0;
    }

    /** Same buy-at-end-of-signal-window, hold-to-year-end mechanics as evaluateCombo, but with
     * a FIXED basket held identically every year — no re-ranking by that year's signal return.
     * A year only counts if EVERY member of the fixed basket has data for it — a fixed N-asset
     * portfolio isn't well-defined for a year where one of its members didn't exist yet. */
    private ComboResult evaluateFixedCombo(String universeLabel, List<String> subset, Map<String, Map<Integer, Double>> restCache,
                                            Map<String, Map<Integer, double[]>> precomputed,
                                            int startMonth, int lengthMonths, int yearFrom, int yearTo) {
        Map<Integer, List<String>> basketByYear = new LinkedHashMap<>();
        List<Integer> usableYears = new ArrayList<>();
        double cumStrategy = 1.0;
        for (int year = yearFrom; year <= yearTo; year++) {
            List<Double> memberReturns = new ArrayList<>();
            boolean allCovered = true;
            for (String ticker : subset) {
                Double v = restCache.get(ticker).get(year);
                if (v == null) { allCovered = false; break; }
                memberReturns.add(v);
            }
            if (!allCovered) continue;
            double yearReturn = memberReturns.stream().mapToDouble(Double::doubleValue).average().orElse(0);
            cumStrategy *= 1.0 + yearReturn;
            basketByYear.put(year, subset);
            usableYears.add(year);
        }
        if (usableYears.size() < 2) return null; // one data point can't show a meaningful risk/return trade-off

        DailySeries daily = buildDailySeriesFromPrecomputed(usableYears, basketByYear::get, precomputed);
        double totalReturn = cumStrategy - 1.0;
        double cagr = Math.pow(cumStrategy, 1.0 / usableYears.size()) - 1.0;
        double score = daily.volatility() > 0 ? cagr / daily.volatility() : 0.0;
        return new ComboResult(universeLabel, startMonth, lengthMonths, usableYears.size(), totalReturn, cagr,
                daily.volatility(), daily.maxDrawdown(), score, basketByYear);
    }

    /** ROTATING_SUBSET mode: the main strategy's "re-pick the top quartile by signal every
     * year" logic, but restricted to a chosen subsetSize-ticker subset instead of the whole
     * universe — searches every possible subset and keeps the best. fixedSize=2 reproduces
     * "always hold whichever of these two tickers led the signal window" for every possible
     * pair, generalizing what a user would otherwise have to try by hand one pair at a time.
     * Needs both the signal-window AND rest-of-year return per ticker/year to rank within the
     * subset each year (unlike FIXED mode, which only ever needs rest-of-year). */
    private ComboResult bestRotatingSubsetCombo(String universeLabel, List<String> tickers,
                                                 Map<String, NavigableMap<LocalDate, BigDecimal>> closesByTicker,
                                                 int startMonth, int lengthMonths, int yearFrom, int yearTo, int subsetSize, int minYearsUsed) {
        List<Integer> years = new ArrayList<>();
        for (int year = yearFrom; year <= yearTo; year++) years.add(year);

        Map<String, Map<Integer, Double>> signalCache = new HashMap<>();
        Map<String, Map<Integer, Double>> restCache = new HashMap<>();
        for (String ticker : tickers) {
            NavigableMap<LocalDate, BigDecimal> closes = closesByTicker.get(ticker);
            Map<Integer, Double> signalByYear = new HashMap<>();
            Map<Integer, Double> restByYear = new HashMap<>();
            for (int year : years) {
                LocalDate windowStart = LocalDate.of(year, startMonth, 1);
                LocalDate windowEnd = windowStart.plusMonths(lengthMonths).minusDays(1);
                Double signal = computeReturnCalc(closes, windowStart, windowEnd).value();
                if (signal != null) signalByYear.put(year, signal);
                Double rest = restOnlyValue(closes, year, startMonth, lengthMonths);
                if (rest != null) restByYear.put(year, rest);
            }
            signalCache.put(ticker, signalByYear);
            restCache.put(ticker, restByYear);
        }

        record QuickCandidate(List<String> subset, double cagr) {}
        List<QuickCandidate> quick = new ArrayList<>();
        for (List<String> subset : combinations(tickers, subsetSize)) {
            Double cagr = quickCagrRotating(subset, signalCache, restCache, yearFrom, yearTo);
            if (cagr != null) quick.add(new QuickCandidate(subset, cagr));
        }
        if (quick.isEmpty()) return null;
        quick.sort(Comparator.comparingDouble(QuickCandidate::cagr).reversed());

        Map<String, Map<Integer, double[]>> precomputed = precomputeDailyReturns(tickers, closesByTicker, years, startMonth, lengthMonths);

        ComboResult best = null;
        int shortlistSize = Math.min(quick.size(), MAX_FIXED_CANDIDATES_PER_WINDOW);
        for (int i = 0; i < shortlistSize; i++) {
            ComboResult candidate = evaluateRotatingSubsetCombo(universeLabel, quick.get(i).subset(), signalCache, restCache, precomputed,
                    startMonth, lengthMonths, yearFrom, yearTo);
            // See bestFixedCombo for why minYearsUsed has to be enforced here rather than as a
            // filter applied after this method returns its single best-per-window candidate.
            if (candidate != null && candidate.yearsUsed() >= minYearsUsed && (best == null || candidate.score() > best.score())) {
                best = candidate;
            }
        }
        return best;
    }

    /** Cheap first pass for bestRotatingSubsetCombo's shortlist: compounded CAGR of picking,
     * within this subset, the top quartile by signal every year — skips buildDailySeries. */
    private Double quickCagrRotating(List<String> subset, Map<String, Map<Integer, Double>> signalCache,
                                      Map<String, Map<Integer, Double>> restCache, int yearFrom, int yearTo) {
        double cumStrategy = 1.0;
        int usableYears = 0;
        for (int year = yearFrom; year <= yearTo; year++) {
            List<String> covered = new ArrayList<>();
            for (String t : subset) {
                if (signalCache.get(t).get(year) != null && restCache.get(t).get(year) != null) covered.add(t);
            }
            if (covered.size() < 2) continue;
            final int y = year;
            int quartileSize = (int) Math.ceil(covered.size() / 4.0);
            covered.sort(Comparator.comparingDouble((String t) -> signalCache.get(t).get(y)).reversed());
            double yearReturn = covered.subList(0, quartileSize).stream()
                    .mapToDouble(t -> restCache.get(t).get(y)).average().orElse(0);
            cumStrategy *= 1.0 + yearReturn;
            usableYears++;
        }
        if (usableYears < 2) return null;
        return Math.pow(cumStrategy, 1.0 / usableYears) - 1.0;
    }

    /** Full evaluation for bestRotatingSubsetCombo's shortlist: same per-year top-quartile-by-
     * signal selection as quickCagrRotating, but also builds the real daily wealth curve
     * (via the precomputed per-ticker arrays) for volatility, drawdown, and score. */
    private ComboResult evaluateRotatingSubsetCombo(String universeLabel, List<String> subset,
                                                     Map<String, Map<Integer, Double>> signalCache, Map<String, Map<Integer, Double>> restCache,
                                                     Map<String, Map<Integer, double[]>> precomputed,
                                                     int startMonth, int lengthMonths, int yearFrom, int yearTo) {
        Map<Integer, List<String>> basketByYear = new LinkedHashMap<>();
        List<Integer> usableYears = new ArrayList<>();
        double cumStrategy = 1.0;
        for (int year = yearFrom; year <= yearTo; year++) {
            List<String> covered = new ArrayList<>();
            for (String t : subset) {
                if (signalCache.get(t).get(year) != null && restCache.get(t).get(year) != null) covered.add(t);
            }
            if (covered.size() < 2) continue;
            final int y = year;
            int quartileSize = (int) Math.ceil(covered.size() / 4.0);
            covered.sort(Comparator.comparingDouble((String t) -> signalCache.get(t).get(y)).reversed());
            List<String> top = new ArrayList<>(covered.subList(0, quartileSize));
            double yearReturn = top.stream().mapToDouble(t -> restCache.get(t).get(y)).average().orElse(0);
            cumStrategy *= 1.0 + yearReturn;
            basketByYear.put(year, top);
            usableYears.add(year);
        }
        if (usableYears.size() < 2) return null;

        DailySeries daily = buildDailySeriesFromPrecomputed(usableYears, basketByYear::get, precomputed);
        double totalReturn = cumStrategy - 1.0;
        double cagr = Math.pow(cumStrategy, 1.0 / usableYears.size()) - 1.0;
        double score = daily.volatility() > 0 ? cagr / daily.volatility() : 0.0;
        return new ComboResult(universeLabel, startMonth, lengthMonths, usableYears.size(), totalReturn, cagr,
                daily.volatility(), daily.maxDrawdown(), score, basketByYear);
    }

    /** All k-element subsets of items, order-independent (combinations, not permutations). */
    private List<List<String>> combinations(List<String> items, int k) {
        List<List<String>> result = new ArrayList<>();
        if (k <= 0 || k > items.size()) return result;
        combinationsHelper(items, k, 0, new ArrayDeque<>(), result);
        return result;
    }

    private void combinationsHelper(List<String> items, int k, int start, Deque<String> current, List<List<String>> result) {
        if (current.size() == k) {
            result.add(new ArrayList<>(current));
            return;
        }
        for (int i = start; i < items.size(); i++) {
            current.addLast(items.get(i));
            combinationsHelper(items, k, i + 1, current, result);
            current.removeLast();
        }
    }

    /** Same top-quartile-by-signal, hold-to-year-end logic as strategyBacktest, but reduced to
     * just the summary numbers a combinatorial search needs (no per-year rows, no benchmark
     * comparison) — returns null if there isn't enough covered data to say anything. */
    private ComboResult evaluateCombo(String universeLabel, List<Point> statsPoints,
                                       Map<String, NavigableMap<LocalDate, BigDecimal>> closesByTicker,
                                       int startMonth, int lengthMonths) {
        Map<Integer, List<Point>> byYear = statsPoints.stream()
                .filter(p -> p.restValue() != null)
                .collect(Collectors.groupingBy(Point::year));

        List<Integer> years = new ArrayList<>(byYear.keySet());
        years.sort(Comparator.naturalOrder());

        Map<Integer, List<String>> topQuartileByYear = new LinkedHashMap<>();
        List<Integer> usableYears = new ArrayList<>();
        double cumStrategy = 1.0;
        for (int year : years) {
            List<Point> yearPoints = byYear.get(year);
            if (yearPoints.size() < 2) continue; // need at least 2 to have a "top" and a "rest"
            int quartileSize = (int) Math.ceil(yearPoints.size() / 4.0);
            List<Point> topQuartile = yearPoints.stream()
                    .sorted(Comparator.comparingDouble(Point::signalValue).reversed())
                    .limit(quartileSize)
                    .toList();
            double strategyReturn = topQuartile.stream().mapToDouble(Point::restValue).average().orElse(0);
            cumStrategy *= 1.0 + strategyReturn;
            topQuartileByYear.put(year, topQuartile.stream().map(Point::ticker).toList());
            usableYears.add(year);
        }
        if (usableYears.size() < 2) return null; // one data point can't show a meaningful risk/return trade-off

        DailySeries daily = buildDailySeries(usableYears, topQuartileByYear::get, closesByTicker, startMonth, lengthMonths);
        double totalReturn = cumStrategy - 1.0;
        double cagr = Math.pow(cumStrategy, 1.0 / usableYears.size()) - 1.0;
        double score = daily.volatility() > 0 ? cagr / daily.volatility() : 0.0;
        return new ComboResult(universeLabel, startMonth, lengthMonths, usableYears.size(), totalReturn, cagr,
                daily.volatility(), daily.maxDrawdown(), score, topQuartileByYear);
    }

    private Map<String, Object> comboToMap(ComboResult c) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("universe", c.universe());
        m.put("startMonth", c.startMonth());
        m.put("lengthMonths", c.lengthMonths());
        m.put("yearsUsed", c.yearsUsed());
        m.put("totalReturn", c.totalReturn());
        m.put("cagr", c.cagr());
        m.put("volatility", c.volatility());
        m.put("maxDrawdown", c.maxDrawdown());
        m.put("score", c.score());
        m.put("picksByYear", c.topQuartileByYear());
        return m;
    }

    private void validateYearRange(int yearFrom, int yearTo) {
        if (yearFrom > yearTo) throw new IllegalArgumentException("yearFrom cannot be greater than yearTo");
    }

    // ------------------------------------------------------------------
    // Shared helpers
    // ------------------------------------------------------------------

    private void validateWindow(int startMonth, int lengthMonths) {
        if (startMonth < 1 || startMonth > 12) throw new IllegalArgumentException("signalStartMonth must be between 1 and 12");
        if (lengthMonths < 1 || lengthMonths > 11) throw new IllegalArgumentException("signalLengthMonths is invalid");
        if (startMonth + lengthMonths - 1 > 12) {
            throw new IllegalArgumentException("The signal window can't cross into the next year "
                    + "(start month + length - 1 must be <= 12). Pick a shorter window or an earlier start.");
        }
    }

    private Map<String, NavigableMap<LocalDate, BigDecimal>> fetchAllCloses(MarketDataSource source, List<String> tickers, String currencyMode) {
        Map<String, NavigableMap<LocalDate, BigDecimal>> closes = new HashMap<>();
        for (String rawTicker : tickers) {
            String ticker = rawTicker.trim().toUpperCase();
            NavigableMap<LocalDate, BigDecimal> usdCloses = source.fetchDailyCloses(ticker);
            if ("LOCAL".equalsIgnoreCase(currencyMode)) {
                String currency = assetUniverseService.currencyOf(ticker);
                usdCloses = fxRateService.convertToLocal(usdCloses, currency);
            }
            closes.put(ticker, usdCloses);
        }
        return closes;
    }

    private Point computePoint(String ticker, int year, NavigableMap<LocalDate, BigDecimal> closes,
                                int startMonth, int lengthMonths) {
        LocalDate windowStart = LocalDate.of(year, startMonth, 1);
        LocalDate windowEnd = windowStart.plusMonths(lengthMonths).minusDays(1);
        LocalDate yearStart = LocalDate.of(year, 1, 1);
        LocalDate yearEnd = LocalDate.of(year, 12, 31);

        ReturnCalc signal = computeReturnCalc(closes, windowStart, windowEnd);
        ReturnCalc rest = windowEnd.isBefore(yearEnd)
                ? computeReturnCalc(closes, windowEnd.plusDays(1), yearEnd)
                : ReturnCalc.empty(windowEnd.plusDays(1), yearEnd);
        ReturnCalc fullYear = computeReturnCalc(closes, yearStart, yearEnd);
        return new Point(ticker, year, signal, rest, fullYear);
    }

    /** Core return calc, kept alongside the exact dates/prices used — this is what powers the
     * "audit this number" panel in the UI: value = (endPrice - startPrice) / startPrice, where
     * startPrice/endPrice are the closes on the first trading day on/after `from` and the last
     * trading day on/before `to` respectively (may not exactly equal from/to around holidays or
     * missing data — that's why both the requested window and the actual dates used are kept). */
    private ReturnCalc computeReturnCalc(NavigableMap<LocalDate, BigDecimal> closes, LocalDate from, LocalDate to) {
        if (closes == null || closes.isEmpty()) return ReturnCalc.empty(from, to);
        Map.Entry<LocalDate, BigDecimal> startEntry = closes.ceilingEntry(from);
        Map.Entry<LocalDate, BigDecimal> endEntry = closes.floorEntry(to);
        if (startEntry == null || endEntry == null || startEntry.getKey().isAfter(endEntry.getKey())) {
            return ReturnCalc.empty(from, to);
        }
        BigDecimal startPrice = startEntry.getValue();
        if (startPrice.signum() == 0) return ReturnCalc.empty(from, to);
        BigDecimal endPrice = endEntry.getValue();
        double value = endPrice.subtract(startPrice).divide(startPrice, MathContext.DECIMAL64).doubleValue();
        return new ReturnCalc(value, from, to, startEntry.getKey(), startPrice, endEntry.getKey(), endPrice);
    }

    /** JSON-friendly audit trail for one return calculation, shown in the UI's "audit this
     * number" panel: which ticker, which window, and the exact start/end date+price used. */
    private Map<String, Object> auditMap(String ticker, ReturnCalc rc) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("ticker", ticker);
        m.put("value", rc.value());
        m.put("windowStart", rc.windowStart() == null ? null : rc.windowStart().toString());
        m.put("windowEnd", rc.windowEnd() == null ? null : rc.windowEnd().toString());
        m.put("startDate", rc.startDate() == null ? null : rc.startDate().toString());
        m.put("startPrice", rc.startPrice());
        m.put("endDate", rc.endDate() == null ? null : rc.endDate().toString());
        m.put("endPrice", rc.endPrice());
        return m;
    }

    private Map<String, Object> pointToMap(Point p) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("ticker", p.ticker());
        m.put("year", p.year());
        m.put("signalReturn", p.signal().value());
        m.put("restReturn", p.rest().value());
        m.put("fullYearReturn", p.fullYear().value());
        m.put("covered", p.coveredForStats());
        m.put("signalAudit", auditMap(p.ticker(), p.signal()));
        m.put("restAudit", auditMap(p.ticker(), p.rest()));
        m.put("fullYearAudit", auditMap(p.ticker(), p.fullYear()));
        return m;
    }

    private Map<String, Object> coverageReport(List<Point> allPoints, List<String> tickers, int yearFrom, int yearTo, int minAssetsPerYear) {
        Map<Integer, Long> assetCountByYear = allPoints.stream()
                .filter(Point::coveredForStats)
                .collect(Collectors.groupingBy(Point::year, Collectors.counting()));

        List<Map<String, Object>> byYear = new ArrayList<>();
        for (int year = yearFrom; year <= yearTo; year++) {
            long count = assetCountByYear.getOrDefault(year, 0L);
            byYear.add(Map.of("year", year, "assetCount", count, "sufficient", count >= minAssetsPerYear));
        }

        List<Map<String, Object>> byTickerYear = allPoints.stream()
                .map(p -> Map.<String, Object>of("ticker", p.ticker(), "year", p.year(), "covered", p.coveredForStats()))
                .toList();

        return Map.of("byYear", byYear, "byTickerYear", byTickerYear, "minAssetsPerYear", minAssetsPerYear);
    }

    /** Pooled (panel) Spearman rho between two point-extractors, with an optional permutation p-value. */
    private Map<String, Object> correlationBlock(List<Point> points, java.util.function.Function<Point, Double> xFn,
                                                   java.util.function.Function<Point, Double> yFn, boolean withPValue) {
        List<Point> pairs = points.stream().filter(p -> xFn.apply(p) != null && yFn.apply(p) != null).toList();
        double[] x = pairs.stream().mapToDouble(xFn::apply).toArray();
        double[] y = pairs.stream().mapToDouble(yFn::apply).toArray();

        Map<String, Object> block = new LinkedHashMap<>();
        block.put("n", x.length);
        if (x.length < 4) {
            block.put("rho", null);
            block.put("pValue", null);
            block.put("perYear", List.of());
            return block;
        }

        SpearmansCorrelation spearman = new SpearmansCorrelation();
        double rho = spearman.correlation(x, y);
        block.put("rho", rho);

        if (withPValue) {
            block.put("pValue", permutationPValue(x, y, rho));
        }

        // Per-year rhos (no p-value — see class javadoc).
        Map<Integer, List<Point>> byYear = pairs.stream().collect(Collectors.groupingBy(Point::year));
        List<Map<String, Object>> perYear = byYear.entrySet().stream()
                .sorted(Map.Entry.comparingByKey())
                .map(e -> {
                    List<Point> yearPairs = e.getValue();
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("year", e.getKey());
                    row.put("n", yearPairs.size());
                    if (yearPairs.size() >= 4) {
                        double[] yx = yearPairs.stream().mapToDouble(xFn::apply).toArray();
                        double[] yy = yearPairs.stream().mapToDouble(yFn::apply).toArray();
                        row.put("rho", new SpearmansCorrelation().correlation(yx, yy));
                    } else {
                        row.put("rho", null);
                    }
                    return row;
                })
                .toList();
        block.put("perYear", perYear);
        return block;
    }

    /** Permutation test: shuffle y repeatedly, p = fraction of shuffles at least as extreme as the observed rho. */
    private double permutationPValue(double[] x, double[] y, double observedRho) {
        SpearmansCorrelation spearman = new SpearmansCorrelation();
        Random random = new Random(PERMUTATION_SEED);
        double[] yCopy = y.clone();
        int extreme = 0;
        for (int i = 0; i < PERMUTATION_ITERATIONS; i++) {
            shuffle(yCopy, random);
            double permRho = spearman.correlation(x, yCopy);
            if (Math.abs(permRho) >= Math.abs(observedRho)) extreme++;
        }
        return (extreme + 1.0) / (PERMUTATION_ITERATIONS + 1.0);
    }

    private void shuffle(double[] arr, Random random) {
        for (int i = arr.length - 1; i > 0; i--) {
            int j = random.nextInt(i + 1);
            double tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
        }
    }

    /** What fraction of the signal-window top quartile is ALSO in the comparison-window top quartile, per year and averaged. */
    private Map<String, Object> quartilePersistence(List<Point> points, java.util.function.Function<Point, Double> comparisonFn) {
        Map<Integer, List<Point>> byYear = points.stream()
                .filter(p -> comparisonFn.apply(p) != null)
                .collect(Collectors.groupingBy(Point::year));

        List<Map<String, Object>> perYear = new ArrayList<>();
        List<Double> persistenceValues = new ArrayList<>();

        for (Map.Entry<Integer, List<Point>> e : byYear.entrySet()) {
            List<Point> yearPoints = e.getValue();
            // Need at least 2 to split a "top" from a "bottom" at all — with exactly 2 assets
            // this degenerates to "which of the two led", which is still a valid comparison,
            // just not a literal quartile (quartileSize below is 1 of 2, i.e. the top half).
            if (yearPoints.size() < 2) continue;
            int quartileSize = (int) Math.ceil(yearPoints.size() / 4.0);

            Set<String> topBySignal = yearPoints.stream()
                    .sorted(Comparator.comparingDouble(Point::signalValue).reversed())
                    .limit(quartileSize)
                    .map(Point::ticker)
                    .collect(Collectors.toSet());
            Set<String> topByComparison = yearPoints.stream()
                    .sorted(Comparator.comparingDouble((Point p) -> comparisonFn.apply(p)).reversed())
                    .limit(quartileSize)
                    .map(Point::ticker)
                    .collect(Collectors.toSet());

            long overlap = topBySignal.stream().filter(topByComparison::contains).count();
            double persistence = (double) overlap / topBySignal.size();
            persistenceValues.add(persistence);

            Map<String, Object> row = new LinkedHashMap<>();
            row.put("year", e.getKey());
            row.put("persistence", persistence);
            row.put("quartileSize", quartileSize);
            perYear.add(row);
        }
        perYear.sort(Comparator.comparing(m -> (Integer) m.get("year")));

        double average = persistenceValues.stream().mapToDouble(Double::doubleValue).average().orElse(Double.NaN);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("average", Double.isNaN(average) ? null : average);
        result.put("expectedRandom", 0.25);
        result.put("yearsUsed", persistenceValues.size());
        result.put("perYear", perYear);
        return result;
    }

    /** Equal-weight top-quartile-by-signal portfolio, held for the REST of the year (buying at the end of the
     * signal window, since that's the earliest point the signal is actually known — using the full-year return
     * here would be look-ahead bias), vs. the equal-weighted full universe over the same holding period. SPY/URTH
     * are compared using their own FULL calendar-year return instead (see the comment where these maps are built
     * in runTest) — a "just buy and hold the index" reference, not restricted to the strategy's holding period. */
    private Map<String, Object> strategyBacktest(List<Point> points, Map<Integer, ReturnCalc> sp500FullYear, Map<Integer, ReturnCalc> msciWorldFullYear,
                                                   Map<String, NavigableMap<LocalDate, BigDecimal>> closesByTicker,
                                                   NavigableMap<LocalDate, BigDecimal> spyCloses, NavigableMap<LocalDate, BigDecimal> urthCloses,
                                                   int startMonth, int lengthMonths) {
        Map<Integer, List<Point>> byYear = points.stream()
                .filter(p -> p.restValue() != null)
                .collect(Collectors.groupingBy(Point::year));

        List<Map<String, Object>> perYear = new ArrayList<>();
        for (Map.Entry<Integer, List<Point>> e : byYear.entrySet()) {
            List<Point> yearPoints = e.getValue();
            if (yearPoints.size() < 2) continue; // need at least 2 to have a "top" and a "rest"
            int quartileSize = (int) Math.ceil(yearPoints.size() / 4.0);

            List<Point> topQuartile = yearPoints.stream()
                    .sorted(Comparator.comparingDouble(Point::signalValue).reversed())
                    .limit(quartileSize)
                    .toList();

            double strategyReturn = topQuartile.stream().mapToDouble(Point::restValue).average().orElse(0);
            double benchmarkReturn = yearPoints.stream().mapToDouble(Point::restValue).average().orElse(0);

            Map<String, Object> row = new LinkedHashMap<>();
            row.put("year", e.getKey());
            row.put("strategyReturn", strategyReturn);
            row.put("benchmarkReturn", benchmarkReturn);
            row.put("diff", strategyReturn - benchmarkReturn);
            // Audit trail: exactly which tickers make up this average, and each one's own
            // start/end date+price — this is what the UI's "auditar" click shows.
            row.put("strategyReturnAudit", topQuartile.stream().map(p -> auditMap(p.ticker(), p.rest())).toList());
            row.put("benchmarkReturnAudit", yearPoints.stream().map(p -> auditMap(p.ticker(), p.rest())).toList());
            perYear.add(row);
        }
        perYear.sort(Comparator.comparing(m -> (Integer) m.get("year")));
        List<Integer> years = perYear.stream().map(m -> (Integer) m.get("year")).toList();

        // A benchmark that doesn't cover the WHOLE requested range (e.g. URTH only started
        // trading in 2012) is dropped entirely rather than shown as a flat 0% line for the
        // years before it existed — that would misleadingly read as "no return", not "no data".
        boolean includeSp500 = years.stream().allMatch(sp500FullYear::containsKey);
        boolean includeMsciWorld = years.stream().allMatch(msciWorldFullYear::containsKey);

        if (includeSp500) {
            for (Map<String, Object> row : perYear) {
                ReturnCalc rc = sp500FullYear.get((Integer) row.get("year"));
                row.put("sp500Return", rc.value());
                row.put("diffVsSp500", (double) row.get("strategyReturn") - rc.value());
                row.put("sp500ReturnAudit", List.of(auditMap("SPY", rc)));
            }
        }

        List<Map<String, Object>> cumulative = new ArrayList<>();
        double cumStrategy = 1.0, cumBenchmark = 1.0, cumSp500 = 1.0, cumMsciWorld = 1.0;
        for (Map<String, Object> row : perYear) {
            int year = (Integer) row.get("year");
            cumStrategy *= 1.0 + (double) row.get("strategyReturn");
            cumBenchmark *= 1.0 + (double) row.get("benchmarkReturn");
            if (includeSp500) cumSp500 *= 1.0 + sp500FullYear.get(year).value();
            if (includeMsciWorld) cumMsciWorld *= 1.0 + msciWorldFullYear.get(year).value();

            Map<String, Object> point = new LinkedHashMap<>();
            point.put("year", year);
            point.put("cumulativeStrategy", cumStrategy - 1.0);
            point.put("cumulativeBenchmark", cumBenchmark - 1.0);
            if (includeSp500) point.put("cumulativeSp500", cumSp500 - 1.0);
            if (includeMsciWorld) point.put("cumulativeMsciWorld", cumMsciWorld - 1.0);
            cumulative.add(point);
        }

        // Which tickers make up each series, per year — needed to build the real daily wealth
        // curve below (both for volatility AND for max drawdown, so a mid-year dip that fully
        // recovers by December — invisible if you only look at year-end snapshots — actually
        // shows up).
        Map<Integer, List<String>> topQuartileByYear = new LinkedHashMap<>();
        Map<Integer, List<String>> allTickersByYear = new LinkedHashMap<>();
        for (int year : years) {
            List<Point> yearPoints = byYear.get(year);
            if (yearPoints == null || yearPoints.size() < 2) continue;
            int quartileSize = (int) Math.ceil(yearPoints.size() / 4.0);
            topQuartileByYear.put(year, yearPoints.stream()
                    .sorted(Comparator.comparingDouble(Point::signalValue).reversed())
                    .limit(quartileSize)
                    .map(Point::ticker)
                    .toList());
            allTickersByYear.put(year, yearPoints.stream().map(Point::ticker).toList());
        }

        DailySeries strategyDaily = buildDailySeries(years, topQuartileByYear::get, closesByTicker, startMonth, lengthMonths);
        DailySeries benchmarkDaily = buildDailySeries(years, allTickersByYear::get, closesByTicker, startMonth, lengthMonths);
        // startMonth=1, lengthMonths=0 makes buildDailySeries' "hold from the day after the
        // window ends through Dec 31" span the FULL calendar year (window end = Dec 31 of the
        // prior year) — reused here instead of a separate method, matching the full-year
        // treatment SPY/URTH get everywhere else in this backtest (see sp500FullYear above).
        DailySeries sp500Daily = includeSp500
                ? buildDailySeries(years, y -> List.of("SPY"), Map.of("SPY", spyCloses), 1, 0) : null;
        DailySeries msciDaily = includeMsciWorld
                ? buildDailySeries(years, y -> List.of("URTH"), Map.of("URTH", urthCloses), 1, 0) : null;

        // Per-year max drawdown (running, as of that year-end, but built from real daily
        // closes within each year — not just its closing snapshot) — attached to the SAME
        // perYear rows the two "vs. Universo" / "vs. S&P 500" tables already render.
        for (int i = 0; i < perYear.size(); i++) {
            int year = years.get(i);
            perYear.get(i).put("strategyDrawdown", strategyDaily.maxDrawdownByYear().getOrDefault(year, 0.0));
            perYear.get(i).put("benchmarkDrawdown", benchmarkDaily.maxDrawdownByYear().getOrDefault(year, 0.0));
            if (includeSp500) perYear.get(i).put("sp500Drawdown", sp500Daily.maxDrawdownByYear().getOrDefault(year, 0.0));
            if (includeMsciWorld) perYear.get(i).put("msciWorldDrawdown", msciDaily.maxDrawdownByYear().getOrDefault(year, 0.0));
        }

        Map<String, Object> stats = new LinkedHashMap<>();
        stats.put("strategy", Map.of("volatility", strategyDaily.volatility(), "maxDrawdown", strategyDaily.maxDrawdown()));
        stats.put("benchmark", Map.of("volatility", benchmarkDaily.volatility(), "maxDrawdown", benchmarkDaily.maxDrawdown()));
        if (includeSp500) {
            stats.put("sp500", Map.of("volatility", sp500Daily.volatility(), "maxDrawdown", sp500Daily.maxDrawdown()));
        }
        if (includeMsciWorld) {
            stats.put("msciWorld", Map.of("volatility", msciDaily.volatility(), "maxDrawdown", msciDaily.maxDrawdown()));
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("perYear", perYear);
        result.put("cumulative", cumulative);
        result.put("sp500Available", includeSp500);
        result.put("msciWorldAvailable", includeMsciWorld);
        result.put("stats", stats);
        return result;
    }

    /** volatility: annualized stdev of the chronological daily-return series. maxDrawdown: worst
     * peak-to-trough over the SAME continuous daily wealth curve (built once, used for both —
     * see buildDailySeries). maxDrawdownByYear: that curve's running drawdown as of each
     * year-end, i.e. what the per-year table columns show. */
    private record DailySeries(double volatility, double maxDrawdown, Map<Integer, Double> maxDrawdownByYear) {}

    /**
     * Builds ONE continuous, chronologically-ordered daily wealth curve for a series (top
     * quartile for "strategy", the whole covered universe for "benchmark", SPY/URTH for the
     * fixed lines) across every year, compounding real daily returns during each year's
     * holding period (day after the signal window ends, through Dec 31). Between one year's
     * holding period and the next year's, wealth is held FLAT — the strategy isn't invested
     * during the signal window itself (that's the whole point of "buy at the end of it, not
     * before"), so there's nothing for it to gain or lose there. A day's portfolio return is
     * the simple average of its constituents' own daily returns (equal weight, rebalanced
     * daily). Computing volatility and drawdown off this ONE ordered series (instead of a
     * year-end-only snapshot) is what lets a mid-year dip that fully recovers by December
     * actually show up as a drawdown.
     */
    private DailySeries buildDailySeries(List<Integer> years, java.util.function.Function<Integer, List<String>> basketForYear,
                                          Map<String, NavigableMap<LocalDate, BigDecimal>> closesByTicker,
                                          int startMonth, int lengthMonths) {
        List<Double> allDailyReturns = new ArrayList<>();
        double wealth = 1.0;
        double peak = 1.0;
        double maxDrawdown = 0.0;
        Map<Integer, Double> maxDrawdownByYear = new LinkedHashMap<>();

        for (int year : years) {
            List<String> basket = basketForYear.apply(year);
            LocalDate windowStart = LocalDate.of(year, startMonth, 1);
            LocalDate windowEnd = windowStart.plusMonths(lengthMonths).minusDays(1);
            LocalDate holdStart = windowEnd.plusDays(1);
            LocalDate holdEnd = LocalDate.of(year, 12, 31);

            if (basket != null && !basket.isEmpty() && holdStart.isBefore(holdEnd)) {
                List<Double> dailyReturns = portfolioDailyReturns(basket, closesByTicker, holdStart, holdEnd);
                allDailyReturns.addAll(dailyReturns);
                for (double r : dailyReturns) {
                    wealth *= 1.0 + r;
                    peak = Math.max(peak, wealth);
                    maxDrawdown = Math.min(maxDrawdown, (wealth - peak) / peak);
                }
            }
            maxDrawdownByYear.put(year, maxDrawdown); // snapshot as of this year-end either way
        }

        return new DailySeries(annualizedVolFromDaily(allDailyReturns), maxDrawdown, maxDrawdownByYear);
    }

    /** Equal-weighted daily portfolio returns over [from, to], using the first ticker's trading
     * calendar as the reference dates (all this app's tickers are US-listed ETFs sharing
     * essentially the same NYSE calendar — a reasonable simplification, not perfect). */
    private List<Double> portfolioDailyReturns(List<String> tickers, Map<String, NavigableMap<LocalDate, BigDecimal>> closesByTicker,
                                                LocalDate from, LocalDate to) {
        if (tickers.isEmpty()) return List.of();
        NavigableMap<LocalDate, BigDecimal> reference = closesByTicker.get(tickers.get(0));
        if (reference == null || reference.isEmpty()) return List.of();
        List<LocalDate> dates = new ArrayList<>(reference.subMap(from, true, to, true).keySet());

        List<Double> portfolioReturns = new ArrayList<>();
        for (int i = 1; i < dates.size(); i++) {
            LocalDate prev = dates.get(i - 1);
            LocalDate curr = dates.get(i);
            double sum = 0;
            int count = 0;
            for (String ticker : tickers) {
                NavigableMap<LocalDate, BigDecimal> closes = closesByTicker.get(ticker);
                if (closes == null) continue;
                BigDecimal p0 = closes.get(prev);
                BigDecimal p1 = closes.get(curr);
                if (p0 == null || p1 == null || p0.signum() == 0) continue;
                sum += p1.subtract(p0).divide(p0, MathContext.DECIMAL64).doubleValue();
                count++;
            }
            if (count > 0) portfolioReturns.add(sum / count);
        }
        return portfolioReturns;
    }

    private static final double TRADING_DAYS_PER_YEAR = 252.0;

    private double annualizedVolFromDaily(List<Double> dailyReturns) {
        if (dailyReturns.size() < 2) return 0.0;
        double mean = dailyReturns.stream().mapToDouble(d -> d).average().orElse(0);
        double variance = dailyReturns.stream().mapToDouble(r -> Math.pow(r - mean, 2)).sum() / (dailyReturns.size() - 1);
        return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR);
    }
}
