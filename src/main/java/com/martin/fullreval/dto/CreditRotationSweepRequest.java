package com.martin.fullreval.dto;

public class CreditRotationSweepRequest {
    public int yearFrom;
    public int yearTo;
    /** RISK_ADJUSTED (CAGR / volatility), CAGR, or TOTAL_RETURN — same three options already
     * offered by Seasonality's "Rank combinations by" Monte Carlo sweep, reused here. */
    public String rankBy = "RISK_ADJUSTED";
}
