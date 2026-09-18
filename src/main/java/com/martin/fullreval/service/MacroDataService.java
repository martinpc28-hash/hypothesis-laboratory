package com.martin.fullreval.service;

import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.Map;
import java.util.NavigableMap;

/**
 * Macro context for the seasonality module's "does this signal hold up across economic regimes"
 * analysis (see SeasonalityService.runMacroInsights) — reuses FredClient (the same free,
 * no-API-key FRED source already powering HistoricalScenarioService's rate/vol/FX shocks and
 * FxRateService's currency conversion) for a handful of standard macro series, instead of
 * standing up a second data source just for this.
 *
 * Every reading is "as of" a caller-given date using the last PUBLISHED value on or before it
 * (NavigableMap.floorEntry) — never a value published later — so a snapshot computed as of the
 * end of a signal window only uses information that was actually available at the moment someone
 * would have acted on that signal. FredClient.fetchSeries is backed by a TreeMap internally (see
 * its source), so the unchecked cast to NavigableMap below is safe in practice.
 */
@Service
public class MacroDataService {

    private final FredClient fredClient;

    public MacroDataService(FredClient fredClient) {
        this.fredClient = fredClient;
    }

    /** All five series fetched once (each cached 1h by FredClient) and reused for every year's
     * snapshot — avoids re-fetching/re-parsing the same series once per year in a backtest loop. */
    public record MacroSeriesData(NavigableMap<LocalDate, BigDecimal> cpi, NavigableMap<LocalDate, BigDecimal> indpro,
                                   NavigableMap<LocalDate, BigDecimal> dgs10, NavigableMap<LocalDate, BigDecimal> curve,
                                   NavigableMap<LocalDate, BigDecimal> vix) {}

    /** inflationYoY/growthYoY: fractional year-over-year % change (0.042 = 4.2%). rateLevel:
     * 10-Year Treasury yield, already in percent as FRED publishes it (4.5 = 4.5%). rateChangeYoY:
     * change in that level over the past year, in percentage points. yieldCurveSlope: 10Y minus
     * 2Y yield, in percentage points — negative means an inverted curve, a classic recession
     * signal. vixAverage: the VIX index averaged over the signal window itself (not a single "as
     * of" snapshot like the others — it's meant to capture the risk backdrop DURING the window). */
    public record MacroSnapshot(Double inflationYoY, Double growthYoY, Double rateLevel,
                                 Double rateChangeYoY, Double yieldCurveSlope, Double vixAverage) {}

    @SuppressWarnings("unchecked")
    public MacroSeriesData fetchAll() {
        return new MacroSeriesData(
                (NavigableMap<LocalDate, BigDecimal>) fredClient.fetchSeries("CPIAUCSL"),
                (NavigableMap<LocalDate, BigDecimal>) fredClient.fetchSeries("INDPRO"),
                (NavigableMap<LocalDate, BigDecimal>) fredClient.fetchSeries("DGS10"),
                (NavigableMap<LocalDate, BigDecimal>) fredClient.fetchSeries("T10Y2Y"),
                (NavigableMap<LocalDate, BigDecimal>) fredClient.fetchSeries("VIXCLS")
        );
    }

    public MacroSnapshot snapshotFor(MacroSeriesData data, LocalDate windowStart, LocalDate windowEnd) {
        Double inflationYoY = yoyPctChange(data.cpi(), windowEnd);
        Double growthYoY = yoyPctChange(data.indpro(), windowEnd);
        Double rateLevel = valueAsOf(data.dgs10(), windowEnd);
        Double rateYearAgo = valueAsOf(data.dgs10(), windowEnd.minusYears(1));
        Double rateChangeYoY = (rateLevel != null && rateYearAgo != null) ? rateLevel - rateYearAgo : null;
        Double yieldCurveSlope = valueAsOf(data.curve(), windowEnd);
        Double vixAverage = averageInRange(data.vix(), windowStart, windowEnd);
        return new MacroSnapshot(inflationYoY, growthYoY, rateLevel, rateChangeYoY, yieldCurveSlope, vixAverage);
    }

    private Double valueAsOf(NavigableMap<LocalDate, BigDecimal> series, LocalDate date) {
        Map.Entry<LocalDate, BigDecimal> e = series.floorEntry(date);
        return e == null ? null : e.getValue().doubleValue();
    }

    private Double yoyPctChange(NavigableMap<LocalDate, BigDecimal> series, LocalDate asOf) {
        Double current = valueAsOf(series, asOf);
        Double yearAgo = valueAsOf(series, asOf.minusYears(1));
        if (current == null || yearAgo == null || yearAgo == 0.0) return null;
        return (current - yearAgo) / yearAgo;
    }

    /** Average of every published point within [from, to]; falls back to the single nearest
     * value as of `to` if the window is narrower than the series' own publishing gaps (e.g. a
     * 1-month signal window can still land between two data points for a sparser series). */
    private Double averageInRange(NavigableMap<LocalDate, BigDecimal> series, LocalDate from, LocalDate to) {
        NavigableMap<LocalDate, BigDecimal> sub = series.subMap(from, true, to, true);
        if (sub.isEmpty()) return valueAsOf(series, to);
        return sub.values().stream().mapToDouble(BigDecimal::doubleValue).average().orElse(Double.NaN);
    }
}
