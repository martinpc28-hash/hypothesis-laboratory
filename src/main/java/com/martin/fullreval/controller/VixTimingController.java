package com.martin.fullreval.controller;

import com.martin.fullreval.dto.VixTimingRequest;
import com.martin.fullreval.service.VixTimingService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/api/vix-timing")
public class VixTimingController {

    private final VixTimingService vixTimingService;

    public VixTimingController(VixTimingService vixTimingService) {
        this.vixTimingService = vixTimingService;
    }

    @PostMapping("/backtest")
    public Map<String, Object> backtest(@RequestBody VixTimingRequest req) {
        return vixTimingService.runBacktest(req);
    }

    @ExceptionHandler({IllegalArgumentException.class, IllegalStateException.class})
    public ResponseEntity<Map<String, String>> handleBadRequest(RuntimeException e) {
        HttpStatus status = e instanceof IllegalArgumentException ? HttpStatus.BAD_REQUEST : HttpStatus.BAD_GATEWAY;
        return ResponseEntity.status(status).body(Map.of("error", e.getMessage()));
    }
}
