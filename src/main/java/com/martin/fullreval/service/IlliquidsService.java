package com.martin.fullreval.service;

import com.martin.fullreval.dto.IlliquidsRequest;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.math.MathContext;
import java.time.DayOfWeek;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NavigableMap;
import java.util.Set;

/**
 * A portfolio of "illiquid" asset classes (real estate, private credit, infrastructure, private equity),
 * held with fixed target weights and rebalanced every January.
 *
 * Illiquid assets have no daily price: their reported returns come from quarterly appraisals, which smooth
 * out the real swings (private real estate "lost" far less in 2008 than listed REITs did). So each sleeve is
 * represented by a LISTED PROXY with real daily prices, not by an invented fixed yield:
 *   - real estate ......... VGSIX  (Vanguard Real Estate Index, REITs)
 *   - private credit ...... FFRHX  (Fidelity Floating Rate High Income, floating-rate loans), data from 2000-09
 *   - infrastructure ...... XLU    (Utilities Select Sector SPDR)
 *   - private equity ...... VISVX  (Vanguard Small-Cap Value Index — the classic academic stand-in)
 * plus two optional listed variants with a shorter history (PSP from 2006-11, CSUAX from 2004-05).
 *
 * Two curves come out of the same holdings: the proxy ("strategy", the real economic path) and a
 * "reported" curve that mimics quarterly appraisals — wealth only moves at quarter ends, and only a fraction
 * ALPHA of the gap to the true value is recognised each time (Geltner-style partial adjustment). Comparing the
 * two is the point: it shows how much risk an appraisal-based report hides.
 */
@Service
public class IlliquidsService {

    /** Share of the gap between reported and true value that an appraisal recognises each quarter. */
    private static final double ALPHA = 0.4;
    private static final double TRADING_DAYS = 252.0;

    private record SleeveDef(String key, String label, String ticker, String note) {}

    private static final List<SleeveDef> SLEEVES = List.of(
            new SleeveDef("REAL_ESTATE", "Inmobiliario", "VGSIX",
                    "REIT cotizados (Vanguard Real Estate Index): proxy del inmobiliario privado"),
            new SleeveDef("PRIVATE_CREDIT", "Crédito privado", "FFRHX",
                    "Préstamos corporativos flotantes (Fidelity Floating Rate High Income): proxy del direct lending. Historia desde 2000-09"),
            new SleeveDef("INFRASTRUCTURE", "Infraestructura", "XLU",
                    "Utilities de EE. UU. (Utilities Select Sector SPDR): proxy de infraestructura regulada"),
            new SleeveDef("PRIVATE_EQUITY", "Capital privado", "VISVX",
                    "Small caps value (Vanguard Small-Cap Value Index): sustituto clásico, NO es capital privado cotizado"),
            new SleeveDef("PRIVATE_EQUITY_LISTED", "Capital privado cotizado", "PSP",
                    "Invesco Global Listed Private Equity: gestoras y vehículos de capital privado que cotizan. Historia desde 2006-11"),
            new SleeveDef("INFRA_LISTED", "Infraestructura global cotizada", "CSUAX",
                    "Cohen & Steers Global Infrastructure: infraestructura cotizada global. Historia desde 2004-05"));

    private final YahooFinanceService yahooFinanceService;

    public IlliquidsService(YahooFinanceService yahooFinanceService) {
        this.yahooFinanceService = yahooFinanceService;
    }

    public List<Map<String, Object>> describeSleeves() {
        List<Map<String, Object>> out = new ArrayList<>();
        for (SleeveDef s : SLEEVES) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("key", s.key());
            m.put("label", s.label());
            m.put("ticker", s.ticker());
            m.put("note", s.note());
            out.add(m);
        }
        return out;
    }

    /** One wealth curve plus the daily returns and drawdown that produced it. */
    private static final class Track {
        double level = 1.0, peak = 1.0, maxDrawdown = 0.0;
        final List<Double> returns = new ArrayList<>();

        void applyReturn(double r) {
            setLevel(level * (1.0 + r));
        }

        void setLevel(double newLevel) {
            returns.add(level == 0 ? 0.0 : newLevel / level - 1.0);
            level = newLevel;
            peak = Math.max(peak, level);
            maxDrawdown = Math.min(maxDrawdown, (level - peak) / peak);
        }

        Map<String, Object> stats(double years) {
            double mean = returns.stream().mapToDouble(d -> d).average().orElse(0);
            double var = returns.size() > 1
                    ? returns.stream().mapToDouble(r -> Math.pow(r - mean, 2)).sum() / (returns.size() - 1) : 0;
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("totalReturn", level - 1.0);
            m.put("cagr", years <= 0 ? 0.0 : Math.pow(level, 1.0 / years) - 1.0);
            m.put("volatility", Math.sqrt(var) * Math.sqrt(TRADING_DAYS));
            m.put("maxDrawdown", maxDrawdown);
            return m;
        }
    }

    public Map<String, Object> run(IlliquidsRequest req) {
        if (req.sleeves == null || req.sleeves.isEmpty()) {
            throw new IllegalArgumentException("Elegí al menos un tipo de activo ilíquido");
        }
        if (req.yearFrom > req.yearTo) {
            throw new IllegalArgumentException("yearFrom must not be after yearTo");
        }

        List<SleeveDef> defs = new ArrayList<>();
        List<Double> weights = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (IlliquidsRequest.Sleeve s : req.sleeves) {
            if (s.weight <= 0) continue;
            SleeveDef def = SLEEVES.stream().filter(d -> d.key().equals(s.key)).findFirst()
                    .orElseThrow(() -> new IllegalArgumentException("Unknown sleeve: " + s.key));
            if (!seen.add(def.key())) throw new IllegalArgumentException("Duplicated sleeve: " + def.key());
            defs.add(def);
            weights.add(s.weight);
        }
        if (defs.isEmpty()) {
            throw new IllegalArgumentException("Todos los pesos son 0 — poné al menos uno mayor a 0");
        }
        double weightSum = weights.stream().mapToDouble(d -> d).sum();
        double[] w = weights.stream().mapToDouble(d -> d / weightSum).toArray();

        NavigableMap<LocalDate, BigDecimal> spy = yahooFinanceService.fetchAdjustedDailyCloses("SPY");
        List<NavigableMap<LocalDate, BigDecimal>> closes = new ArrayList<>();
        LocalDate latestStart = null;
        for (SleeveDef d : defs) {
            NavigableMap<LocalDate, BigDecimal> c = yahooFinanceService.fetchAdjustedDailyCloses(d.ticker());
            if (c.isEmpty()) throw new IllegalStateException("Sin datos de " + d.ticker() + " (" + d.label() + ")");
            closes.add(c);
            if (latestStart == null || c.firstKey().isAfter(latestStart)) latestStart = c.firstKey();
        }
        if (spy.isEmpty()) throw new IllegalStateException("Sin datos del S&P 500 (SPY)");

        // Start in January of a full calendar year: if the newest sleeve began mid-year, skip to the next
        // January so the first yearly return isn't a partial year dressed up as a full one.
        LocalDate start = LocalDate.of(req.yearFrom, 1, 1);
        if (latestStart.isAfter(start)) {
            start = (latestStart.getMonthValue() > 1 || latestStart.getDayOfMonth() > 10)
                    ? LocalDate.of(latestStart.getYear() + 1, 1, 1) : latestStart;
        }
        LocalDate today = LocalDate.now();
        LocalDate end = req.yearTo >= today.getYear() ? today : LocalDate.of(req.yearTo, 12, 31);
        if (start.isAfter(end)) {
            throw new IllegalArgumentException("Con esa combinación los datos empiezan en " + latestStart
                    + ": elegí un rango que termine después");
        }

        List<LocalDate> days = new ArrayList<>(spy.subMap(start, true, end, true).keySet());
        if (days.size() < 2) throw new IllegalStateException("No hay suficientes días de datos entre " + start + " y " + end);

        int n = defs.size();
        double[] holdings = w.clone();
        Track portfolio = new Track();
        Track reported = new Track();
        Track spyTrack = new Track();
        Track[] sleeveTracks = new Track[n];
        for (int i = 0; i < n; i++) sleeveTracks[i] = new Track();

        Map<Integer, Map<String, Object>> byYear = new LinkedHashMap<>();
        List<Map<String, Object>> weekly = new ArrayList<>();

        for (int d = 1; d < days.size(); d++) {
            LocalDate prev = days.get(d - 1);
            LocalDate day = days.get(d);

            if (day.getYear() != prev.getYear()) {
                double total = 0;
                for (double h : holdings) total += h;
                for (int i = 0; i < n; i++) holdings[i] = total * w[i];
            }
            for (int i = 0; i < n; i++) {
                double r = dailyReturn(closes.get(i), prev, day);
                holdings[i] *= 1.0 + r;
                sleeveTracks[i].applyReturn(r);
            }
            double wealth = 0;
            for (double h : holdings) wealth += h;
            portfolio.setLevel(wealth);
            spyTrack.applyReturn(dailyReturn(spy, prev, day));

            // Appraisal-style "reported" value: only moves at quarter ends, and only partway to the true value.
            boolean lastDay = d == days.size() - 1;
            boolean monthEnd = lastDay || days.get(d + 1).getMonthValue() != day.getMonthValue();
            if (monthEnd && day.getMonthValue() % 3 == 0) {
                reported.setLevel(reported.level + ALPHA * (wealth - reported.level));
            } else {
                reported.setLevel(reported.level);
            }

            Map<String, Object> yp = byYear.computeIfAbsent(day.getYear(), y -> new LinkedHashMap<>(Map.of("year", y)));
            yp.put("cumulativeStrategy", portfolio.level - 1.0);
            yp.put("cumulativeReported", reported.level - 1.0);
            yp.put("cumulativeSp500", spyTrack.level - 1.0);
            for (int i = 0; i < n; i++) yp.put("cumulative_" + defs.get(i).key(), sleeveTracks[i].level - 1.0);

            if (day.getDayOfWeek() == DayOfWeek.FRIDAY || lastDay) {
                Map<String, Object> wp = new LinkedHashMap<>();
                wp.put("date", day.toString());
                wp.put("cumulativeStrategy", portfolio.level - 1.0);
                wp.put("cumulativeReported", reported.level - 1.0);
                wp.put("cumulativeSp500", spyTrack.level - 1.0);
                weekly.add(wp);
            }
        }

        double years = ChronoUnit.DAYS.between(days.get(0), days.get(days.size() - 1)) / 365.25;

        List<Map<String, Object>> sleeveMeta = new ArrayList<>();
        Map<String, Object> sleeveStats = new LinkedHashMap<>();
        for (int i = 0; i < n; i++) {
            SleeveDef def = defs.get(i);
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("key", def.key());
            m.put("label", def.label());
            m.put("ticker", def.ticker());
            m.put("note", def.note());
            m.put("weight", w[i]);
            m.put("dataStart", closes.get(i).firstKey().toString());
            sleeveMeta.add(m);
            sleeveStats.put(def.key(), sleeveTracks[i].stats(years));
        }

        Map<String, Object> meta = new LinkedHashMap<>();
        meta.put("currency", "USD");
        meta.put("yearFrom", req.yearFrom);
        meta.put("yearTo", req.yearTo);
        meta.put("effectiveYearFrom", days.get(0).getYear());
        meta.put("firstDay", days.get(0).toString());
        meta.put("lastDay", days.get(days.size() - 1).toString());
        meta.put("tradingDays", days.size());
        meta.put("appraisalAlpha", ALPHA);
        meta.put("sleeves", sleeveMeta);

        Map<String, Object> stats = new LinkedHashMap<>();
        stats.put("strategy", portfolio.stats(years));
        stats.put("reported", reported.stats(years));
        stats.put("sp500", spyTrack.stats(years));

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("meta", meta);
        result.put("cumulative", new ArrayList<>(byYear.values()));
        result.put("weekly", weekly);
        result.put("stats", stats);
        result.put("sleeveStats", sleeveStats);
        return result;
    }

    /** Return between two trading days using the last price on or before each date (funds and ETFs share the NYSE
     * calendar, but a stray missing day shouldn't turn into a 0% or a crash). */
    private double dailyReturn(NavigableMap<LocalDate, BigDecimal> closes, LocalDate prev, LocalDate day) {
        Map.Entry<LocalDate, BigDecimal> e0 = closes.floorEntry(prev);
        Map.Entry<LocalDate, BigDecimal> e1 = closes.floorEntry(day);
        if (e0 == null || e1 == null || e0.getValue().signum() == 0) return 0.0;
        return e1.getValue().subtract(e0.getValue()).divide(e0.getValue(), MathContext.DECIMAL64).doubleValue();
    }
}
