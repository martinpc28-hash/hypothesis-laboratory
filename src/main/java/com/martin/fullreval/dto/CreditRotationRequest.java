package com.martin.fullreval.dto;

public class CreditRotationRequest {
    public int yearFrom;
    public int yearTo;
    /** Which macro reading drives the switch — one of CreditRotationService.FEATURES' keys
     * (CREDIT_SPREAD, VIX, YIELD_CURVE, RATE_LEVEL, RATE_CHANGE, INFLATION, GROWTH). */
    public String feature = "VIX";
    /** Go 100% high yield (HYG) once the feature reading closes at or above this. Same
     * "enter on a HIGH reading" convention as VixTimingRequest.enterVix, kept identical across
     * every candidate feature so the sweep isn't biased by a hand-picked direction per feature. */
    public double enterThreshold;
    /** Go back to investment grade (LQD) once the feature reading closes at or below this. */
    public double exitThreshold;
}
