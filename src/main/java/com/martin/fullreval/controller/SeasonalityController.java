package com.martin.fullreval.controller;

import com.martin.fullreval.dto.SeasonalityMonteCarloRequest;
import com.martin.fullreval.dto.SeasonalitySweepRequest;
import com.martin.fullreval.dto.SeasonalityTestRequest;
import com.martin.fullreval.service.AssetUniverseService;
import com.martin.fullreval.service.SeasonalityService;
import com.martin.fullreval.service.marketdata.MarketDataSourceRegistry;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
@RequestMapping("/api/seasonality")
public class SeasonalityController {

    private final SeasonalityService seasonalityService;
    private final AssetUniverseService assetUniverseService;
    private final MarketDataSourceRegistry sourceRegistry;

    public SeasonalityController(SeasonalityService seasonalityService, AssetUniverseService assetUniverseService,
                                  MarketDataSourceRegistry sourceRegistry) {
        this.seasonalityService = seasonalityService;
        this.assetUniverseService = assetUniverseService;
        this.sourceRegistry = sourceRegistry;
    }

    /** Preloaded, representative asset lists (countries + sectors) for the checkbox pickers. */
    @GetMapping("/universe")
    public Map<String, Object> universe() {
        return assetUniverseService.listAll();
    }

    /** Which data sources exist and which are actually usable (have an API key configured). */
    @GetMapping("/sources")
    public Object sources() {
        return sourceRegistry.listAll();
    }

    @PostMapping("/test")
    public Map<String, Object> test(@RequestBody SeasonalityTestRequest req) {
        return seasonalityService.runTest(req);
    }

    @PostMapping("/sweep")
    public Map<String, Object> sweep(@RequestBody SeasonalitySweepRequest req) {
        return seasonalityService.runSweep(req);
    }

    /** Combinatorial optimizer: evaluates every valid (universe, signal window) combination
     * and ranks them by risk-adjusted return, instead of testing one at a time by hand. */
    @PostMapping("/montecarlo")
    public Map<String, Object> montecarlo(@RequestBody SeasonalityMonteCarloRequest req) {
        return seasonalityService.runMonteCarlo(req);
    }

    /** Macro regime insights for a fixed ticker set: does this combo's edge hold up across
     * inflation/growth/rate/yield-curve/VIX regimes, or is it concentrated in one of them? */
    @PostMapping("/macro-insights")
    public Map<String, Object> macroInsights(@RequestBody SeasonalityTestRequest req) {
        return seasonalityService.runMacroInsights(req);
    }

    @ExceptionHandler({IllegalArgumentException.class, IllegalStateException.class})
    public ResponseEntity<Map<String, String>> handleBadRequest(RuntimeException e) {
        HttpStatus status = e instanceof IllegalArgumentException ? HttpStatus.BAD_REQUEST : HttpStatus.BAD_GATEWAY;
        return ResponseEntity.status(status).body(Map.of("error", e.getMessage()));
    }
}
