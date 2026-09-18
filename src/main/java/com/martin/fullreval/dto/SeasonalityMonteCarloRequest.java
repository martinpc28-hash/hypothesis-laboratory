package com.martin.fullreval.dto;

import java.util.List;

/** Combinatorial optimizer: instead of one fixed signal window, tries EVERY valid
 * (start month, length) window across the requested universes (sectors and/or countries,
 * evaluated separately — never mixed into one basket) and ranks them by risk-adjusted
 * return, to answer "which window + universe would have worked best over this period".
 *
 * Three modes for how the basket within each (universe, window) cell is chosen:
 *   - "ROTATING" (default): re-picks the signal-window top quartile of the WHOLE universe
 *     every year, same as the main strategy backtest above in the module.
 *   - "FIXED": commits to ONE set of fixedSize tickers for the WHOLE period, held together —
 *     searches every possible fixedSize-ticker subset of the universe and keeps the best.
 *   - "ROTATING_SUBSET": like ROTATING, but restricted to a chosen fixedSize-ticker subset
 *     instead of the whole universe — searches every possible subset and, for each, picks the
 *     top quartile WITHIN just that subset every year (e.g. fixedSize=2 reproduces "always
 *     hold whichever of these two tickers led the signal window", generalized to search every
 *     possible pair/trio/etc. instead of the user picking one by hand). */
public class SeasonalityMonteCarloRequest {
    public List<String> universes = List.of("SECTOR", "COUNTRY"); // "SECTOR" and/or "COUNTRY"
    public String dataSource = "YAHOO_FINANCE";
    public String currencyMode = "USD"; // only applies to the COUNTRY universe
    public int yearFrom;
    public int yearTo;
    public int minAssetsPerYear = 2; // only used in ROTATING mode
    public List<Integer> lengthMonths = List.of(1, 2, 3); // which window lengths to try
    public List<Integer> startMonths; // null/empty = all 12; e.g. [1] to force every window to start in January
    public String mode = "ROTATING"; // "ROTATING" | "FIXED" | "ROTATING_SUBSET"
    public Integer fixedSize; // required (>=2) when mode == "FIXED" or "ROTATING_SUBSET"
    // Combos built on very few years (e.g. a pair involving a ticker that's only traded since
    // 2019) can show a deceptively high score just from a short, lucky sample — this discards
    // any combo using fewer years than this before ranking. Null defaults to half the requested
    // year range (min 2), so the ranking favors combos with a genuinely long track record.
    public Integer minYearsUsed;
    // What "best" means, both for which single candidate wins each (universe, window) cell in
    // FIXED/ROTATING_SUBSET mode, and for the final ordering of all cells: "SCORE" (default,
    // CAGR ÷ volatility — favors smoother return), "CAGR", or "TOTAL_RETURN" (both favor raw
    // return regardless of volatility). A different candidate can legitimately win the SAME
    // window under a different criterion — this isn't just a display sort order.
    public String rankBy = "SCORE"; // "SCORE" | "CAGR" | "TOTAL_RETURN"
}
