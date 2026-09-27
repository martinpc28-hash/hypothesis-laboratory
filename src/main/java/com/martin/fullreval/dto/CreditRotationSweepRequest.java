package com.martin.fullreval.dto;

public class CreditRotationSweepRequest {
    public int yearFrom;
    public int yearTo;
    /** RISK_ADJUSTED (CAGR / volatility), CAGR, or TOTAL_RETURN — same three options already
     * offered by Seasonality's "Rank combinations by" Monte Carlo sweep, reused here. */
    public String rankBy = "RISK_ADJUSTED";
    /** Which currency's numbers the ranking itself is computed on — "USD" or "EUR". Every result
     * row still reports BOTH USD and EUR figures regardless (see CreditRotationRequest); this
     * only decides which one determines the sort order, since a EUR investor's volatility/
     * drawdown (and therefore which threshold looks best) isn't identical to a USD investor's. */
    public String rankCurrency = "USD";
}
