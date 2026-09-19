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

    /** Everything needed for the UI's "click this number to see where it comes from" panel: which
     * FRED series, the exact date(s)/value(s) actually used (which can differ from the requested
     * cutoff — e.g. CPI is only published monthly, so "as of Feb 15" floors to the last day of
     * January's release), the raw value(s), and a plain-text formula. windowStart/windowEnd are
     * only meaningful for a range-averaged feature (vixAverage); every other feature is a single
     * point-in-time read, so they're left null and requestedAsOf is the one relevant date. */
    public record FeatureAudit(String seriesId, String seriesName, LocalDate requestedAsOf,
                                LocalDate windowStart, LocalDate windowEnd,
                                LocalDate asOfDate, Double asOfValue, LocalDate priorDate, Double priorValue,
                                Integer observationCount, Double value, String formula) {}

    public record MacroSnapshotAudit(FeatureAudit inflationYoY, FeatureAudit growthYoY, FeatureAudit rateLevel,
                                      FeatureAudit rateChangeYoY, FeatureAudit yieldCurveSlope, FeatureAudit vixAverage) {}

    private static final String CPI_ID = "CPIAUCSL";
    private static final String CPI_NAME = "US Consumer Price Index (headline CPI, seasonally adjusted)";
    private static final String INDPRO_ID = "INDPRO";
    private static final String INDPRO_NAME = "US Industrial Production Index (a monthly, timelier proxy for GDP growth)";
    private static final String DGS10_ID = "DGS10";
    private static final String DGS10_NAME = "10-Year Treasury Constant Maturity Rate";
    private static final String CURVE_ID = "T10Y2Y";
    private static final String CURVE_NAME = "10-Year minus 2-Year Treasury yield spread (negative = inverted curve)";
    private static final String VIX_ID = "VIXCLS";
    private static final String VIX_NAME = "CBOE Volatility Index (VIX)";

    @SuppressWarnings("unchecked")
    public MacroSeriesData fetchAll() {
        return new MacroSeriesData(
                (NavigableMap<LocalDate, BigDecimal>) fredClient.fetchSeries(CPI_ID),
                (NavigableMap<LocalDate, BigDecimal>) fredClient.fetchSeries(INDPRO_ID),
                (NavigableMap<LocalDate, BigDecimal>) fredClient.fetchSeries(DGS10_ID),
                (NavigableMap<LocalDate, BigDecimal>) fredClient.fetchSeries(CURVE_ID),
                (NavigableMap<LocalDate, BigDecimal>) fredClient.fetchSeries(VIX_ID)
        );
    }

    public MacroSnapshot snapshotFor(MacroSeriesData data, LocalDate windowStart, LocalDate windowEnd) {
        MacroSnapshotAudit audit = auditFor(data, windowStart, windowEnd);
        return new MacroSnapshot(audit.inflationYoY().value(), audit.growthYoY().value(), audit.rateLevel().value(),
                audit.rateChangeYoY().value(), audit.yieldCurveSlope().value(), audit.vixAverage().value());
    }

    public MacroSnapshotAudit auditFor(MacroSeriesData data, LocalDate windowStart, LocalDate windowEnd) {
        return new MacroSnapshotAudit(
                yoyAudit(data.cpi(), CPI_ID, CPI_NAME, windowEnd, "%"),
                yoyAudit(data.indpro(), INDPRO_ID, INDPRO_NAME, windowEnd, "%"),
                levelAudit(data.dgs10(), DGS10_ID, DGS10_NAME, windowEnd),
                changeAudit(data.dgs10(), DGS10_ID, DGS10_NAME, windowEnd),
                levelAudit(data.curve(), CURVE_ID, CURVE_NAME, windowEnd),
                rangeAverageAudit(data.vix(), VIX_ID, VIX_NAME, windowStart, windowEnd)
        );
    }

    private Map.Entry<LocalDate, BigDecimal> floorEntry(NavigableMap<LocalDate, BigDecimal> series, LocalDate date) {
        return series.floorEntry(date);
    }

    private FeatureAudit levelAudit(NavigableMap<LocalDate, BigDecimal> series, String seriesId, String seriesName, LocalDate asOf) {
        Map.Entry<LocalDate, BigDecimal> e = floorEntry(series, asOf);
        Double value = e == null ? null : e.getValue().doubleValue();
        String formula = value == null ? null : String.format("Last published value on or before %s: %.2f", asOf, value);
        return new FeatureAudit(seriesId, seriesName, asOf, null, null,
                e == null ? null : e.getKey(), value, null, null, null, value, formula);
    }

    private FeatureAudit yoyAudit(NavigableMap<LocalDate, BigDecimal> series, String seriesId, String seriesName,
                                   LocalDate asOf, String unitSuffix) {
        Map.Entry<LocalDate, BigDecimal> cur = floorEntry(series, asOf);
        Map.Entry<LocalDate, BigDecimal> prior = floorEntry(series, asOf.minusYears(1));
        Double curVal = cur == null ? null : cur.getValue().doubleValue();
        Double priorVal = prior == null ? null : prior.getValue().doubleValue();
        Double value = null;
        String formula = null;
        if (curVal != null && priorVal != null && priorVal != 0.0) {
            value = (curVal - priorVal) / priorVal;
            formula = String.format("(%.2f − %.2f) / %.2f = %.2f%s (%s vs. %s)",
                    curVal, priorVal, priorVal, value * 100, unitSuffix, cur.getKey(), prior.getKey());
        }
        return new FeatureAudit(seriesId, seriesName, asOf, null, null,
                cur == null ? null : cur.getKey(), curVal, prior == null ? null : prior.getKey(), priorVal,
                null, value, formula);
    }

    private FeatureAudit changeAudit(NavigableMap<LocalDate, BigDecimal> series, String seriesId, String seriesName, LocalDate asOf) {
        Map.Entry<LocalDate, BigDecimal> cur = floorEntry(series, asOf);
        Map.Entry<LocalDate, BigDecimal> prior = floorEntry(series, asOf.minusYears(1));
        Double curVal = cur == null ? null : cur.getValue().doubleValue();
        Double priorVal = prior == null ? null : prior.getValue().doubleValue();
        Double value = null;
        String formula = null;
        if (curVal != null && priorVal != null) {
            value = curVal - priorVal;
            formula = String.format("%.2f − %.2f = %.2fpp (%s vs. %s)", curVal, priorVal, value, cur.getKey(), prior.getKey());
        }
        return new FeatureAudit(seriesId, seriesName + " (change vs. one year earlier)", asOf, null, null,
                cur == null ? null : cur.getKey(), curVal, prior == null ? null : prior.getKey(), priorVal,
                null, value, formula);
    }

    private FeatureAudit rangeAverageAudit(NavigableMap<LocalDate, BigDecimal> series, String seriesId, String seriesName,
                                            LocalDate from, LocalDate to) {
        NavigableMap<LocalDate, BigDecimal> sub = series.subMap(from, true, to, true);
        if (!sub.isEmpty()) {
            double avg = sub.values().stream().mapToDouble(BigDecimal::doubleValue).average().orElse(Double.NaN);
            String formula = String.format("Average of %d daily readings from %s through %s = %.2f",
                    sub.size(), sub.firstKey(), sub.lastKey(), avg);
            return new FeatureAudit(seriesId, seriesName, to, from, to, null, null, null, null, sub.size(), avg, formula);
        }
        // Window narrower than the series' own publishing gaps — fall back to the single nearest value.
        Map.Entry<LocalDate, BigDecimal> e = floorEntry(series, to);
        Double value = e == null ? null : e.getValue().doubleValue();
        String formula = value == null ? null
                : String.format("No readings published inside %s–%s; nearest is %s: %.2f", from, to, e.getKey(), value);
        return new FeatureAudit(seriesId, seriesName, to, from, to, e == null ? null : e.getKey(), value, null, null, 0, value, formula);
    }
}
