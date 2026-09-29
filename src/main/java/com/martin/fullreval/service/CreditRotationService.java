package com.martin.fullreval.service;

import com.martin.fullreval.dto.CreditRotationRequest;
import com.martin.fullreval.dto.CreditRotationSweepRequest;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.math.MathContext;
import java.time.DayOfWeek;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NavigableMap;
import java.util.TreeMap;

/**
 * "Credit rotation" tactical strategy: sit in investment-grade corporate bonds until a chosen
 * macro reading signals elevated credit stress, then rotate 100% into high-yield corporate bonds
 * until conditions calm back down — the same day-by-day state machine as VixTimingService
 * (cash/S&P 500), generalized to a different pair of holdings and a choice of SEVEN candidate
 * trigger series instead of one hardcoded VIX.
 *
 * Instruments — 100% real funds, native currency, NO currency conversion for either leg:
 *   - USD: VWEHX (Vanguard High-Yield Corporate) and VWESX (Vanguard Long-Term Investment-Grade),
 *     real daily data since 2000-01 (Yahoo Finance).
 *   - EUR: Candriam Bonds Euro High Yield (LU0012119607.EUFUND, real daily NAV since 1999-12-28)
 *     and DPAM Bonds L - Corporate EUR (LU0029260675.EUFUND, real daily NAV since 2000-01-03),
 *     both real EUR-denominated, capitalisation (income-reinvesting) share classes — via EODHD's
 *     EUFUND dataset (EodhdClient), since Yahoo Finance's free API caps EVERY European mutual
 *     fund's history to the last ~3-4 years regardless of the fund's real age (verified against
 *     15+ candidates from major houses — Nordea, Allianz, Robeco, JPMorgan, PIMCO, abrdn — all
 *     capped; EODHD's EUFUND feed carries the real multi-decade history instead).
 * Both currencies therefore have their own fully independent, fully real track record over
 * (almost) the same window — no FX bridge, no synthetic proxy, for either the HY or the IG leg.
 * The S&P 500 REFERENCE line (not one of the strategy's actual choices) is the one exception:
 * its EUR column is still a real FX-converted USD return, since chasing a decades-old EUR-native
 * S&P 500 equivalent isn't worth it for a line that's only shown for context.
 *
 * Candidate features: the same 6 macro series SeasonalityService's asset-split search already
 * uses (inflation YoY, growth YoY, 10Y rate level, 10Y rate change YoY, yield curve slope, VIX),
 * plus a 7th added here specifically for credit: BAA10Y (Moody's Baa corporate bond yield minus
 * the 10Y Treasury yield). This is a proxy, not true high-yield OAS — FRED's real HY OAS series
 * (BAMLH0A0HYM2) is license-capped to ~3 years on the free endpoint, useless for a 20+ year
 * backtest — but BAA10Y is itself a standard, long-history (since 1986) credit-stress indicator
 * (the same kind of series the NY Fed uses in its own recession-probability models).
 *
 * Direction convention: EVERY candidate feature uses the same "enter HY when the reading is HIGH,
 * exit to IG when it's LOW" rule as VixTimingService's enterVix/exitVix (itself a contrarian
 * buy-the-fear-index pattern already found to work there) — kept identical across features
 * rather than hand-picking a "sensible" direction per feature, so the sweep below is free to
 * discover whichever combination actually worked historically instead of confirming a prior.
 *
 * Look-ahead avoidance: same rule as everywhere else in this project — each day's position, and
 * each day's feature reading, is decided from the PRIOR trading day's published value, never the
 * same day's.
 *
 * Prices: USD legs use YahooFinanceService.fetchAdjustedDailyCloses (dividend/coupon-adjusted —
 * bond fund returns are dominated by distributions, not price appreciation, so raw close would
 * be meaningless here). EUR legs use EodhdClient, whose NAV series are already total-return
 * (capitalisation share classes reinvest income directly into the NAV, confirmed by their smooth
 * compounding — no periodic ex-distribution drops in the raw series).
 */
@Service
public class CreditRotationService {

    private static final int TRADING_DAYS_PER_YEAR = 252;
    private static final String HY_TICKER = "VWEHX"; // Vanguard High-Yield Corporate — real USD data since 2000-01
    private static final String IG_TICKER = "VWESX"; // Vanguard Long-Term Investment-Grade — real USD data since 2000-01
    private static final String HY_EUR_TICKER = "LU0012119607.EUFUND"; // Candriam Bonds Euro High Yield — real EUR data since 1999-12-28
    private static final String IG_EUR_TICKER = "LU0029260675.EUFUND"; // DPAM Bonds L - Corporate EUR — real EUR data since 2000-01-03
    private static final String SPY_TICKER = "SPY";

    private static final String CPI_ID = "CPIAUCSL";
    private static final String INDPRO_ID = "INDPRO";
    private static final String DGS10_ID = "DGS10";
    private static final String CURVE_ID = "T10Y2Y";
    private static final String VIX_ID = "VIXCLS";
    private static final String CREDIT_SPREAD_ID = "BAA10Y";

    /** label: shown in the UI. transform: how the raw FRED series becomes a daily-readable
     * feature value — LEVEL uses the published value as-is, YOY/CHANGE derive it from the same
     * series one year earlier (see buildFeatureSeries). */
    public record FeatureMeta(String key, String label, String seriesId, String transform) {}

    public static final List<FeatureMeta> FEATURES = List.of(
            new FeatureMeta("CREDIT_SPREAD", "Credit spread (Baa − 10Y Treasury)", CREDIT_SPREAD_ID, "LEVEL"),
            new FeatureMeta("VIX", "VIX (CBOE Volatility Index)", VIX_ID, "LEVEL"),
            new FeatureMeta("YIELD_CURVE", "Yield curve slope (10Y − 2Y)", CURVE_ID, "LEVEL"),
            new FeatureMeta("RATE_LEVEL", "10-Year Treasury yield", DGS10_ID, "LEVEL"),
            new FeatureMeta("RATE_CHANGE", "10-Year yield, change vs. a year ago", DGS10_ID, "CHANGE"),
            new FeatureMeta("INFLATION", "Inflation (YoY, CPI)", CPI_ID, "YOY"),
            new FeatureMeta("GROWTH", "Growth (YoY, Industrial Production)", INDPRO_ID, "YOY")
    );

    private final FredClient fredClient;
    private final YahooFinanceService yahooFinanceService;
    private final EodhdClient eodhdClient;
    private final FxRateService fxRateService;

    public CreditRotationService(FredClient fredClient, YahooFinanceService yahooFinanceService,
                                  EodhdClient eodhdClient, FxRateService fxRateService) {
        this.fredClient = fredClient;
        this.yahooFinanceService = yahooFinanceService;
        this.eodhdClient = eodhdClient;
        this.fxRateService = fxRateService;
    }

    @SuppressWarnings("unchecked")
    private NavigableMap<LocalDate, BigDecimal> usdPerEur() {
        return (NavigableMap<LocalDate, BigDecimal>) fxRateService.getUsdPerLocal("EUR");
    }

    /** Bundles the five price series (USD HY/IG, EUR HY/IG, SPY reference) plus the EUR/USD spot
     * rate that every request needs — built once per request/sweep instead of duplicating this
     * fetch logic in both runBacktest and sweep. */
    private record Instruments(NavigableMap<LocalDate, BigDecimal> hyUsd, NavigableMap<LocalDate, BigDecimal> igUsd,
                                NavigableMap<LocalDate, BigDecimal> hyEur, NavigableMap<LocalDate, BigDecimal> igEur,
                                NavigableMap<LocalDate, BigDecimal> spy, NavigableMap<LocalDate, BigDecimal> usdPerEur) {}

    private Instruments loadInstruments() {
        NavigableMap<LocalDate, BigDecimal> hyUsd = yahooFinanceService.fetchAdjustedDailyCloses(HY_TICKER);
        NavigableMap<LocalDate, BigDecimal> igUsd = yahooFinanceService.fetchAdjustedDailyCloses(IG_TICKER);
        NavigableMap<LocalDate, BigDecimal> hyEur = eodhdClient.fetchDailyCloses(HY_EUR_TICKER);
        NavigableMap<LocalDate, BigDecimal> igEur = eodhdClient.fetchDailyCloses(IG_EUR_TICKER);
        NavigableMap<LocalDate, BigDecimal> spy = yahooFinanceService.fetchAdjustedDailyCloses(SPY_TICKER);
        return new Instruments(hyUsd, igUsd, hyEur, igEur, spy, usdPerEur());
    }

    private List<LocalDate> tradingDaysFor(Instruments inst, int yearFrom, int yearTo) {
        LocalDate rangeStart = LocalDate.of(yearFrom, 1, 1);
        LocalDate today = LocalDate.now();
        LocalDate rangeEnd = yearTo >= today.getYear() ? today : LocalDate.of(yearTo, 12, 31);
        List<LocalDate> tradingDays = new ArrayList<>(inst.hyUsd().subMap(rangeStart, true, rangeEnd, true).keySet());
        tradingDays.removeIf(d -> !inst.igUsd().containsKey(d)); // both legs must have a real price that day
        return tradingDays;
    }

    public Map<String, Object> runBacktest(CreditRotationRequest req) {
        if (req.yearFrom > req.yearTo) {
            throw new IllegalArgumentException("yearFrom must be <= yearTo");
        }
        if (req.exitThreshold >= req.enterThreshold) {
            throw new IllegalArgumentException("exitThreshold must be lower than enterThreshold");
        }
        FeatureMeta meta = featureMeta(req.feature);
        Instruments inst = loadInstruments();
        if (inst.hyEur().isEmpty() || inst.igEur().isEmpty()) {
            throw new IllegalStateException("EODHD EUR fund data unavailable (missing/invalid EODHD_API_KEY, or EODHD unreachable)");
        }
        NavigableMap<LocalDate, Double> feature = buildFeatureSeries(meta);

        List<LocalDate> tradingDays = tradingDaysFor(inst, req.yearFrom, req.yearTo);
        if (tradingDays.size() < 2) {
            throw new IllegalStateException("Not enough " + HY_TICKER + "/" + IG_TICKER + " data for "
                    + req.yearFrom + "-" + req.yearTo + " (data starts " + inst.hyUsd().firstKey() + ")");
        }

        Map<String, Object> result = simulate(tradingDays, inst, feature, req.enterThreshold, req.exitThreshold);
        Map<String, Object> reqMeta = new LinkedHashMap<>();
        reqMeta.put("yearFrom", req.yearFrom);
        reqMeta.put("yearTo", req.yearTo);
        reqMeta.put("feature", meta.key());
        reqMeta.put("featureLabel", meta.label());
        reqMeta.put("enterThreshold", req.enterThreshold);
        reqMeta.put("exitThreshold", req.exitThreshold);
        reqMeta.put("hyTicker", HY_TICKER);
        reqMeta.put("igTicker", IG_TICKER);
        reqMeta.put("hyEurTicker", HY_EUR_TICKER);
        reqMeta.put("igEurTicker", IG_EUR_TICKER);
        reqMeta.put("hyEurDataStart", inst.hyEur().firstKey().toString());
        reqMeta.put("igEurDataStart", inst.igEur().firstKey().toString());
        reqMeta.put("tradingDays", tradingDays.size());
        reqMeta.put("dataStart", inst.hyUsd().firstKey().toString());
        result.put("meta", reqMeta);
        return result;
    }

    /** For each of the 7 candidate features, grid-searches enter/exit threshold pairs (a
     * percentile-based grid over that feature's OWN historical distribution within the requested
     * range, so the grid is meaningful regardless of the feature's scale) and ranks every
     * combination tried — same "test everything, rank by performance" spirit as Seasonality's
     * Monte Carlo combinatorial sweep, applied to this continuous strategy instead of the yearly
     * one. Returns the top 20 combinations plus the single best; every row reports both USD and
     * EUR figures, ranking uses whichever req.rankCurrency picked. */
    public Map<String, Object> sweep(CreditRotationSweepRequest req) {
        if (req.yearFrom > req.yearTo) {
            throw new IllegalArgumentException("yearFrom must be <= yearTo");
        }
        String rankCurrency = req.rankCurrency == null ? "USD" : req.rankCurrency.toUpperCase();
        if (!rankCurrency.equals("USD") && !rankCurrency.equals("EUR")) {
            throw new IllegalArgumentException("rankCurrency must be USD or EUR");
        }
        Instruments inst = loadInstruments();
        if (inst.hyEur().isEmpty() || inst.igEur().isEmpty()) {
            throw new IllegalStateException("EODHD EUR fund data unavailable (missing/invalid EODHD_API_KEY, or EODHD unreachable)");
        }
        List<LocalDate> tradingDays = tradingDaysFor(inst, req.yearFrom, req.yearTo);
        if (tradingDays.size() < 2) {
            throw new IllegalStateException("Not enough " + HY_TICKER + "/" + IG_TICKER + " data for " + req.yearFrom + "-" + req.yearTo);
        }

        double[] enterPercentiles = {50, 60, 70, 75, 80, 85, 90, 95};
        double[] exitPercentiles = {5, 10, 15, 20, 25, 30, 40, 50};

        List<Map<String, Object>> allResults = new ArrayList<>();
        for (FeatureMeta meta : FEATURES) {
            NavigableMap<LocalDate, Double> feature = buildFeatureSeries(meta);
            List<Double> inRangeValues = new ArrayList<>();
            for (LocalDate d : tradingDays) {
                Map.Entry<LocalDate, Double> e = feature.floorEntry(d);
                if (e != null) inRangeValues.add(e.getValue());
            }
            if (inRangeValues.isEmpty()) continue;
            inRangeValues.sort(Double::compareTo);

            for (double ep : enterPercentiles) {
                double enterThreshold = percentile(inRangeValues, ep / 100.0);
                for (double xp : exitPercentiles) {
                    if (xp >= ep) continue;
                    double exitThreshold = percentile(inRangeValues, xp / 100.0);
                    if (exitThreshold >= enterThreshold) continue;

                    Map<String, Object> sim = simulate(tradingDays, inst, feature, enterThreshold, exitThreshold);
                    @SuppressWarnings("unchecked")
                    Map<String, Object> statsByCcy = (Map<String, Object>) sim.get("stats");
                    @SuppressWarnings("unchecked")
                    Map<String, Object> usdStrategy = (Map<String, Object>) ((Map<String, Object>) statsByCcy.get("usd")).get("strategy");
                    @SuppressWarnings("unchecked")
                    Map<String, Object> eurStrategy = (Map<String, Object>) ((Map<String, Object>) statsByCcy.get("eur")).get("strategy");
                    Map<String, Object> rankStrategy = rankCurrency.equals("EUR") ? eurStrategy : usdStrategy;
                    double rankCagr = (double) rankStrategy.get("cagr");
                    double rankVol = (double) rankStrategy.get("volatility");
                    double riskAdjusted = rankVol > 0 ? rankCagr / rankVol : 0.0;

                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("feature", meta.key());
                    row.put("featureLabel", meta.label());
                    row.put("enterThreshold", enterThreshold);
                    row.put("exitThreshold", exitThreshold);
                    row.put("usd", usdStrategy);
                    row.put("eur", eurStrategy);
                    row.put("riskAdjusted", riskAdjusted);
                    row.put("tradesCount", sim.get("tradesCount"));
                    allResults.add(row);
                }
            }
        }

        String rankBy = req.rankBy == null ? "RISK_ADJUSTED" : req.rankBy;
        allResults.sort((a, b) -> Double.compare(rankValue(b, rankBy, rankCurrency), rankValue(a, rankBy, rankCurrency)));

        Map<String, Object> result = new LinkedHashMap<>();
        Map<String, Object> reqMeta = new LinkedHashMap<>();
        reqMeta.put("yearFrom", req.yearFrom);
        reqMeta.put("yearTo", req.yearTo);
        reqMeta.put("rankBy", rankBy);
        reqMeta.put("rankCurrency", rankCurrency);
        reqMeta.put("combinationsTested", allResults.size());
        result.put("meta", reqMeta);
        result.put("top", allResults.subList(0, Math.min(20, allResults.size())));
        result.put("best", allResults.isEmpty() ? null : allResults.get(0));
        return result;
    }

    @SuppressWarnings("unchecked")
    private double rankValue(Map<String, Object> row, String rankBy, String rankCurrency) {
        if (rankBy.equals("RISK_ADJUSTED")) return (double) row.get("riskAdjusted");
        Map<String, Object> ccy = (Map<String, Object>) row.get(rankCurrency.equals("EUR") ? "eur" : "usd");
        return switch (rankBy) {
            case "CAGR" -> (double) ccy.get("cagr");
            case "TOTAL_RETURN" -> (double) ccy.get("totalReturn");
            default -> (double) row.get("riskAdjusted");
        };
    }

    private double percentile(List<Double> sortedAsc, double p) {
        int idx = (int) Math.floor(p * (sortedAsc.size() - 1));
        return sortedAsc.get(Math.max(0, Math.min(sortedAsc.size() - 1, idx)));
    }

    /** The actual day-by-day simulation shared by runBacktest and sweep — everything above this
     * just decides WHICH feature/thresholds to feed it. The USD and EUR wealth curves are tracked
     * in parallel for every series (strategy/HY/IG/SPY): the day-by-day HOLD decision is
     * currency-blind (driven only by the feature reading), so a single pass over the trading days
     * produces both currencies' numbers. Both HY and IG legs read their EUR return directly off
     * their own real EUR fund's price series (zero FX conversion); only the SPY reference line
     * still converts its EUR figure from the USD return. */
    private Map<String, Object> simulate(List<LocalDate> tradingDays, Instruments inst,
                                          NavigableMap<LocalDate, Double> feature, double enterThreshold, double exitThreshold) {
        NavigableMap<LocalDate, BigDecimal> hyUsd = inst.hyUsd(), igUsd = inst.igUsd();
        NavigableMap<LocalDate, BigDecimal> hyEur = inst.hyEur(), igEur = inst.igEur();
        NavigableMap<LocalDate, BigDecimal> spy = inst.spy(), usdPerEur = inst.usdPerEur();

        Double f0 = floorValue(feature, tradingDays.get(0));
        boolean inHY = f0 != null && f0 >= enterThreshold;

        Ledger strategy = new Ledger();
        Ledger hyLedger = new Ledger();
        Ledger igLedger = new Ledger();
        Ledger spyLedger = new Ledger();
        int daysInHY = 0, daysInIG = 0;
        boolean includeSpy = !spy.isEmpty() && !spy.firstKey().isAfter(tradingDays.get(0));

        Map<Integer, Map<String, Object>> cumulativeByYear = new LinkedHashMap<>();
        // Weekly (Friday close, or whatever the last trading day of a short week is) wealth
        // snapshots — same fields as the yearly `cumulative` points, just far more of them, so the
        // frontend can plot the real week-to-week movement instead of a nearly straight line
        // between year-end dots. Coarser than a full daily curve on purpose: enough resolution to
        // see the shape of a drawdown or a rally without shipping ~6,500 points to the browser.
        List<Map<String, Object>> weekly = new ArrayList<>();
        List<Map<String, Object>> trades = new ArrayList<>();
        Map<String, Object> segment = openSegment(inHY, tradingDays.get(0), f0, inst);
        double segmentMultiplierUsd = 1.0, segmentMultiplierEur = 1.0;

        for (int i = 1; i < tradingDays.size(); i++) {
            LocalDate prevDay = tradingDays.get(i - 1);
            LocalDate day = tradingDays.get(i);

            double hyRetUsd = usdReturn(hyUsd, prevDay, day);
            double igRetUsd = usdReturn(igUsd, prevDay, day);
            double hyRetEur = eurFundReturn(hyEur, prevDay, day);
            double igRetEur = eurFundReturn(igEur, prevDay, day);
            double stratRetUsd = inHY ? hyRetUsd : igRetUsd;
            double stratRetEur = inHY ? hyRetEur : igRetEur;
            if (inHY) daysInHY++; else daysInIG++;
            segmentMultiplierUsd *= 1.0 + stratRetUsd;
            segmentMultiplierEur *= 1.0 + stratRetEur;

            strategy.accrue(stratRetUsd, stratRetEur);
            hyLedger.accrue(hyRetUsd, hyRetEur);
            igLedger.accrue(igRetUsd, igRetEur);

            if (includeSpy) {
                BigDecimal spyPrev = spy.get(prevDay), spyCur = spy.get(day);
                if (spyPrev != null && spyCur != null) {
                    double spyRetUsd = spyCur.subtract(spyPrev).divide(spyPrev, MathContext.DECIMAL64).doubleValue();
                    // SPY EUR stays FX-converted — it's only a contextual reference line, not one
                    // of the two assets the strategy actually chooses between.
                    double spyRetEur = fxAdjust(usdPerEur, prevDay, day, spyRetUsd);
                    spyLedger.accrue(spyRetUsd, spyRetEur);
                }
            }

            Map<String, Object> yearPoint = cumulativeByYear.computeIfAbsent(day.getYear(), y -> new LinkedHashMap<>(Map.of("year", y)));
            yearPoint.put("cumulativeStrategyUsd", strategy.wealthUsd - 1.0);
            yearPoint.put("cumulativeStrategyEur", strategy.wealthEur - 1.0);
            yearPoint.put("cumulativeHyUsd", hyLedger.wealthUsd - 1.0);
            yearPoint.put("cumulativeIgUsd", igLedger.wealthUsd - 1.0);
            if (includeSpy) {
                yearPoint.put("cumulativeSp500Usd", spyLedger.wealthUsd - 1.0);
                yearPoint.put("cumulativeSp500Eur", spyLedger.wealthEur - 1.0);
            }

            // Year-END boundary prices (overwritten every day, so by the time the loop moves to
            // the next year this holds the LAST trading day's values) — lets the frontend audit
            // the HY/IG/SPY "buy & hold" per-year returns down to the exact prices used, the same
            // way each trade in `trades` is already auditable. USD uses the exact daily calendar
            // (hyUsd/igUsd/spy all share tradingDays' own calendar); EUR uses floorEntry since the
            // EUR funds publish on their own calendar, same convention as eurFundReturn above.
            yearPoint.put("boundaryDate", day.toString());
            BigDecimal hyUsdPrice = hyUsd.get(day);
            if (hyUsdPrice != null) yearPoint.put("hyPriceUsd", hyUsdPrice.doubleValue());
            BigDecimal igUsdPrice = igUsd.get(day);
            if (igUsdPrice != null) yearPoint.put("igPriceUsd", igUsdPrice.doubleValue());
            Map.Entry<LocalDate, BigDecimal> hyEurEntry = hyEur.floorEntry(day);
            if (hyEurEntry != null) {
                yearPoint.put("hyPriceEur", hyEurEntry.getValue().doubleValue());
                yearPoint.put("hyPriceEurDate", hyEurEntry.getKey().toString());
            }
            Map.Entry<LocalDate, BigDecimal> igEurEntry = igEur.floorEntry(day);
            if (igEurEntry != null) {
                yearPoint.put("igPriceEur", igEurEntry.getValue().doubleValue());
                yearPoint.put("igPriceEurDate", igEurEntry.getKey().toString());
            }
            if (includeSpy) {
                BigDecimal spyPrice = spy.get(day);
                if (spyPrice != null) yearPoint.put("spPriceUsd", spyPrice.doubleValue());
            }

            boolean isLastDay = i == tradingDays.size() - 1;
            if (day.getDayOfWeek() == DayOfWeek.FRIDAY || isLastDay) {
                Map<String, Object> weekPoint = new LinkedHashMap<>();
                weekPoint.put("date", day.toString());
                weekPoint.put("cumulativeStrategyUsd", strategy.wealthUsd - 1.0);
                weekPoint.put("cumulativeStrategyEur", strategy.wealthEur - 1.0);
                weekPoint.put("cumulativeHyUsd", hyLedger.wealthUsd - 1.0);
                weekPoint.put("cumulativeIgUsd", igLedger.wealthUsd - 1.0);
                if (includeSpy) {
                    weekPoint.put("cumulativeSp500Usd", spyLedger.wealthUsd - 1.0);
                    weekPoint.put("cumulativeSp500Eur", spyLedger.wealthEur - 1.0);
                }
                weekly.add(weekPoint);
            }

            Double fToday = floorValue(feature, day);
            if (fToday != null && ((!inHY && fToday >= enterThreshold) || (inHY && fToday <= exitThreshold))) {
                inHY = !inHY;
                closeSegment(segment, day, fToday, segmentMultiplierUsd, segmentMultiplierEur, inst, false);
                trades.add(segment);
                segment = openSegment(inHY, day, fToday, inst);
                segmentMultiplierUsd = 1.0;
                segmentMultiplierEur = 1.0;
            }
        }
        LocalDate lastDay = tradingDays.get(tradingDays.size() - 1);
        closeSegment(segment, lastDay, floorValue(feature, lastDay), segmentMultiplierUsd, segmentMultiplierEur, inst, true);
        trades.add(segment);

        double yearsElapsed = ChronoUnit.DAYS.between(tradingDays.get(0), tradingDays.get(tradingDays.size() - 1)) / 365.25;

        // The price audit above needs an "entry" boundary for the FIRST year in range too — the
        // day right before the loop starts accruing returns (tradingDays.get(0) itself, since the
        // loop's first iteration computes day 1's return relative to it).
        LocalDate firstDay = tradingDays.get(0);
        Map<String, Object> firstPrices = new LinkedHashMap<>();
        firstPrices.put("date", firstDay.toString());
        BigDecimal hyUsd0 = hyUsd.get(firstDay);
        if (hyUsd0 != null) firstPrices.put("hyPriceUsd", hyUsd0.doubleValue());
        BigDecimal igUsd0 = igUsd.get(firstDay);
        if (igUsd0 != null) firstPrices.put("igPriceUsd", igUsd0.doubleValue());
        Map.Entry<LocalDate, BigDecimal> hyEur0 = hyEur.floorEntry(firstDay);
        if (hyEur0 != null) {
            firstPrices.put("hyPriceEur", hyEur0.getValue().doubleValue());
            firstPrices.put("hyPriceEurDate", hyEur0.getKey().toString());
        }
        Map.Entry<LocalDate, BigDecimal> igEur0 = igEur.floorEntry(firstDay);
        if (igEur0 != null) {
            firstPrices.put("igPriceEur", igEur0.getValue().doubleValue());
            firstPrices.put("igPriceEurDate", igEur0.getKey().toString());
        }
        if (includeSpy) {
            BigDecimal spy0 = spy.get(firstDay);
            if (spy0 != null) firstPrices.put("spPriceUsd", spy0.doubleValue());
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("cumulative", cumulativeByYear.values().stream().toList());
        result.put("weekly", weekly);
        result.put("firstPrices", firstPrices);
        result.put("spyAvailable", includeSpy);

        Map<String, Object> statsUsd = new LinkedHashMap<>();
        statsUsd.put("strategy", strategy.statBlockUsd(yearsElapsed));
        statsUsd.put("hy", hyLedger.statBlockUsd(yearsElapsed));
        statsUsd.put("ig", igLedger.statBlockUsd(yearsElapsed));
        if (includeSpy) statsUsd.put("spy", spyLedger.statBlockUsd(yearsElapsed));

        Map<String, Object> statsEur = new LinkedHashMap<>();
        statsEur.put("strategy", strategy.statBlockEur(yearsElapsed));
        statsEur.put("hy", hyLedger.statBlockEur(yearsElapsed));
        statsEur.put("ig", igLedger.statBlockEur(yearsElapsed));
        if (includeSpy) statsEur.put("spy", spyLedger.statBlockEur(yearsElapsed));

        Map<String, Object> stats = new LinkedHashMap<>();
        stats.put("usd", statsUsd);
        stats.put("eur", statsEur);
        result.put("stats", stats);

        result.put("trades", trades);
        result.put("tradesCount", (int) trades.stream().filter(t -> "HY".equals(t.get("type"))).count());
        result.put("daysInHy", daysInHY);
        result.put("daysInIg", daysInIG);
        result.put("pctTimeInHy", (daysInHY + daysInIG) == 0 ? 0.0 : (double) daysInHY / (daysInHY + daysInIG));
        return result;
    }

    /** Tracks wealth/peak/drawdown/daily-returns for one series in BOTH currencies at once. */
    private static final class Ledger {
        double wealthUsd = 1.0, peakUsd = 1.0, maxDDUsd = 0.0;
        double wealthEur = 1.0, peakEur = 1.0, maxDDEur = 0.0;
        final List<Double> dailyUsd = new ArrayList<>();
        final List<Double> dailyEur = new ArrayList<>();

        void accrue(double retUsd, double retEur) {
            wealthUsd *= 1.0 + retUsd;
            peakUsd = Math.max(peakUsd, wealthUsd);
            maxDDUsd = Math.min(maxDDUsd, (wealthUsd - peakUsd) / peakUsd);
            dailyUsd.add(retUsd);

            wealthEur *= 1.0 + retEur;
            peakEur = Math.max(peakEur, wealthEur);
            maxDDEur = Math.min(maxDDEur, (wealthEur - peakEur) / peakEur);
            dailyEur.add(retEur);
        }

        Map<String, Object> statBlockUsd(double yearsElapsed) {
            return statBlock(wealthUsd, maxDDUsd, dailyUsd, yearsElapsed);
        }

        Map<String, Object> statBlockEur(double yearsElapsed) {
            return statBlock(wealthEur, maxDDEur, dailyEur, yearsElapsed);
        }

        private static Map<String, Object> statBlock(double finalWealth, double maxDrawdown, List<Double> dailyReturns, double yearsElapsed) {
            double totalReturn = finalWealth - 1.0;
            double cagr = yearsElapsed <= 0 ? 0.0 : Math.pow(finalWealth, 1.0 / yearsElapsed) - 1.0;
            Map<String, Object> block = new LinkedHashMap<>();
            block.put("totalReturn", totalReturn);
            block.put("cagr", cagr);
            block.put("volatility", annualizedVolFromDaily(dailyReturns));
            block.put("maxDrawdown", maxDrawdown);
            return block;
        }

        private static double annualizedVolFromDaily(List<Double> dailyReturns) {
            if (dailyReturns.size() < 2) return 0.0;
            double mean = dailyReturns.stream().mapToDouble(d -> d).average().orElse(0);
            double variance = dailyReturns.stream().mapToDouble(r -> Math.pow(r - mean, 2)).sum() / (dailyReturns.size() - 1);
            return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR);
        }
    }

    private Map<String, Object> openSegment(boolean hy, LocalDate entryDate, Double featureAtEntry, Instruments inst) {
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("type", hy ? "HY" : "IG");
        s.put("entryDate", entryDate.toString());
        s.put("featureAtEntry", featureAtEntry);
        NavigableMap<LocalDate, BigDecimal> usdCloses = hy ? inst.hyUsd() : inst.igUsd();
        NavigableMap<LocalDate, BigDecimal> eurCloses = hy ? inst.hyEur() : inst.igEur();
        s.put("entryPrice", usdCloses.get(entryDate).doubleValue());
        Map.Entry<LocalDate, BigDecimal> eurEntry = eurCloses.floorEntry(entryDate);
        s.put("entryPriceEur", eurEntry == null ? null : eurEntry.getValue().doubleValue());
        return s;
    }

    private void closeSegment(Map<String, Object> segment, LocalDate exitDate, Double featureAtExit,
                               double multiplierUsd, double multiplierEur, Instruments inst, boolean open) {
        boolean isHy = "HY".equals(segment.get("type"));
        NavigableMap<LocalDate, BigDecimal> usdCloses = isHy ? inst.hyUsd() : inst.igUsd();
        NavigableMap<LocalDate, BigDecimal> eurCloses = isHy ? inst.hyEur() : inst.igEur();
        String dateKey = open ? "asOfDate" : "exitDate";
        segment.put(dateKey, exitDate.toString());
        if (!open) segment.put("featureAtExit", featureAtExit);
        segment.put(open ? "asOfPrice" : "exitPrice", usdCloses.get(exitDate).doubleValue());
        Map.Entry<LocalDate, BigDecimal> eurExit = eurCloses.floorEntry(exitDate);
        segment.put(open ? "asOfPriceEur" : "exitPriceEur", eurExit == null ? null : eurExit.getValue().doubleValue());
        segment.put("tradeReturnUsd", multiplierUsd - 1.0);
        segment.put("tradeReturnEur", multiplierEur - 1.0);
        segment.put("open", open);
    }

    /** A real EUR fund's own return over [prevDay, day], using the last PUBLISHED NAV on or
     * before each date (floorEntry) rather than requiring an exact match — the fund publishes on
     * its own (European) calendar, not the US trading-day calendar this loop iterates over, so an
     * exact-date lookup would silently miss real price movement on every US/EU holiday mismatch
     * (verified: this originally made the EUR leg's return look artificially small, since each
     * mismatched day fell back to a hardcoded 0% instead of ever seeing the fund's real move).
     * floorEntry instead just attributes the fund's real move to whichever day its NAV actually
     * updates — no return is ever silently dropped, only its exact day-of-attribution shifts by a
     * day or two around a holiday. */
    private double eurFundReturn(NavigableMap<LocalDate, BigDecimal> eurCloses, LocalDate prevDay, LocalDate day) {
        Map.Entry<LocalDate, BigDecimal> e0 = eurCloses.floorEntry(prevDay);
        Map.Entry<LocalDate, BigDecimal> e1 = eurCloses.floorEntry(day);
        if (e0 == null || e1 == null) return 0.0;
        BigDecimal p0 = e0.getValue(), p1 = e1.getValue();
        if (p0.signum() == 0) return 0.0;
        return p1.subtract(p0).divide(p0, MathContext.DECIMAL64).doubleValue();
    }

    /** A EUR investor converts EUR→USD to buy a USD asset and back on the way out, so their
     * return also carries the EUR/USD move: ret_eur = (fx0/fx1) × (1+ret_usd) − 1, where fx is
     * "USD per 1 EUR". Same formula as VixTimingService's fxAdjust. Only used for the SPY
     * reference line now — both real strategy legs use eurFundReturn instead. Falls back to the
     * USD return unchanged if a quote is missing for either day. */
    private double fxAdjust(NavigableMap<LocalDate, BigDecimal> usdPerEur, LocalDate prevDay, LocalDate day, double usdReturn) {
        Double fx0 = floorFxValue(usdPerEur, prevDay);
        Double fx1 = floorFxValue(usdPerEur, day);
        if (fx0 == null || fx1 == null) return usdReturn;
        return (fx0 / fx1) * (1.0 + usdReturn) - 1.0;
    }

    private Double floorFxValue(NavigableMap<LocalDate, BigDecimal> series, LocalDate asOf) {
        Map.Entry<LocalDate, BigDecimal> e = series.floorEntry(asOf);
        return e == null ? null : e.getValue().doubleValue();
    }

    private double usdReturn(NavigableMap<LocalDate, BigDecimal> closes, LocalDate prevDay, LocalDate day) {
        BigDecimal p0 = closes.get(prevDay), p1 = closes.get(day);
        return p1.subtract(p0).divide(p0, MathContext.DECIMAL64).doubleValue();
    }

    private Double floorValue(NavigableMap<LocalDate, Double> series, LocalDate asOf) {
        Map.Entry<LocalDate, Double> e = series.floorEntry(asOf);
        return e == null ? null : e.getValue();
    }

    private FeatureMeta featureMeta(String key) {
        return FEATURES.stream().filter(f -> f.key().equals(key)).findFirst()
                .orElseThrow(() -> new IllegalArgumentException("Unknown feature: " + key));
    }

    /** Builds a daily-readable derived series for one candidate feature. LEVEL features are the
     * raw FRED series as-is; YOY/CHANGE features are computed once per raw observation date
     * (using that same series' own value ~1 year earlier via floorEntry) rather than recomputed
     * per trading day, since the backtest loop above does its own floorEntry lookup into
     * whatever map this returns. */
    @SuppressWarnings("unchecked")
    private NavigableMap<LocalDate, Double> buildFeatureSeries(FeatureMeta meta) {
        NavigableMap<LocalDate, BigDecimal> raw = (NavigableMap<LocalDate, BigDecimal>) fredClient.fetchSeries(meta.seriesId());
        NavigableMap<LocalDate, Double> derived = new TreeMap<>();
        if (meta.transform().equals("LEVEL")) {
            raw.forEach((date, value) -> derived.put(date, value.doubleValue()));
            return derived;
        }
        // YOY (fractional % change) or CHANGE (level difference), both vs. ~1 year earlier.
        for (Map.Entry<LocalDate, BigDecimal> e : raw.entrySet()) {
            LocalDate date = e.getKey();
            Map.Entry<LocalDate, BigDecimal> prior = raw.floorEntry(date.minusYears(1));
            if (prior == null) continue;
            double curVal = e.getValue().doubleValue();
            double priorVal = prior.getValue().doubleValue();
            if (meta.transform().equals("YOY")) {
                if (priorVal == 0.0) continue;
                derived.put(date, (curVal - priorVal) / priorVal);
            } else { // CHANGE
                derived.put(date, curVal - priorVal);
            }
        }
        return derived;
    }
}
