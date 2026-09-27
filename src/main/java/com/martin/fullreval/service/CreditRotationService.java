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
 * Tickers: HYG (iShares iBoxx $ High Yield Corporate Bond ETF, real data since 2007-05) and LQD
 * (iShares iBoxx $ Investment Grade Corporate Bond ETF, real data since 2002-08) are the
 * longest-history LIQUID ETFs available — true short-duration HY funds (SJNK, SHYG) only start
 * in 2012-2013. To reach further back (matching the ~2000-start range the rest of this project
 * uses), each is SPLICED onto a real, much-older Vanguard mutual fund in the same asset class —
 * VWEHX (Vanguard High-Yield Corporate, real daily data since 2000-01) for HYG, and VWESX
 * (Vanguard Long-Term Investment-Grade, real daily data since 2000-01) for LQD — see
 * buildSplicedCloses. This is real fund performance, not a modeled/synthetic yield-curve proxy;
 * the tradeoff is that the mutual funds are actively managed and not perfectly identical
 * duration/composition to the ETFs they're spliced onto, so the pre-ETF-inception portion of any
 * result is a reasonable approximation of the asset class, not the exact HYG/LQD index.
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
 * Prices: unlike every other equity-momentum backtest in this project (which use raw close —
 * a fine approximation when dividends are a small share of total return), this service uses
 * YahooFinanceService.fetchAdjustedDailyCloses — Yahoo's dividend/coupon-ADJUSTED close — for
 * every ticker. Bond fund returns are dominated by their distributions, not price appreciation:
 * HYG's raw price alone actually trends DOWN over its history even though its real total return
 * is strongly positive, so raw close would have made this whole strategy meaningless.
 *
 * Currency: every result always reports BOTH the native USD return and a real EUR-investor
 * return (FX-exposed, no hedging) side by side — never one or the other behind a toggle.
 */
@Service
public class CreditRotationService {

    private static final int TRADING_DAYS_PER_YEAR = 252;
    private static final String HY_TICKER = "HYG";
    private static final String IG_TICKER = "LQD";
    private static final String HY_PROXY_TICKER = "VWEHX"; // Vanguard High-Yield Corporate — real data since 2000-01
    private static final String IG_PROXY_TICKER = "VWESX"; // Vanguard Long-Term Investment-Grade — real data since 2000-01
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

    /** Splices a real ETF's price history onto an older real mutual fund's history in the same
     * asset class, so the combined series reaches back further than the ETF alone while using
     * the ETF directly for every date it actually covers. The proxy's OWN daily % returns are
     * preserved exactly for the extension period — only its LEVEL is rescaled by a single
     * constant factor (real ETF price at the splice date ÷ proxy price at the splice date) so
     * the two segments connect with no artificial jump. Falls back to the real series alone if
     * either fetch comes back empty or the proxy doesn't reach the splice date. */
    private NavigableMap<LocalDate, BigDecimal> buildSplicedCloses(String realTicker, String proxyTicker) {
        NavigableMap<LocalDate, BigDecimal> real = yahooFinanceService.fetchAdjustedDailyCloses(realTicker);
        if (real.isEmpty()) return real;
        NavigableMap<LocalDate, BigDecimal> proxy = yahooFinanceService.fetchAdjustedDailyCloses(proxyTicker);
        if (proxy.isEmpty()) return real;

        LocalDate realStart = real.firstKey();
        Map.Entry<LocalDate, BigDecimal> proxyAtSplice = proxy.floorEntry(realStart);
        if (proxyAtSplice == null || proxyAtSplice.getValue().signum() == 0) return real;

        BigDecimal scale = real.get(realStart).divide(proxyAtSplice.getValue(), MathContext.DECIMAL64);
        NavigableMap<LocalDate, BigDecimal> spliced = new TreeMap<>();
        for (Map.Entry<LocalDate, BigDecimal> e : proxy.headMap(realStart, false).entrySet()) {
            spliced.put(e.getKey(), e.getValue().multiply(scale, MathContext.DECIMAL64));
        }
        spliced.putAll(real);
        return spliced;
    }

    @SuppressWarnings("unchecked")
    private NavigableMap<LocalDate, BigDecimal> usdPerEur() {
        return (NavigableMap<LocalDate, BigDecimal>) fxRateService.getUsdPerLocal("EUR");
    }

    public Map<String, Object> runBacktest(CreditRotationRequest req) {
        if (req.yearFrom > req.yearTo) {
            throw new IllegalArgumentException("yearFrom must be <= yearTo");
        }
        if (req.exitThreshold >= req.enterThreshold) {
            throw new IllegalArgumentException("exitThreshold must be lower than enterThreshold");
        }
        FeatureMeta meta = featureMeta(req.feature);

        NavigableMap<LocalDate, BigDecimal> hy = buildSplicedCloses(HY_TICKER, HY_PROXY_TICKER);
        NavigableMap<LocalDate, BigDecimal> ig = buildSplicedCloses(IG_TICKER, IG_PROXY_TICKER);
        NavigableMap<LocalDate, BigDecimal> spy = yahooFinanceService.fetchAdjustedDailyCloses(SPY_TICKER);
        NavigableMap<LocalDate, BigDecimal> usdPerEur = usdPerEur();
        NavigableMap<LocalDate, Double> feature = buildFeatureSeries(meta);

        LocalDate rangeStart = LocalDate.of(req.yearFrom, 1, 1);
        LocalDate today = LocalDate.now();
        LocalDate rangeEnd = req.yearTo >= today.getYear() ? today : LocalDate.of(req.yearTo, 12, 31);

        List<LocalDate> tradingDays = new ArrayList<>(hy.subMap(rangeStart, true, rangeEnd, true).keySet());
        tradingDays.removeIf(d -> !ig.containsKey(d)); // both legs must have a real price that day
        if (tradingDays.size() < 2) {
            throw new IllegalStateException("Not enough HYG/LQD (+ proxy) data for " + req.yearFrom + "-" + req.yearTo
                    + " (spliced data starts " + hy.firstKey() + ")");
        }

        Map<String, Object> result = simulate(tradingDays, hy, ig, spy, usdPerEur, feature, req.enterThreshold, req.exitThreshold);
        Map<String, Object> reqMeta = new LinkedHashMap<>();
        reqMeta.put("yearFrom", req.yearFrom);
        reqMeta.put("yearTo", req.yearTo);
        reqMeta.put("feature", meta.key());
        reqMeta.put("featureLabel", meta.label());
        reqMeta.put("enterThreshold", req.enterThreshold);
        reqMeta.put("exitThreshold", req.exitThreshold);
        reqMeta.put("hyTicker", HY_TICKER);
        reqMeta.put("igTicker", IG_TICKER);
        reqMeta.put("hyProxyTicker", HY_PROXY_TICKER);
        reqMeta.put("igProxyTicker", IG_PROXY_TICKER);
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
        NavigableMap<LocalDate, BigDecimal> hy = buildSplicedCloses(HY_TICKER, HY_PROXY_TICKER);
        NavigableMap<LocalDate, BigDecimal> ig = buildSplicedCloses(IG_TICKER, IG_PROXY_TICKER);
        NavigableMap<LocalDate, BigDecimal> spy = yahooFinanceService.fetchAdjustedDailyCloses(SPY_TICKER);
        NavigableMap<LocalDate, BigDecimal> usdPerEur = usdPerEur();

        LocalDate rangeStart = LocalDate.of(req.yearFrom, 1, 1);
        LocalDate today = LocalDate.now();
        LocalDate rangeEnd = req.yearTo >= today.getYear() ? today : LocalDate.of(req.yearTo, 12, 31);
        List<LocalDate> tradingDays = new ArrayList<>(hy.subMap(rangeStart, true, rangeEnd, true).keySet());
        tradingDays.removeIf(d -> !ig.containsKey(d));
        if (tradingDays.size() < 2) {
            throw new IllegalStateException("Not enough HYG/LQD (+ proxy) data for " + req.yearFrom + "-" + req.yearTo);
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
     * just decides WHICH feature/thresholds to feed it. Tracks USD and EUR wealth curves in
     * parallel for every series (strategy/HY/IG/SPY): the day-by-day HOLD decision is currency-
     * blind (driven only by the feature reading), so a single pass over the trading days is
     * enough to produce both currencies' numbers — no need to re-simulate. */
    private Map<String, Object> simulate(List<LocalDate> tradingDays, NavigableMap<LocalDate, BigDecimal> hy,
                                          NavigableMap<LocalDate, BigDecimal> ig, NavigableMap<LocalDate, BigDecimal> spy,
                                          NavigableMap<LocalDate, BigDecimal> usdPerEur,
                                          NavigableMap<LocalDate, Double> feature, double enterThreshold, double exitThreshold) {
        Double f0 = floorValue(feature, tradingDays.get(0));
        boolean inHY = f0 != null && f0 >= enterThreshold;

        Ledger strategy = new Ledger();
        Ledger hyLedger = new Ledger();
        Ledger igLedger = new Ledger();
        Ledger spyLedger = new Ledger();
        int daysInHY = 0, daysInIG = 0;
        boolean includeSpy = !spy.isEmpty() && !spy.firstKey().isAfter(tradingDays.get(0));

        Map<Integer, Map<String, Object>> cumulativeByYear = new LinkedHashMap<>();
        List<Map<String, Object>> trades = new ArrayList<>();
        Map<String, Object> segment = openSegment(inHY, tradingDays.get(0), f0, hy, ig, usdPerEur);
        double segmentMultiplierUsd = 1.0, segmentMultiplierEur = 1.0;

        for (int i = 1; i < tradingDays.size(); i++) {
            LocalDate prevDay = tradingDays.get(i - 1);
            LocalDate day = tradingDays.get(i);

            double hyRetUsd = usdReturn(hy, prevDay, day);
            double igRetUsd = usdReturn(ig, prevDay, day);
            double hyRetEur = fxAdjust(usdPerEur, prevDay, day, hyRetUsd);
            double igRetEur = fxAdjust(usdPerEur, prevDay, day, igRetUsd);
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

            Double fToday = floorValue(feature, day);
            if (fToday != null && ((!inHY && fToday >= enterThreshold) || (inHY && fToday <= exitThreshold))) {
                inHY = !inHY;
                closeSegment(segment, day, fToday, segmentMultiplierUsd, segmentMultiplierEur, hy, ig, usdPerEur, false);
                trades.add(segment);
                segment = openSegment(inHY, day, fToday, hy, ig, usdPerEur);
                segmentMultiplierUsd = 1.0;
                segmentMultiplierEur = 1.0;
            }
        }
        LocalDate lastDay = tradingDays.get(tradingDays.size() - 1);
        closeSegment(segment, lastDay, floorValue(feature, lastDay), segmentMultiplierUsd, segmentMultiplierEur, hy, ig, usdPerEur, true);
        trades.add(segment);

        double yearsElapsed = ChronoUnit.DAYS.between(tradingDays.get(0), tradingDays.get(tradingDays.size() - 1)) / 365.25;

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("cumulative", cumulativeByYear.values().stream().toList());
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

    private Map<String, Object> openSegment(boolean hy, LocalDate entryDate, Double featureAtEntry,
                                             NavigableMap<LocalDate, BigDecimal> hyCloses, NavigableMap<LocalDate, BigDecimal> igCloses,
                                             NavigableMap<LocalDate, BigDecimal> usdPerEur) {
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("type", hy ? "HY" : "IG");
        s.put("entryDate", entryDate.toString());
        s.put("featureAtEntry", featureAtEntry);
        // Always the real USD market price — this instrument only trades in USD. fxAtEntry is
        // added for transparency; the trade's EUR return (tradeReturnEur, set in closeSegment)
        // is computed day-by-day via fxAdjust in the loop above, not by converting these two
        // price points directly.
        s.put("entryPrice", (hy ? hyCloses.get(entryDate) : igCloses.get(entryDate)).doubleValue());
        s.put("fxAtEntry", floorFxValue(usdPerEur, entryDate));
        return s;
    }

    private void closeSegment(Map<String, Object> segment, LocalDate exitDate, Double featureAtExit,
                               double multiplierUsd, double multiplierEur,
                               NavigableMap<LocalDate, BigDecimal> hyCloses, NavigableMap<LocalDate, BigDecimal> igCloses,
                               NavigableMap<LocalDate, BigDecimal> usdPerEur, boolean open) {
        boolean isHy = "HY".equals(segment.get("type"));
        String dateKey = open ? "asOfDate" : "exitDate";
        segment.put(dateKey, exitDate.toString());
        if (!open) segment.put("featureAtExit", featureAtExit);
        segment.put(open ? "asOfPrice" : "exitPrice", (isHy ? hyCloses.get(exitDate) : igCloses.get(exitDate)).doubleValue());
        segment.put(open ? "fxAsOf" : "fxAtExit", floorFxValue(usdPerEur, exitDate));
        segment.put("tradeReturnUsd", multiplierUsd - 1.0);
        segment.put("tradeReturnEur", multiplierEur - 1.0);
        segment.put("open", open);
    }

    /** A EUR investor converts EUR→USD to buy a USD asset and back on the way out, so their
     * return also carries the EUR/USD move: ret_eur = (fx0/fx1) × (1+ret_usd) − 1, where fx is
     * "USD per 1 EUR". Same formula as VixTimingService's fxAdjust. Falls back to the USD return
     * unchanged if a quote is missing for either day. */
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
