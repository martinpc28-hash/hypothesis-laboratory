package com.martin.fullreval.dto;

public class SmallCapsRequest {
    public int yearFrom = 2000;
    public int yearTo;
    /** What to hold when the signal says "small caps": RUSSELL_2000 (IWM), INTL_SMALL (DFISX) or GLOBAL_SMALL (50/50). */
    public String asset = "RUSSELL_2000";

    // --- the three signals, taken from the CFA Institute / Northern Trust paper ---
    /** Cycle signal is ON when the trailing 10-year annualised return of the Russell 2000 minus the S&P 500 is at
     * or BELOW this many percentage points per year (small caps have lagged for long, "all cycles end"). */
    public double spreadMax = -2.0;
    /** Relative-value signal is ON when the z-score of ln(Russell 2000 / S&P 500) against its own trailing
     * 10-year history is at or below this (small caps cheap relative to large caps). */
    public double zMax = -0.5;
    /** Rate-regime signal is ON when the fed funds rate is at or ABOVE this (the paper: rates above ~3% favour small caps). */
    public double rateMin = 3.0;
    /** Enter small caps when at least this many of the 3 signals are ON... */
    public int enterAt = 2;
    /** ...and leave when this many or fewer are ON (a lower number than enterAt gives a "sticky" band). */
    public int exitAt = 1;
    /** A change of signal only counts after it has held for this many consecutive trading days (avoids day-to-day flicker). */
    public int confirmDays = 21;

    // --- defensive side: AAA bonds ---
    /** Only buy the bond when the Moody's Aaa yield is at or above this (percent). Otherwise sit in T-bills. */
    public double minBondYield = 4.0;
    public double bondMaturityYears = 10;
    /** true: never sell the bond before it matures. */
    public boolean holdToMaturity = false;
    /** Only when holdToMaturity is false: sell the bond as soon as the small-cap signal comes back on. */
    public boolean sellOnSignal = false;
    /** Only when holdToMaturity is false: sell the bond when the Aaa yield has fallen this many points below the
     * yield it was bought at (the price has rallied). 0 disables it. */
    public double yieldDropPp = 1.5;

    // --- Monte Carlo / bootstrap controls ---
    public int n = 300;
    public long seed = 42;
    public int blockMonths = 12;
}
