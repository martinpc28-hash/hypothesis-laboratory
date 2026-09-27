package com.martin.fullreval.controller;

import com.martin.fullreval.dto.CreditRotationRequest;
import com.martin.fullreval.dto.CreditRotationSweepRequest;
import com.martin.fullreval.service.CreditRotationService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/api/credit-rotation")
public class CreditRotationController {

    private final CreditRotationService creditRotationService;

    public CreditRotationController(CreditRotationService creditRotationService) {
        this.creditRotationService = creditRotationService;
    }

    @GetMapping("/features")
    public Object features() {
        return CreditRotationService.FEATURES;
    }

    @PostMapping("/backtest")
    public Map<String, Object> backtest(@RequestBody CreditRotationRequest req) {
        return creditRotationService.runBacktest(req);
    }

    @PostMapping("/sweep")
    public Map<String, Object> sweep(@RequestBody CreditRotationSweepRequest req) {
        return creditRotationService.sweep(req);
    }

    @ExceptionHandler({IllegalArgumentException.class, IllegalStateException.class})
    public ResponseEntity<Map<String, String>> handleBadRequest(RuntimeException e) {
        HttpStatus status = e instanceof IllegalArgumentException ? HttpStatus.BAD_REQUEST : HttpStatus.BAD_GATEWAY;
        return ResponseEntity.status(status).body(Map.of("error", e.getMessage()));
    }
}
