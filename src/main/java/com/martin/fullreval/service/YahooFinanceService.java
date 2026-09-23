package com.martin.fullreval.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.math.BigDecimal;
import java.math.MathContext;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.Collections;
import java.util.Map;
import java.util.NavigableMap;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Real per-ticker historical stock data, straight from Yahoo Finance's public
 * chart API (the same endpoint the Python `yfinance` package calls under the
 * hood — no official SDK, no API key). Two consumers:
 *   - RevaluationService: gives each Equity instrument its OWN real
 *     day-over-day return series, instead of sharing the portfolio-wide
 *     S&P 500 spot shock with every equity regardless of what it actually is.
 *   - SeasonalityService: needs actual price LEVELS (not just day-over-day
 *     returns) to compute cumulative returns over arbitrary windows, up to
 *     ~20 years back.
 *
 * A ticker's full available price history is fetched once (range=max) and
 * cached, rather than re-fetched per date range — the seasonality sweep alone
 * asks for the same ticker under 36 different windows in one request.
 */
@Service
public class YahooFinanceService {

    private static final Logger log = LoggerFactory.getLogger(YahooFinanceService.class);
    private static final String CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/";
    private static final Duration TIMEOUT = Duration.ofSeconds(10);
    private static final Duration CACHE_TTL = Duration.ofHours(1);

    private final HttpClient httpClient;
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final Map<String, CacheEntry> cache = new ConcurrentHashMap<>();

    public YahooFinanceService() {
        // Forced HTTP/1.1 defensively: FRED's CDN (Akamai) silently hangs Java's
        // default HTTP/2 client (see FredClient); Yahoo sits behind similar
        // infra, so avoid the same class of bug pre-emptively.
        this.httpClient = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .connectTimeout(TIMEOUT)
                .build();
    }

    /**
     * Full available daily close-price history for a ticker (as far back as
     * Yahoo has it), keyed by trading date. Returns an empty map (never null,
     * never throws) if the ticker is invalid or Yahoo can't be reached —
     * callers should treat "no data" as "nothing available", not as a crash.
     */
    public NavigableMap<LocalDate, BigDecimal> fetchDailyCloses(String ticker) {
        String key = ticker.trim().toUpperCase();
        CacheEntry cached = cache.get(key);
        if (cached != null && cached.fetchedAt.plus(CACHE_TTL).isAfter(Instant.now())) {
            return cached.closes;
        }

        NavigableMap<LocalDate, BigDecimal> closes;
        try {
            closes = fetchFromYahoo(key);
        } catch (Exception e) {
            log.warn("Could not fetch Yahoo Finance data for ticker '{}': {}", key, e.getMessage());
            closes = Collections.emptyNavigableMap();
        }
        cache.put(key, new CacheEntry(closes, Instant.now()));
        return closes;
    }

    /**
     * Day-over-day return series for a ticker, derived from fetchDailyCloses.
     * Used by RevaluationService to override the shared spot shock for equities.
     */
    public Map<LocalDate, BigDecimal> fetchDailyReturns(String ticker) {
        NavigableMap<LocalDate, BigDecimal> closes = fetchDailyCloses(ticker);
        Map<LocalDate, BigDecimal> returns = new TreeMap<>();
        LocalDate[] dates = closes.keySet().toArray(new LocalDate[0]);
        for (int i = 1; i < dates.length; i++) {
            BigDecimal prev = closes.get(dates[i - 1]);
            BigDecimal today = closes.get(dates[i]);
            returns.put(dates[i], today.subtract(prev).divide(prev, MathContext.DECIMAL64));
        }
        return returns;
    }

    private NavigableMap<LocalDate, BigDecimal> fetchFromYahoo(String ticker) throws IOException, InterruptedException {
        // Explicit period1/period2 instead of range=max: Yahoo silently DOWNSAMPLES
        // range=max to ~monthly bars for the older portion of the series even when
        // interval=1d is requested (confirmed empirically — range=max gave ~330
        // points over 27 years for XLK, i.e. ~monthly, while an explicit 20-26 year
        // period1/period2 window gives the full ~252 trading days/year). period1
        // fixed at 2000-01-01 covers the seasonality module's "up to ~20 years" need
        // with margin; period2 is "now".
        long period1 = java.time.LocalDate.of(2000, 1, 1).atStartOfDay(ZoneOffset.UTC).toEpochSecond();
        long period2 = Instant.now().getEpochSecond();
        // Index tickers (e.g. "^990100-USD-STRD" for MSCI World) contain a leading "^", which
        // URI.create() rejects unescaped — URL-encode the ticker before it goes in the path.
        String encodedTicker = URLEncoder.encode(ticker, StandardCharsets.UTF_8);
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(CHART_URL + encodedTicker + "?period1=" + period1 + "&period2=" + period2 + "&interval=1d"))
                .timeout(TIMEOUT)
                .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36")
                .GET()
                .build();

        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 200) {
            throw new IOException("Yahoo Finance returned HTTP " + response.statusCode() + " for " + ticker);
        }

        JsonNode root = objectMapper.readTree(response.body());
        JsonNode result = root.path("chart").path("result");
        if (!result.isArray() || result.isEmpty()) {
            JsonNode error = root.path("chart").path("error");
            throw new IOException("Yahoo Finance has no data for '" + ticker + "'"
                    + (error.isMissingNode() ? "" : ": " + error.path("description").asText(error.toString())));
        }

        JsonNode timestamps = result.get(0).path("timestamp");
        JsonNode closes = result.get(0).path("indicators").path("quote").get(0).path("close");

        TreeMap<LocalDate, BigDecimal> closesByDate = new TreeMap<>();
        for (int i = 0; i < timestamps.size(); i++) {
            JsonNode closeNode = closes.get(i);
            if (closeNode == null || closeNode.isNull()) continue; // non-trading day / halt
            LocalDate date = Instant.ofEpochSecond(timestamps.get(i).asLong()).atZone(ZoneOffset.UTC).toLocalDate();
            closesByDate.put(date, BigDecimal.valueOf(closeNode.asDouble()));
        }
        return closesByDate;
    }

    private record CacheEntry(NavigableMap<LocalDate, BigDecimal> closes, Instant fetchedAt) {}
}
