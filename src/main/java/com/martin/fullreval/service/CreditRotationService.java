package com.martin.fullreval.service;

import com.martin.fullreval.dto.CreditRotationRequest;
import com.martin.fullreval.dto.CreditRotationSweepRequest;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.math.MathContext;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NavigableMap;
import java.util.TreeMap;

/**
 * "Credit rotation" tactical strategy: sit in investment-grade corporate bonds (LQD) until a
 * chosen macro reading signals elevated credit stress, then rotate 100% into high-yield
 * corporate bonds (HYG) until conditions calm back down — the same day-by-day state machine as
 * VixTimingService (cash/S&P 500), generalized to a different pair of holdings and a choice of
 * SEVEN candidate trigger series instead of one hardcoded VIX.
 *
 * Tickers: HYG (iShares iBoxx $ High Yield Corporate Bond ETF, since 2007-05) and LQD (iShares
 * iBoxx $ Investment Grade Corporate Bond ETF, since 2002-08, naturally trimmed to HYG's start
 * by the trading-day intersection below) — the longest-history liquid HY/IG pair available; true
 * short-duration HY funds (SJNK, SHYG) only start in 2012-2013, too short for this kind of test.
 *
 * Candidate features: the same 6 macro series SeasonalityService's asset-split search already
 * uses (inflation YoY, growth YoY, 10Y rate level, 10Y rate change YoY, yield curve slope, VIX),
 * plus a 7th added here specifically for credit: BAA10Y (Moody's Baa corporate bond yield minus
 * the 10Y Treasury yield). This is a proxy, not true high-yield OAS — FRED's real HY OAS series
 * (BAMLH0A0HYM2) is license-capped to ~3 years on the free endpoint, useless for a 20-year
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
 * Prices: unlike every other equity-momentum backtest in this project (which use raw close —
 * a fine approximation when dividends are a small share of total return), this service uses
 * YahooFinanceService.fetchAdjustedDailyCloses — Yahoo's dividend/coupon-ADJUSTED close — for
 * HYG, LQD, and the SPY benchmark. Bond ETF returns are dominated by their distributions, not
 * price appreciation: HYG's raw price alone actually trends DOWN over its history even though
 * its real total return is strongly positive, so raw close would have made this whole strategy
 * meaningless.
 */
@Service
public class CreditRotationService {

    private static final int TRADING_DAYS_PER_YEAR = 252;
    private static final String HY_TICKER = "HYG";
    private static final String IG_TICKER = "LQD";
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
    private final FxRateService fxRateService;

    public CreditRotationService(FredClient fredClient, YahooFinanceService yahooFinanceService, FxRateService fxRateService) {
        this.fredClient = fredClient;
        this.yahooFinanceService = yahooFinanceService;
        this.fxRateService = fxRateService;
    }

    private String normalizeCurrency(String currency) {
        String c = currency == null ? "USD" : currency.toUpperCase();
        if (!c.equals("USD") && !c.equals("EUR")) {
            throw new IllegalArgumentException("currency must be USD or EUR");
        }
        return c;
    }

    @SuppressWarnings("unchecked")
    private NavigableMap<LocalDate, BigDecimal> usdPerEurFor(String currency) {
        return currency.equals("EUR") ? (NavigableMap<LocalDate, BigDecimal>) fxRateService.getUsdPerLocal("EUR") : null;
    }

    @SuppressWarnings("unchecked")
    public Map<String, Object> runBacktest(CreditRotationRequest req) {
        if (req.yearFrom > req.yearTo) {
            throw new IllegalArgumentException("yearFrom must be <= yearTo");
        }
        if (req.exitThreshold >= req.enterThreshold) {
            throw new IllegalArgumentException("exitThreshold must be lower than enterThreshold");
        }
        String currency = normalizeCurrency(req.currency);
        FeatureMeta meta = featureMeta(req.feature);

        NavigableMap<LocalDate, BigDecimal> hy = yahooFinanceService.fetchAdjustedDailyCloses(HY_TICKER);
        NavigableMap<LocalDate, BigDecimal> ig = yahooFinanceService.fetchAdjustedDailyCloses(IG_TICKER);
        NavigableMap<LocalDate, BigDecimal> spy = yahooFinanceService.fetchAdjustedDailyCloses(SPY_TICKER);
        NavigableMap<LocalDate, BigDecimal> usdPerEur = usdPerEurFor(currency);
        NavigableMap<LocalDate, Double> feature = buildFeatureSeries(meta);

        LocalDate rangeStart = LocalDate.of(req.yearFrom, 1, 1);
        LocalDate today = LocalDate.now();
        LocalDate rangeEnd = req.yearTo >= today.getYear() ? today : LocalDate.of(req.yearTo, 12, 31);

        List<LocalDate> tradingDays = new ArrayList<>(hy.subMap(rangeStart, true, rangeEnd, true).keySet());
        tradingDays.removeIf(d -> !ig.containsKey(d)); // both legs must have a real price that day
        if (tradingDays.size() < 2) {
            throw new IllegalStateException("Not enough HYG/LQD data for " + req.yearFrom + "-" + req.yearTo
                    + " (HYG only goes back to " + hy.firstKey() + ")");
        }

        Map<String, Object> result = simulate(tradingDays, hy, ig, spy, usdPerEur, feature, req.enterThreshold, req.exitThreshold);
        Map<String, Object> reqMeta = new LinkedHashMap<>();
        reqMeta.put("yearFrom", req.yearFrom);
        reqMeta.put("yearTo", req.yearTo);
        reqMeta.put("currency", currency);
        reqMeta.put("feature", meta.key());
        reqMeta.put("featureLabel", meta.label());
        reqMeta.put("enterThreshold", req.enterThreshold);
        reqMeta.put("exitThreshold", req.exitThreshold);
        reqMeta.put("hyTicker", HY_TICKER);
        reqMeta.put("igTicker", IG_TICKER);
        reqMeta.put("tradingDays", tradingDays.size());
        reqMeta.put("dataStart", hy.firstKey().toString());
        result.put("meta", reqMeta);
        return result;
    }

    /** For each of the 7 candidate features, grid-searches enter/exit threshold pairs (a
     * percentile-based grid over that feature's OWN historical distribution within the requested
     * range, so the grid is meaningful regardless of the feature's scale) and ranks every
     * combination tried — same "test everything, rank by performance" spirit as Seasonality's
     * Monte Carlo combinatorial sweep, applied to this continuous strategy instead of the yearly
     * one. Returns the top 20 combinations plus the single best. */
    public Map<String, Object> sweep(CreditRotationSweepRequest req) {
        if (req.yearFrom > req.yearTo) {
            throw new IllegalArgumentException("yearFrom must be <= yearTo");
        }
        String currency = normalizeCurrency(req.currency);
        NavigableMap<LocalDate, BigDecimal> hy = yahooFinanceService.fetchAdjustedDailyCloses(HY_TICKER);
        NavigableMap<LocalDate, BigDecimal> ig = yahooFinanceService.fetchAdjustedDailyCloses(IG_TICKER);
        NavigableMap<LocalDate, BigDecimal> spy = yahooFinanceService.fetchAdjustedDailyCloses(SPY_TICKER);
        NavigableMap<LocalDate, BigDecimal> usdPerEur = usdPerEurFor(currency);

        LocalDate rangeStart = LocalDate.of(req.yearFrom, 1, 1);
        LocalDate today = LocalDate.now();
        LocalDate rangeEnd = req.yearTo >= today.getYear() ? today : LocalDate.of(req.yearTo, 12, 31);
        List<LocalDate> tradingDays = new ArrayList<>(hy.subMap(rangeStart, true, rangeEnd, true).keySet());
        tradingDays.removeIf(d -> !ig.containsKey(d));
        if (tradingDays.size() < 2) {
            throw new IllegalStateException("Not enough HYG/LQD data for " + req.yearFrom + "-" + req.yearTo);
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

                    Map<String, Object> sim = simulate(tradingDays, hy, ig, spy, usdPerEur, feature, enterThreshold, exitThreshold);
                    @SuppressWarnings("unchecked")
                    Map<String, Object> stats = (Map<String, Object>) ((Map<String, Object>) sim.get("stats")).get("strategy");
                    double cagr = (double) stats.get("cagr");
                    double vol = (double) stats.get("volatility");
                    double totalReturn = (double) stats.get("totalReturn");
                    double riskAdjusted = vol > 0 ? cagr / vol : 0.0;

                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("feature", meta.key());
                    row.put("featureLabel", meta.label());
                    row.put("enterThreshold", enterThreshold);
                    row.put("exitThreshold", exitThreshold);
                    row.put("cagr", cagr);
                    row.put("volatility", vol);
                    row.put("maxDrawdown", stats.get("maxDrawdown"));
                    row.put("totalReturn", totalReturn);
                    row.put("riskAdjusted", riskAdjusted);
                    row.put("tradesCount", sim.get("tradesCount"));
                    allResults.add(row);
                }
            }
        }

        String rankBy = req.rankBy == null ? "RISK_ADJUSTED" : req.rankBy;
        allResults.sort((a, b) -> Double.compare(rankValue(b, rankBy), rankValue(a, rankBy)));

        Map<String, Object> result = new LinkedHashMap<>();
        Map<String, Object> reqMeta = new LinkedHashMap<>();
        reqMeta.put("yearFrom", req.yearFrom);
        reqMeta.put("yearTo", req.yearTo);
        reqMeta.put("currency", currency);
        reqMeta.put("rankBy", rankBy);
        reqMeta.put("combinationsTested", allResults.size());
        result.put("meta", reqMeta);
        result.put("top", allResults.subList(0, Math.min(20, allResults.size())));
        result.put("best", allResults.isEmpty() ? null : allResults.get(0));
        return result;
    }

    private double rankValue(Map<String, Object> row, String rankBy) {
        return switch (rankBy) {
            case "CAGR" -> (double) row.get("cagr");
            case "TOTAL_RETURN" -> (double) row.get("totalReturn");
            default -> (double) row.get("riskAdjusted");
        };
    }

    private double percentile(List<Double> sortedAsc, double p) {
        int idx = (int) Math.floor(p * (sortedAsc.size() - 1));
        return sortedAsc.get(Math.max(0, Math.min(sortedAsc.size() - 1, idx)));
    }

    /** The actual day-by-day simulation shared by runBacktest and sweep — everything above this
     * just decides WHICH feature/thresholds to feed it. */
    private Map<String, Object> simulate(List<LocalDate> tradingDays, NavigableMap<LocalDate, BigDecimal> hy,
                                          NavigableMap<LocalDate, BigDecimal> ig, NavigableMap<LocalDate, BigDecimal> spy,
                                          NavigableMap<LocalDate, BigDecimal> usdPerEur,
                                          NavigableMap<LocalDate, Double> feature, double enterThreshold, double exitThreshold) {
        Double f0 = floorValue(feature, tradingDays.get(0));
        boolean inHY = f0 != null && f0 >= enterThreshold;

        double strategyWealth = 1.0, strategyPeak = 1.0, strategyMaxDD = 0.0;
        double hyWealth = 1.0, hyPeak = 1.0, hyMaxDD = 0.0;
        double igWealth = 1.0, igPeak = 1.0, igMaxDD = 0.0;
        double spyWealth = 1.0, spyPeak = 1.0, spyMaxDD = 0.0;
        List<Double> strategyDaily = new ArrayList<>();
        List<Double> hyDaily = new ArrayList<>();
        List<Double> igDaily = new ArrayList<>();
        List<Double> spyDaily = new ArrayList<>();
        int daysInHY = 0, daysInIG = 0;
        boolean includeSpy = !spy.isEmpty() && !spy.firstKey().isAfter(tradingDays.get(0));

        Map<Integer, Map<String, Object>> cumulativeByYear = new LinkedHashMap<>();
        List<Map<String, Object>> trades = new ArrayList<>();
        Map<String, Object> segment = openSegment(inHY, tradingDays.get(0), f0, hy, ig, usdPerEur);
        double segmentMultiplier = 1.0;

        for (int i = 1; i < tradingDays.size(); i++) {
            LocalDate prevDay = tradingDays.get(i - 1);
            LocalDate day = tradingDays.get(i);

            double hyRet = fxAdjust(usdPerEur, prevDay, day, usdReturn(hy, prevDay, day));
            double igRet = fxAdjust(usdPerEur, prevDay, day, usdReturn(ig, prevDay, day));
            double stratRet = inHY ? hyRet : igRet;
            if (inHY) daysInHY++; else daysInIG++;
            segmentMultiplier *= 1.0 + stratRet;

            strategyWealth *= 1.0 + stratRet;
            strategyPeak = Math.max(strategyPeak, strategyWealth);
            strategyMaxDD = Math.min(strategyMaxDD, (strategyWealth - strategyPeak) / strategyPeak);
            strategyDaily.add(stratRet);

            hyWealth *= 1.0 + hyRet;
            hyPeak = Math.max(hyPeak, hyWealth);
            hyMaxDD = Math.min(hyMaxDD, (hyWealth - hyPeak) / hyPeak);
            hyDaily.add(hyRet);

            igWealth *= 1.0 + igRet;
            igPeak = Math.max(igPeak, igWealth);
            igMaxDD = Math.min(igMaxDD, (igWealth - igPeak) / igPeak);
            igDaily.add(igRet);

            if (includeSpy) {
                BigDecimal spyPrev = spy.get(prevDay), spyCur = spy.get(day);
                if (spyPrev != null && spyCur != null) {
                    double spyRetUsd = spyCur.subtract(spyPrev).divide(spyPrev, MathContext.DECIMAL64).doubleValue();
                    double spyRet = fxAdjust(usdPerEur, prevDay, day, spyRetUsd);
                    spyWealth *= 1.0 + spyRet;
                    spyPeak = Math.max(spyPeak, spyWealth);
                    spyMaxDD = Math.min(spyMaxDD, (spyWealth - spyPeak) / spyPeak);
                    spyDaily.add(spyRet);
                }
            }

            Map<String, Object> yearPoint = cumulativeByYear.computeIfAbsent(day.getYear(), y -> new LinkedHashMap<>(Map.of("year", y)));
            yearPoint.put("cumulativeStrategy", strategyWealth - 1.0);
            yearPoint.put("cumulativeHy", hyWealth - 1.0);
            yearPoint.put("cumulativeIg", igWealth - 1.0);
            if (includeSpy) yearPoint.put("cumulativeSp500", spyWealth - 1.0);

            Double fToday = floorValue(feature, day);
            if (fToday != null && ((!inHY && fToday >= enterThreshold) || (inHY && fToday <= exitThreshold))) {
                inHY = !inHY;
                closeSegment(segment, day, fToday, segmentMultiplier, hy, ig, usdPerEur, false);
                trades.add(segment);
                segment = openSegment(inHY, day, fToday, hy, ig, usdPerEur);
                segmentMultiplier = 1.0;
            }
        }
        LocalDate lastDay = tradingDays.get(tradingDays.size() - 1);
        closeSegment(segment, lastDay, floorValue(feature, lastDay), segmentMultiplier, hy, ig, usdPerEur, true);
        trades.add(segment);

        double yearsElapsed = ChronoUnit.DAYS.between(tradingDays.get(0), tradingDays.get(tradingDays.size() - 1)) / 365.25;

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("cumulative", cumulativeByYear.values().stream().toList());
        result.put("spyAvailable", includeSpy);

        Map<String, Object> stats = new LinkedHashMap<>();
        stats.put("strategy", statBlock(strategyWealth, strategyMaxDD, strategyDaily, yearsElapsed));
        stats.put("hy", statBlock(hyWealth, hyMaxDD, hyDaily, yearsElapsed));
        stats.put("ig", statBlock(igWealth, igMaxDD, igDaily, yearsElapsed));
        if (includeSpy) stats.put("spy", statBlock(spyWealth, spyMaxDD, spyDaily, yearsElapsed));
        result.put("stats", stats);

        result.put("trades", trades);
        result.put("tradesCount", (int) trades.stream().filter(t -> "HY".equals(t.get("type"))).count());
        result.put("daysInHy", daysInHY);
        result.put("daysInIg", daysInIG);
        result.put("pctTimeInHy", (daysInHY + daysInIG) == 0 ? 0.0 : (double) daysInHY / (daysInHY + daysInIG));
        return result;
    }

    private Map<String, Object> openSegment(boolean hy, LocalDate entryDate, Double featureAtEntry,
                                             NavigableMap<LocalDate, BigDecimal> hyCloses, NavigableMap<LocalDate, BigDecimal> igCloses,
                                             NavigableMap<LocalDate, BigDecimal> usdPerEur) {
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("type", hy ? "HY" : "IG");
        s.put("entryDate", entryDate.toString());
        s.put("featureAtEntry", featureAtEntry);
        // Always the real USD market price — this instrument only trades in USD. usdPerEur is
        // just added for transparency in EUR mode; the trade's return (tradeReturn, set in
        // closeSegment) is what's actually computed in EUR terms, via fxAdjust in the day-by-day
        // loop above, not by converting these two price points directly.
        s.put("entryPrice", (hy ? hyCloses.get(entryDate) : igCloses.get(entryDate)).doubleValue());
        if (usdPerEur != null) s.put("fxAtEntry", floorFxValue(usdPerEur, entryDate));
        return s;
    }

    private void closeSegment(Map<String, Object> segment, LocalDate exitDate, Double featureAtExit, double multiplier,
                               NavigableMap<LocalDate, BigDecimal> hyCloses, NavigableMap<LocalDate, BigDecimal> igCloses,
                               NavigableMap<LocalDate, BigDecimal> usdPerEur, boolean open) {
        boolean isHy = "HY".equals(segment.get("type"));
        String dateKey = open ? "asOfDate" : "exitDate";
        segment.put(dateKey, exitDate.toString());
        if (!open) segment.put("featureAtExit", featureAtExit);
        segment.put(open ? "asOfPrice" : "exitPrice", (isHy ? hyCloses.get(exitDate) : igCloses.get(exitDate)).doubleValue());
        if (usdPerEur != null) segment.put(open ? "fxAsOf" : "fxAtExit", floorFxValue(usdPerEur, exitDate));
        segment.put("tradeReturn", multiplier - 1.0);
        segment.put("open", open);
    }

    /** A EUR investor converts EUR→USD to buy a USD asset and back on the way out, so their
     * return also carries the EUR/USD move: ret_eur = (fx0/fx1) × (1+ret_usd) − 1, where fx is
     * "USD per 1 EUR". Same formula as VixTimingService's fxAdjust. No-op (returns usdReturn
     * unchanged) when usdPerEur is null (USD mode) or a quote is missing for either day. */
    private double fxAdjust(NavigableMap<LocalDate, BigDecimal> usdPerEur, LocalDate prevDay, LocalDate day, double usdReturn) {
        if (usdPerEur == null) return usdReturn;
        Double fx0 = floorFxValue(usdPerEur, prevDay);
        Double fx1 = floorFxValue(usdPerEur, day);
        if (fx0 == null || fx1 == null) return usdReturn;
        return (fx0 / fx1) * (1.0 + usdReturn) - 1.0;
    }

    private Double floorFxValue(NavigableMap<LocalDate, BigDecimal> series, LocalDate asOf) {
        Map.Entry<LocalDate, BigDecimal> e = series.floorEntry(asOf);
        return e == null ? null : e.getValue().doubleValue();
    }

    private Map<String, Object> statBlock(double finalWealth, double maxDrawdown, List<Double> dailyReturns, double yearsElapsed) {
        double totalReturn = finalWealth - 1.0;
        double cagr = yearsElapsed <= 0 ? 0.0 : Math.pow(finalWealth, 1.0 / yearsElapsed) - 1.0;
        Map<String, Object> block = new LinkedHashMap<>();
        block.put("totalReturn", totalReturn);
        block.put("cagr", cagr);
        block.put("volatility", annualizedVolFromDaily(dailyReturns));
        block.put("maxDrawdown", maxDrawdown);
        return block;
    }

    private double annualizedVolFromDaily(List<Double> dailyReturns) {
        if (dailyReturns.size() < 2) return 0.0;
        double mean = dailyReturns.stream().mapToDouble(d -> d).average().orElse(0);
        double variance = dailyReturns.stream().mapToDouble(r -> Math.pow(r - mean, 2)).sum() / (dailyReturns.size() - 1);
        return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR);
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
