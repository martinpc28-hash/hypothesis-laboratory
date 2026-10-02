package com.martin.fullreval.controller;

import com.martin.fullreval.dto.SmallCapsRequest;
import com.martin.fullreval.service.SmallCapsService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/api/small-caps")
public class SmallCapsController {

    private final SmallCapsService smallCapsService;

    public SmallCapsController(SmallCapsService smallCapsService) {
        this.smallCapsService = smallCapsService;
    }

    @PostMapping("/backtest")
    public Map<String, Object> backtest(@RequestBody SmallCapsRequest req) {
        return smallCapsService.backtest(req);
    }

    @PostMapping("/bootstrap")
    public Map<String, Object> bootstrap(@RequestBody SmallCapsRequest req) {
        return smallCapsService.bootstrap(req);
    }

    @PostMapping("/montecarlo")
    public Map<String, Object> monteCarlo(@RequestBody SmallCapsRequest req) {
        return smallCapsService.monteCarlo(req);
    }

    @ExceptionHandler({IllegalArgumentException.class, IllegalStateException.class})
    public ResponseEntity<Map<String, String>> handleBadRequest(RuntimeException e) {
        HttpStatus status = e instanceof IllegalArgumentException ? HttpStatus.BAD_REQUEST : HttpStatus.BAD_GATEWAY;
        return ResponseEntity.status(status).body(Map.of("error", String.valueOf(e.getMessage())));
    }
}
