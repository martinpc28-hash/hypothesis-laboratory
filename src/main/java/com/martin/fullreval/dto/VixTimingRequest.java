package com.martin.fullreval.dto;

public class VixTimingRequest {
    public int yearFrom;
    public int yearTo;
    /** "USD" or "EUR" — the account's home currency. Determines both which real money-market
     * rate the idle cash leg earns (a USD 3-month T-bill or a EUR interbank deposit — see
     * VixTimingService) and whether the S&P 500 leg carries daily EUR/USD FX exposure. */
    public String currency = "USD";
    /** Go 100% S&P 500 once the VIX closes at or above this. */
    public double enterVix = 30.0;
    /** Go back to cash once the VIX closes at or below this. */
    public double exitVix = 15.0;
    /** EUR mode only: invest the equity leg in a synthetic EUR-hedged S&P 500 (covered interest
     * rate parity) instead of the plain FX-exposed one. Ignored when currency is USD. */
    public boolean hedged = false;
}
