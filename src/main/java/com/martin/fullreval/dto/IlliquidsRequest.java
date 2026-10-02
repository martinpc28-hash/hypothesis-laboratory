package com.martin.fullreval.dto;

import java.util.List;

public class IlliquidsRequest {
    public int yearFrom;
    public int yearTo;
    /** The sleeves to hold and how much of the portfolio each one gets. Weights are relative (they
     * are normalised to 100%), so 1/1/1/1 and 25/25/25/25 mean the same thing. */
    public List<Sleeve> sleeves;

    public static class Sleeve {
        public String key;
        public double weight;
    }
}
