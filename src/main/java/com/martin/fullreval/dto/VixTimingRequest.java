package com.martin.fullreval.dto;

public class VixTimingRequest {
    public int yearFrom;
    public int yearTo;
    /** Annual rate the idle cash leg earns while out of the market, e.g. 0.03 = 3%. */
    public double cashAnnualRate = 0.03;
    /** "USD" or "EUR" — the account's home currency. EUR adds daily EUR/USD FX exposure
     * while invested in the (USD-denominated) S&P 500, and leaves the cash leg unexposed. */
    public String currency = "USD";
    /** Go 100% S&P 500 once the VIX closes at or above this. */
    public double enterVix = 30.0;
    /** Go back to cash once the VIX closes at or below this. */
    public double exitVix = 15.0;
}
