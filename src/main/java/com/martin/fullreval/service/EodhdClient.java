package com.martin.fullreval.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.math.BigDecimal;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.Collections;
import java.util.Map;
import java.util.NavigableMap;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Thin client for EODHD's (eodhistoricaldata.com) paid end-of-day API — used ONLY for real
 * EUR-denominated European mutual fund NAV history, which Yahoo Finance's free API doesn't carry
 * deep history for (every European mutual fund tried there was capped to the last ~3-4 years,
 * regardless of the underlying fund's real age — a data-license limit, not a reflection of how
 * old the fund actually is). EODHD's "EUFUND" virtual exchange covers ~2000+ European funds with
 * real daily NAV back to their actual inception, including funds launched before 2000 — e.g.
 * Candriam Bonds Euro High Yield (LU0012119607.EUFUND, since 1999-12-28) and DPAM Bonds L -
 * Corporate EUR (LU0029260675.EUFUND, since 2000-01-03), used by CreditRotationService as the
 * real EUR-native legs of the credit rotation strategy — no FX conversion needed for either.
 *
 * The API key is read from the EODHD_API_KEY environment variable — NEVER hardcoded — set via
 * AWS SSM Parameter Store (/full-revaluation/eodhd-api-key) and exported by /opt/app/start.sh on
 * the production box, the same pattern already used there for the database password.
 */
@Service
public class EodhdClient {

    private static final String EOD_URL = "https://eodhistoricaldata.com/api/eod/";
    private static final Duration TIMEOUT = Duration.ofSeconds(15);
    private static final Duration CACHE_TTL = Duration.ofHours(1);

    private final HttpClient httpClient;
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final Map<String, CacheEntry> cache = new ConcurrentHashMap<>();
    private final String apiKey;

    public EodhdClient() {
        this.httpClient = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .connectTimeout(TIMEOUT)
                .build();
        this.apiKey = System.getenv("EODHD_API_KEY");
    }

    /** Full available daily NAV history for an EODHD symbol (e.g. "LU0012119607.EUFUND"), keyed
     * by date, using the adjusted close (identical to raw close for the accumulating/capitalisation
     * fund share classes this project uses, but the more correct field to prefer in general).
     * Returns an empty map (never null, never throws) if no API key is configured, the symbol is
     * invalid, or EODHD can't be reached — callers should treat "no data" as "nothing available". */
    public NavigableMap<LocalDate, BigDecimal> fetchDailyCloses(String symbol) {
        if (apiKey == null || apiKey.isBlank()) {
            return Collections.emptyNavigableMap();
        }
        CacheEntry cached = cache.get(symbol);
        if (cached != null && cached.fetchedAt.plus(CACHE_TTL).isAfter(Instant.now())) {
            return cached.closes;
        }

        NavigableMap<LocalDate, BigDecimal> closes;
        try {
            closes = fetchFromEodhd(symbol);
        } catch (Exception e) {
            closes = Collections.emptyNavigableMap();
        }
        cache.put(symbol, new CacheEntry(closes, Instant.now()));
        return closes;
    }

    private NavigableMap<LocalDate, BigDecimal> fetchFromEodhd(String symbol) throws IOException, InterruptedException {
        String url = EOD_URL + symbol + "?api_token=" + apiKey + "&fmt=json&period=d&from=1990-01-01";
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(TIMEOUT)
                .GET()
                .build();

        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 200) {
            throw new IOException("EODHD returned HTTP " + response.statusCode() + " for " + symbol);
        }

        JsonNode root = objectMapper.readTree(response.body());
        if (!root.isArray()) {
            throw new IOException("EODHD returned no data for " + symbol);
        }

        TreeMap<LocalDate, BigDecimal> closesByDate = new TreeMap<>();
        for (JsonNode row : root) {
            JsonNode dateNode = row.path("date");
            JsonNode closeNode = row.path("adjusted_close");
            if (closeNode.isMissingNode() || closeNode.isNull()) closeNode = row.path("close");
            if (dateNode.isMissingNode() || closeNode.isMissingNode() || closeNode.isNull()) continue;
            closesByDate.put(LocalDate.parse(dateNode.asText()), BigDecimal.valueOf(closeNode.asDouble()));
        }
        return closesByDate;
    }

    private record CacheEntry(NavigableMap<LocalDate, BigDecimal> closes, Instant fetchedAt) {}
}
