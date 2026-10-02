package com.martin.fullreval.controller;

import com.martin.fullreval.dto.IlliquidsRequest;
import com.martin.fullreval.service.IlliquidsService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/illiquids")
public class IlliquidsController {

    private final IlliquidsService illiquidsService;

    public IlliquidsController(IlliquidsService illiquidsService) {
        this.illiquidsService = illiquidsService;
    }

    @GetMapping("/sleeves")
    public List<Map<String, Object>> sleeves() {
        return illiquidsService.describeSleeves();
    }

    @PostMapping("/portfolio")
    public Map<String, Object> portfolio(@RequestBody IlliquidsRequest req) {
        return illiquidsService.run(req);
    }

    @ExceptionHandler({IllegalArgumentException.class, IllegalStateException.class})
    public ResponseEntity<Map<String, String>> handleBadRequest(RuntimeException e) {
        HttpStatus status = e instanceof IllegalArgumentException ? HttpStatus.BAD_REQUEST : HttpStatus.BAD_GATEWAY;
        return ResponseEntity.status(status).body(Map.of("error", e.getMessage()));
    }
}
