package com.martin.fullreval.service;

import com.martin.fullreval.dto.VixTimingRequest;
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

/**
 * "VIX timing" tactical strategy: sit in a money-market cash leg (earning a user-chosen annual
 * rate) until the VIX (CBOE's series, via FRED's VIXCLS mirror — same free no-API-key source
 * MacroDataService already uses) spikes to fear-index territory, then go 100% into the S&P 500
 * until the VIX calms back down. This is a genuinely different backtest shape from
 * SeasonalityService's — that one buckets returns into one signal/hold window per calendar year,
 * this one is a continuous day-by-day state machine — so it gets its own simulator rather than
 * reusing buildDailySeries.
 *
 * Look-ahead avoidance: each day's position is decided from the PRIOR trading day's VIX close,
 * never the same day's — you can't act on a closing print before it exists.
 */
@Service
public class VixTimingService {

    private static final double ENTER_VIX = 30.0;
    private static final double EXIT_VIX = 15.0;
    private static final int TRADING_DAYS_PER_YEAR = 252;

    private final FredClient fredClient;
    private final YahooFinanceService yahooFinanceService;
    private final FxRateService fxRateService;

    public VixTimingService(FredClient fredClient, YahooFinanceService yahooFinanceService, FxRateService fxRateService) {
        this.fredClient = fredClient;
        this.yahooFinanceService = yahooFinanceService;
        this.fxRateService = fxRateService;
    }

    @SuppressWarnings("unchecked")
    public Map<String, Object> runBacktest(VixTimingRequest req) {
        if (req.yearFrom > req.yearTo) {
            throw new IllegalArgumentException("yearFrom must be <= yearTo");
        }
        String currency = req.currency == null ? "USD" : req.currency.toUpperCase();
        if (!currency.equals("USD") && !currency.equals("EUR")) {
            throw new IllegalArgumentException("currency must be USD or EUR");
        }
        double cashAnnualRate = req.cashAnnualRate;

        NavigableMap<LocalDate, BigDecimal> vix = (NavigableMap<LocalDate, BigDecimal>) fredClient.fetchSeries("VIXCLS");
        NavigableMap<LocalDate, BigDecimal> spy = yahooFinanceService.fetchDailyCloses("SPY");
        NavigableMap<LocalDate, BigDecimal> urth = yahooFinanceService.fetchDailyCloses("URTH");
        NavigableMap<LocalDate, BigDecimal> usdPerEur = currency.equals("EUR")
                ? (NavigableMap<LocalDate, BigDecimal>) fxRateService.getUsdPerLocal("EUR") : null;

        LocalDate rangeStart = LocalDate.of(req.yearFrom, 1, 1);
        LocalDate today = LocalDate.now();
        LocalDate rangeEnd = req.yearTo >= today.getYear() ? today : LocalDate.of(req.yearTo, 12, 31);

        List<LocalDate> tradingDays = new ArrayList<>(spy.subMap(rangeStart, true, rangeEnd, true).keySet());
        if (tradingDays.size() < 2) {
            throw new IllegalStateException("Not enough S&P 500 data for " + req.yearFrom + "-" + req.yearTo);
        }

        boolean includeMsciWorld = !urth.isEmpty() && !urth.firstKey().isAfter(rangeStart);

        boolean inEquity = false;
        Double vix0 = floorValue(vix, tradingDays.get(0));
        if (vix0 != null && vix0 >= ENTER_VIX) inEquity = true;

        double strategyWealth = 1.0, strategyPeak = 1.0, strategyMaxDD = 0.0;
        double sp500Wealth = 1.0, sp500Peak = 1.0, sp500MaxDD = 0.0;
        double msciWealth = 1.0, msciPeak = 1.0, msciMaxDD = 0.0;
        List<Double> strategyDaily = new ArrayList<>();
        List<Double> sp500Daily = new ArrayList<>();
        List<Double> msciDaily = new ArrayList<>();
        int daysInEquity = 0, daysInCash = 0;

        Map<Integer, Map<String, Object>> cumulativeByYear = new LinkedHashMap<>();
        List<Map<String, Object>> trades = new ArrayList<>();
        Map<String, Object> openTrade = null;
        double tradeMultiplier = 1.0;
        if (inEquity) {
            openTrade = new LinkedHashMap<>();
            openTrade.put("entryDate", tradingDays.get(0).toString());
            openTrade.put("vixAtEntry", vix0);
        }

        for (int i = 1; i < tradingDays.size(); i++) {
            LocalDate prevDay = tradingDays.get(i - 1);
            LocalDate day = tradingDays.get(i);

            double sp500Ret = usdReturn(spy, prevDay, day);
            double sp500RetInCcy = currency.equals("EUR") ? fxAdjust(usdPerEur, prevDay, day, sp500Ret) : sp500Ret;
            double strategyRet = inEquity ? sp500RetInCcy : cashReturn(cashAnnualRate, prevDay, day);
            if (inEquity) { daysInEquity++; tradeMultiplier *= 1.0 + strategyRet; } else { daysInCash++; }

            strategyWealth *= 1.0 + strategyRet;
            strategyPeak = Math.max(strategyPeak, strategyWealth);
            strategyMaxDD = Math.min(strategyMaxDD, (strategyWealth - strategyPeak) / strategyPeak);
            strategyDaily.add(strategyRet);

            sp500Wealth *= 1.0 + sp500RetInCcy;
            sp500Peak = Math.max(sp500Peak, sp500Wealth);
            sp500MaxDD = Math.min(sp500MaxDD, (sp500Wealth - sp500Peak) / sp500Peak);
            sp500Daily.add(sp500RetInCcy);

            if (includeMsciWorld) {
                BigDecimal urthPrev = urth.get(prevDay), urthCur = urth.get(day);
                if (urthPrev != null && urthCur != null) {
                    double msciRet = urthCur.subtract(urthPrev).divide(urthPrev, MathContext.DECIMAL64).doubleValue();
                    double msciRetInCcy = currency.equals("EUR") ? fxAdjust(usdPerEur, prevDay, day, msciRet) : msciRet;
                    msciWealth *= 1.0 + msciRetInCcy;
                    msciPeak = Math.max(msciPeak, msciWealth);
                    msciMaxDD = Math.min(msciMaxDD, (msciWealth - msciPeak) / msciPeak);
                    msciDaily.add(msciRetInCcy);
                }
            }

            Map<String, Object> yearPoint = cumulativeByYear.computeIfAbsent(day.getYear(), y -> new LinkedHashMap<>(Map.of("year", y)));
            yearPoint.put("cumulativeStrategy", strategyWealth - 1.0);
            yearPoint.put("cumulativeSp500", sp500Wealth - 1.0);
            if (includeMsciWorld) yearPoint.put("cumulativeMsciWorld", msciWealth - 1.0);

            // Position for the NEXT day is decided from TODAY's now-known close.
            Double vixToday = floorValue(vix, day);
            if (vixToday != null) {
                if (!inEquity && vixToday >= ENTER_VIX) {
                    inEquity = true;
                    tradeMultiplier = 1.0;
                    openTrade = new LinkedHashMap<>();
                    openTrade.put("entryDate", day.toString());
                    openTrade.put("vixAtEntry", vixToday);
                } else if (inEquity && vixToday <= EXIT_VIX) {
                    inEquity = false;
                    if (openTrade != null) {
                        openTrade.put("exitDate", day.toString());
                        openTrade.put("vixAtExit", vixToday);
                        openTrade.put("tradeReturn", tradeMultiplier - 1.0);
                        openTrade.put("open", false);
                        trades.add(openTrade);
                        openTrade = null;
                    }
                }
            }
        }
        if (openTrade != null) {
            openTrade.put("exitDate", null);
            openTrade.put("vixAtExit", null);
            openTrade.put("tradeReturn", tradeMultiplier - 1.0);
            openTrade.put("open", true);
            trades.add(openTrade);
        }

        double yearsElapsed = ChronoUnit.DAYS.between(tradingDays.get(0), tradingDays.get(tradingDays.size() - 1)) / 365.25;

        Map<String, Object> result = new LinkedHashMap<>();
        Map<String, Object> meta = new LinkedHashMap<>();
        meta.put("yearFrom", req.yearFrom);
        meta.put("yearTo", req.yearTo);
        meta.put("currency", currency);
        meta.put("cashAnnualRate", cashAnnualRate);
        meta.put("enterVix", ENTER_VIX);
        meta.put("exitVix", EXIT_VIX);
        meta.put("tradingDays", tradingDays.size());
        result.put("meta", meta);

        result.put("cumulative", cumulativeByYear.values().stream().toList());
        result.put("msciWorldAvailable", includeMsciWorld);

        Map<String, Object> stats = new LinkedHashMap<>();
        stats.put("strategy", statBlock(strategyWealth, strategyMaxDD, strategyDaily, yearsElapsed));
        stats.put("sp500", statBlock(sp500Wealth, sp500MaxDD, sp500Daily, yearsElapsed));
        if (includeMsciWorld) stats.put("msciWorld", statBlock(msciWealth, msciMaxDD, msciDaily, yearsElapsed));
        result.put("stats", stats);

        result.put("trades", trades);
        result.put("tradesCount", trades.size());
        result.put("daysInEquity", daysInEquity);
        result.put("daysInCash", daysInCash);
        result.put("pctTimeInEquity", (daysInEquity + daysInCash) == 0 ? 0.0 : (double) daysInEquity / (daysInEquity + daysInCash));

        return result;
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

    /** A EUR investor converts EUR->USD to buy a USD asset and back on the way out, so their
     * return also carries the EUR/USD move: ret_eur = (fx0/fx1) * (1+ret_usd) - 1, where fx is
     * "USD per 1 EUR" (FxRateService's convention). Falls back to the raw USD return on days
     * without an FX quote rather than dropping the day. */
    private double fxAdjust(NavigableMap<LocalDate, BigDecimal> usdPerEur, LocalDate prevDay, LocalDate day, double usdReturn) {
        Double fx0 = floorValue(usdPerEur, prevDay);
        Double fx1 = floorValue(usdPerEur, day);
        if (fx0 == null || fx1 == null) return usdReturn;
        return (fx0 / fx1) * (1.0 + usdReturn) - 1.0;
    }

    /** Cash accrues over EVERY calendar day (weekends included), not just trading days. */
    private double cashReturn(double annualRate, LocalDate prevDay, LocalDate day) {
        long calendarDays = ChronoUnit.DAYS.between(prevDay, day);
        return Math.pow(1.0 + annualRate, calendarDays / 365.0) - 1.0;
    }

    private Double floorValue(NavigableMap<LocalDate, BigDecimal> series, LocalDate asOf) {
        Map.Entry<LocalDate, BigDecimal> e = series.floorEntry(asOf);
        return e == null ? null : e.getValue().doubleValue();
    }
}
