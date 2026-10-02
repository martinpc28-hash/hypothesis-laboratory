package com.martin.fullreval.service;

import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.math.MathContext;
import java.time.DayOfWeek;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NavigableMap;

/**
 * Reference series for the Calculadora, always available whichever strategies were run:
 * S&P 500 (SPY, dividends reinvested) and MSCI World (the real index, USD, price return — Yahoo has
 * no history for the net-total-return version). Both in USD; the frontend converts to EUR the same
 * way it does for every other USD-only series.
 */
@Service
public class BenchmarksService {

    private static final String MSCI_WORLD_TICKER = "^990100-USD-STRD";

    private final YahooFinanceService yahoo;

    public BenchmarksService(YahooFinanceService yahoo) {
        this.yahoo = yahoo;
    }

    public Map<String, Object> run() {
        List<Map<String, Object>> series = new ArrayList<>();
        addSeries(series, "S&P 500", "SPY", "rendimiento total (dividendos reinvertidos)", yahoo.fetchAdjustedDailyCloses("SPY"));
        addSeries(series, "MSCI World", MSCI_WORLD_TICKER, "índice de precio, sin dividendos", yahoo.fetchDailyCloses(MSCI_WORLD_TICKER));
        if (series.isEmpty()) throw new IllegalStateException("No se pudieron cargar los benchmarks (S&P 500 / MSCI World).");
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("currency", "USD");
        out.put("series", series);
        return out;
    }

    private void addSeries(List<Map<String, Object>> out, String name, String ticker, String basis,
                           NavigableMap<LocalDate, BigDecimal> closes) {
        if (closes == null || closes.isEmpty()) return;
        LocalDate from = LocalDate.of(1999, 12, 1);
        NavigableMap<LocalDate, BigDecimal> data = closes.tailMap(from, true);
        if (data.size() < 2) return;

        // Calendar-year returns from year-end (or last available) closes.
        List<Map<String, Object>> yearly = new ArrayList<>();
        for (int year = 2000; year <= LocalDate.now().getYear(); year++) {
            Map.Entry<LocalDate, BigDecimal> prev = data.floorEntry(LocalDate.of(year - 1, 12, 31));
            Map.Entry<LocalDate, BigDecimal> cur = data.floorEntry(LocalDate.of(year, 12, 31));
            if (prev == null || cur == null || prev.getKey().equals(cur.getKey())) continue;
            // A partial year (data for it ends well before December) isn't a calendar-year return.
            if (cur.getKey().isBefore(LocalDate.of(year, 12, 24)) && year < LocalDate.now().getYear()) continue;
            if (year == LocalDate.now().getYear()) continue;
            double ret = cur.getValue().subtract(prev.getValue()).divide(prev.getValue(), MathContext.DECIMAL64).doubleValue();
            yearly.add(Map.of("year", year, "return", ret));
        }

        // Weekly wealth (Friday, or the last trading day of a short week / of the data).
        List<Map<String, Object>> weekly = new ArrayList<>();
        BigDecimal base = data.firstEntry().getValue();
        LocalDate lastDay = data.lastKey();
        for (Map.Entry<LocalDate, BigDecimal> e : data.entrySet()) {
            LocalDate d = e.getKey();
            Map.Entry<LocalDate, BigDecimal> next = data.higherEntry(d);
            boolean weekEnd = next == null || d.getDayOfWeek() == DayOfWeek.FRIDAY
                    || next.getKey().get(java.time.temporal.IsoFields.WEEK_OF_WEEK_BASED_YEAR) != d.get(java.time.temporal.IsoFields.WEEK_OF_WEEK_BASED_YEAR)
                    || next.getKey().getYear() != d.getYear();
            if (!weekEnd && !d.equals(lastDay)) continue;
            double wealth = e.getValue().divide(base, MathContext.DECIMAL64).doubleValue();
            Map<String, Object> p = new LinkedHashMap<>();
            p.put("date", d.toString());
            p.put("cumulative", wealth - 1.0);
            weekly.add(p);
        }

        Map<String, Object> s = new LinkedHashMap<>();
        s.put("name", name);
        s.put("ticker", ticker);
        s.put("basis", basis);
        s.put("dataStart", data.firstKey().toString());
        s.put("dataEnd", lastDay.toString());
        s.put("yearly", yearly);
        s.put("weekly", weekly);
        out.add(s);
    }
}
