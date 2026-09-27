package com.martin.fullreval.dto;

public class CreditRotationSweepRequest {
    public int yearFrom;
    public int yearTo;
    /** "USD" or "EUR" — see CreditRotationRequest.currency. The sweep re-simulates every
     * candidate under this same currency view, since a EUR investor's volatility/drawdown (and
     * therefore which threshold looks best) isn't identical to a USD investor's. */
    public String currency = "USD";
    /** RISK_ADJUSTED (CAGR / volatility), CAGR, or TOTAL_RETURN — same three options already
     * offered by Seasonality's "Rank combinations by" Monte Carlo sweep, reused here. */
    public String rankBy = "RISK_ADJUSTED";
}
