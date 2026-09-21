package com.martin.fullreval.dto;

public class VixTimingRequest {
    public int yearFrom;
    public int yearTo;
    /** Annual rate the idle cash leg earns while out of the market, e.g. 0.03 = 3%. */
    public double cashAnnualRate = 0.03;
    /** "USD" or "EUR" — the account's home currency. EUR adds daily EUR/USD FX exposure
     * while invested in the (USD-denominated) S&P 500, and leaves the cash leg unexposed. */
    public String currency = "USD";
}
