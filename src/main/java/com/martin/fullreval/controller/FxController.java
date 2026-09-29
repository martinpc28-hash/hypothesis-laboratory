package com.martin.fullreval.controller;

import com.martin.fullreval.service.FxRateService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.NavigableMap;

@RestController
@RequestMapping("/api/fx")
public class FxController {

    private final FxRateService fxRateService;

    public FxController(FxRateService fxRateService) {
        this.fxRateService = fxRateService;
    }

    /** Year-end (Dec 31, or the nearest earlier trading day FRED published) USD-per-EUR rate for
     * every year in [yearFrom, yearTo] — enough granularity for the Portfolio Calculator to convert
     * a USD-only strategy's ANNUAL returns to their EUR-investor equivalent (it never works with
     * daily returns to begin with — see PortfolioCalculatorTab's own disclosed limitation), without
     * shipping FRED's full daily series to the frontend. */
    @GetMapping("/eur-usd-year-end")
    public Map<String, Object> eurUsdYearEnd(@RequestParam int yearFrom, @RequestParam int yearTo) {
        NavigableMap<LocalDate, BigDecimal> usdPerEur = fxRateService.getUsdPerLocal("EUR");
        List<Map<String, Object>> rows = new ArrayList<>();
        for (int y = yearFrom; y <= yearTo; y++) {
            Map.Entry<LocalDate, BigDecimal> entry = usdPerEur.floorEntry(LocalDate.of(y, 12, 31));
            if (entry == null) continue;
            rows.add(Map.of("year", y, "usdPerEur", entry.getValue().doubleValue()));
        }
        return Map.of("rates", rows);
    }
}
