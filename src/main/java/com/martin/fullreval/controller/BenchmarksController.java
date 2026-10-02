package com.martin.fullreval.controller;

import com.martin.fullreval.service.BenchmarksService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/api/benchmarks")
public class BenchmarksController {

    private final BenchmarksService benchmarksService;

    public BenchmarksController(BenchmarksService benchmarksService) {
        this.benchmarksService = benchmarksService;
    }

    @GetMapping
    public Map<String, Object> benchmarks() {
        return benchmarksService.run();
    }

    @ExceptionHandler({IllegalArgumentException.class, IllegalStateException.class})
    public ResponseEntity<Map<String, String>> handleBadRequest(RuntimeException e) {
        HttpStatus status = e instanceof IllegalArgumentException ? HttpStatus.BAD_REQUEST : HttpStatus.BAD_GATEWAY;
        return ResponseEntity.status(status).body(Map.of("error", e.getMessage()));
    }
}
