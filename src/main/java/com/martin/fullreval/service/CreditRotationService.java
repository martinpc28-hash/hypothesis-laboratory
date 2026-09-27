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
 * "Credit rotation" tactical strategy: sit in investment-grade corporate bonds until a chosen
 * macro reading signals elevated credit stress, then rotate 100% into high-yield corporate bonds
 * until conditions calm back down — the same day-by-day state machine as VixTimingService
 * (cash/S&P 500), generalized to a different pair of holdings and a choice of SEVEN candidate
 * trigger series instead of one hardcoded VIX.
 *
 * Instruments — real funds throughout, not ETFs spliced onto funds: liquid HY/IG ETFs (HYG, LQD)
 * only start in 2007/2002, too short for a 2000+ backtest, and true short-duration HY ETFs
 * (SJNK, SHYG) only start in 2012-2013. Real Vanguard mutual funds cover the whole 2000-2026
 * range directly instead:
 *   - USD: VWEHX (Vanguard High-Yield Corporate) and VWESX (Vanguard Long-Term Investment-Grade),
 *     both with real daily data since 2000-01 — used for their FULL history, no splicing needed.
 *   - EUR: a EUR-based investor's return is NOT just the USD funds' returns converted at the spot
 *     rate for the whole period — real EUR-denominated funds in the same asset class exist and
 *     are used wherever they cover the date: IHYG.L (iShares € High Yield Corp Bond UCITS ETF,
 *     real EUR data since 2010-09) and IEAC.L (iShares Core € Corp Bond UCITS ETF, real EUR data
 *     since 2009-03). Before each one's own real start date, its EUR series falls back to a
 *     synthetic FX-converted version of the USD fund (see buildSyntheticEurSeries + spliceOnto) —
 *     so the EUR column is real fund performance from ~2009-2010 onward, and only synthetic in
 *     the 2000s where no real EUR-denominated alternative exists. Every trade segment records
 *     which regime (REAL_FUND vs FX_SYNTHETIC) applied to its EUR return at entry and exit.
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
 * every ticker. Bond fund returns are dominated by their distributions, not price appreciation.
 *
 * Currency: every result always reports BOTH the native USD return and the EUR return (real fund
 * where available, FX-synthetic before that) side by side — never one or the other behind a
 * toggle.
 */
@Service
public class CreditRotationService {

    private static final int TRADING_DAYS_PER_YEAR = 252;
    private static final String HY_TICKER = "VWEHX"; // Vanguard High-Yield Corporate — real USD data since 2000-01
    private static final String IG_TICKER = "VWESX"; // Vanguard Long-Term Investment-Grade — real USD data since 2000-01
    private static final String HY_EUR_TICKER = "IHYG.L"; // iShares € High Yield Corp Bond UCITS ETF — real EUR data since 2010-09
    private static final String IG_EUR_TICKER = "IEAC.L"; // iShares Core € Corp Bond UCITS ETF — real EUR data since 2009-03
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

    /** Rescales `extension` by a single constant factor (real[realStart] ÷ extension[realStart])
     * so it connects to `real` with no artificial jump at the splice date, then uses `extension`
     * for every date before real's own start and `real` directly from there on. `extension`'s own
     * daily % returns are preserved exactly — only its level is rescaled. Falls back to `real`
     * alone if either series is empty or `extension` doesn't reach the splice date. */
    private NavigableMap<LocalDate, BigDecimal> spliceOnto(NavigableMap<LocalDate, BigDecimal> real,
                                                             NavigableMap<LocalDate, BigDecimal> extension) {
        if (real.isEmpty()) return extension;
        if (extension.isEmpty()) return real;
        LocalDate realStart = real.firstKey();
        Map.Entry<LocalDate, BigDecimal> extAtSplice = extension.floorEntry(realStart);
        if (extAtSplice == null || extAtSplice.getValue().signum() == 0) return real;

        BigDecimal scale = real.get(realStart).divide(extAtSplice.getValue(), MathContext.DECIMAL64);
        NavigableMap<LocalDate, BigDecimal> spliced = new TreeMap<>();
        for (Map.Entry<LocalDate, BigDecimal> e : extension.headMap(realStart, false).entrySet()) {
            spliced.put(e.getKey(), e.getValue().multiply(scale, MathContext.DECIMAL64));
        }
        spliced.putAll(real);
        return spliced;
    }

    /** Builds a full-history synthetic EUR price index from a USD price series, by compounding
     * that series' own FX-adjusted daily returns starting from an arbitrary base of 1.0 — used
     * only as the pre-real-EUR-fund EXTENSION in spliceOnto, so its absolute level never matters
     * (spliceOnto rescales it to connect with the real EUR fund's actual level). */
    private NavigableMap<LocalDate, BigDecimal> buildSyntheticEurSeries(NavigableMap<LocalDate, BigDecimal> usdCloses,
                                                                         NavigableMap<LocalDate, BigDecimal> usdPerEur) {
        NavigableMap<LocalDate, BigDecimal> synthetic = new TreeMap<>();
        if (usdCloses.isEmpty()) return synthetic;
        List<LocalDate> dates = new ArrayList<>(usdCloses.keySet());
        BigDecimal level = BigDecimal.ONE;
        synthetic.put(dates.get(0), level);
        for (int i = 1; i < dates.size(); i++) {
            double usdRet = usdReturn(usdCloses, dates.get(i - 1), dates.get(i));
            double eurRet = fxAdjust(usdPerEur, dates.get(i - 1), dates.get(i), usdRet);
            level = level.multiply(BigDecimal.valueOf(1.0 + eurRet), MathContext.DECIMAL64);
            synthetic.put(dates.get(i), level);
        }
        return synthetic;
    }

    @SuppressWarnings("unchecked")
    private NavigableMap<LocalDate, BigDecimal> usdPerEur() {
        return (NavigableMap<LocalDate, BigDecimal>) fxRateService.getUsdPerLocal("EUR");
    }

    /** Bundles the four price series (USD/EUR × HY/IG) plus the real-EUR-fund start dates that
     * every request needs — built once per request/sweep instead of duplicating this fetch+splice
     * logic in both runBacktest and sweep. */
    private record Instruments(NavigableMap<LocalDate, BigDecimal> hyUsd, NavigableMap<LocalDate, BigDecimal> igUsd,
                                NavigableMap<LocalDate, BigDecimal> hyEur, NavigableMap<LocalDate, BigDecimal> igEur,
                                NavigableMap<LocalDate, BigDecimal> spy, NavigableMap<LocalDate, BigDecimal> usdPerEur,
                                LocalDate hyEurRealStart, LocalDate igEurRealStart) {}

    private Instruments loadInstruments() {
        NavigableMap<LocalDate, BigDecimal> hyUsd = yahooFinanceService.fetchAdjustedDailyCloses(HY_TICKER);
        NavigableMap<LocalDate, BigDecimal> igUsd = yahooFinanceService.fetchAdjustedDailyCloses(IG_TICKER);
        NavigableMap<LocalDate, BigDecimal> hyEurReal = yahooFinanceService.fetchAdjustedDailyCloses(HY_EUR_TICKER);
        NavigableMap<LocalDate, BigDecimal> igEurReal = yahooFinanceService.fetchAdjustedDailyCloses(IG_EUR_TICKER);
        NavigableMap<LocalDate, BigDecimal> spy = yahooFinanceService.fetchAdjustedDailyCloses(SPY_TICKER);
        NavigableMap<LocalDate, BigDecimal> usdPerEur = usdPerEur();

        NavigableMap<LocalDate, BigDecimal> hyEur = spliceOnto(hyEurReal, buildSyntheticEurSeries(hyUsd, usdPerEur));
        NavigableMap<LocalDate, BigDecimal> igEur = spliceOnto(igEurReal, buildSyntheticEurSeries(igUsd, usdPerEur));

        return new Instruments(hyUsd, igUsd, hyEur, igEur, spy, usdPerEur,
                hyEurReal.isEmpty() ? null : hyEurReal.firstKey(),
                igEurReal.isEmpty() ? null : igEurReal.firstKey());
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
        reqMeta.put("hyEurRealStart", inst.hyEurRealStart() == null ? null : inst.hyEurRealStart().toString());
        reqMeta.put("igEurRealStart", inst.igEurRealStart() == null ? null : inst.igEurRealStart().toString());
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
     * produces both currencies' numbers. The EUR leg is read directly off the (already spliced)
     * EUR price series — real fund where it covers the date, synthetic FX conversion before
     * that — falling back to on-the-fly FX conversion of the USD return only on a day the EUR
     * series itself has no quote (e.g. a UK/EU holiday the US market doesn't share). */
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
        List<Map<String, Object>> trades = new ArrayList<>();
        Map<String, Object> segment = openSegment(inHY, tradingDays.get(0), f0, inst);
        double segmentMultiplierUsd = 1.0, segmentMultiplierEur = 1.0;

        for (int i = 1; i < tradingDays.size(); i++) {
            LocalDate prevDay = tradingDays.get(i - 1);
            LocalDate day = tradingDays.get(i);

            double hyRetUsd = usdReturn(hyUsd, prevDay, day);
            double igRetUsd = usdReturn(igUsd, prevDay, day);
            double hyRetEur = eurReturn(hyEur, hyUsd, usdPerEur, prevDay, day);
            double igRetEur = eurReturn(igEur, igUsd, usdPerEur, prevDay, day);
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
                    // SPY EUR stays FX-synthetic — it's only a contextual reference line, not one
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

    private Map<String, Object> openSegment(boolean hy, LocalDate entryDate, Double featureAtEntry, Instruments inst) {
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("type", hy ? "HY" : "IG");
        s.put("entryDate", entryDate.toString());
        s.put("featureAtEntry", featureAtEntry);
        NavigableMap<LocalDate, BigDecimal> usdCloses = hy ? inst.hyUsd() : inst.igUsd();
        NavigableMap<LocalDate, BigDecimal> eurCloses = hy ? inst.hyEur() : inst.igEur();
        LocalDate eurRealStart = hy ? inst.hyEurRealStart() : inst.igEurRealStart();
        s.put("entryPrice", usdCloses.get(entryDate).doubleValue());
        Map.Entry<LocalDate, BigDecimal> eurEntry = eurCloses.floorEntry(entryDate);
        s.put("entryPriceEur", eurEntry == null ? null : eurEntry.getValue().doubleValue());
        s.put("eurSourceAtEntry", eurSource(entryDate, eurRealStart));
        s.put("fxAtEntry", floorFxValue(inst.usdPerEur(), entryDate));
        return s;
    }

    private void closeSegment(Map<String, Object> segment, LocalDate exitDate, Double featureAtExit,
                               double multiplierUsd, double multiplierEur, Instruments inst, boolean open) {
        boolean isHy = "HY".equals(segment.get("type"));
        NavigableMap<LocalDate, BigDecimal> usdCloses = isHy ? inst.hyUsd() : inst.igUsd();
        NavigableMap<LocalDate, BigDecimal> eurCloses = isHy ? inst.hyEur() : inst.igEur();
        LocalDate eurRealStart = isHy ? inst.hyEurRealStart() : inst.igEurRealStart();
        String dateKey = open ? "asOfDate" : "exitDate";
        segment.put(dateKey, exitDate.toString());
        if (!open) segment.put("featureAtExit", featureAtExit);
        segment.put(open ? "asOfPrice" : "exitPrice", usdCloses.get(exitDate).doubleValue());
        Map.Entry<LocalDate, BigDecimal> eurExit = eurCloses.floorEntry(exitDate);
        segment.put(open ? "asOfPriceEur" : "exitPriceEur", eurExit == null ? null : eurExit.getValue().doubleValue());
        segment.put(open ? "eurSourceAsOf" : "eurSourceAtExit", eurSource(exitDate, eurRealStart));
        segment.put(open ? "fxAsOf" : "fxAtExit", floorFxValue(inst.usdPerEur(), exitDate));
        segment.put("tradeReturnUsd", multiplierUsd - 1.0);
        segment.put("tradeReturnEur", multiplierEur - 1.0);
        segment.put("open", open);
    }

    /** "REAL_FUND" once a date is on/after the real EUR-denominated fund's own first date,
     * "FX_SYNTHETIC" before that (or if the EUR fund has no data at all) — lets the UI show
     * exactly which regime backs any given EUR number instead of leaving it implicit. */
    private String eurSource(LocalDate date, LocalDate eurRealStart) {
        return eurRealStart != null && !date.isBefore(eurRealStart) ? "REAL_FUND" : "FX_SYNTHETIC";
    }

    /** EUR return for one leg, read directly off its (already spliced) EUR price series — real
     * fund where it covers the date, synthetic FX-converted level before that. Falls back to an
     * on-the-fly FX conversion of the USD return only if the EUR series itself is missing a quote
     * for prevDay or day (e.g. a UK/EU holiday the US market doesn't share), so a calendar
     * mismatch never breaks a day's return instead of just using the next best information. */
    private double eurReturn(NavigableMap<LocalDate, BigDecimal> eurCloses, NavigableMap<LocalDate, BigDecimal> usdCloses,
                              NavigableMap<LocalDate, BigDecimal> usdPerEur, LocalDate prevDay, LocalDate day) {
        BigDecimal p0 = eurCloses.get(prevDay), p1 = eurCloses.get(day);
        if (p0 != null && p1 != null) {
            return p1.subtract(p0).divide(p0, MathContext.DECIMAL64).doubleValue();
        }
        return fxAdjust(usdPerEur, prevDay, day, usdReturn(usdCloses, prevDay, day));
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
