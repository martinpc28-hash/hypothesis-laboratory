package com.martin.fullreval.service;

import com.martin.fullreval.dto.SmallCapsRequest;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.time.DayOfWeek;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NavigableMap;
import java.util.SplittableRandom;

/**
 * Small-cap cycle strategy built from the CFA Institute / Northern Trust paper "Small Caps vs. Large Caps: The
 * Cycle That's About to Turn". The paper's argument has three legs, and each becomes a signal:
 *   1. All cycles end  -> trailing 10-year Russell 2000 minus S&P 500 return spread (small caps lagged for long).
 *      Plus a relative-value version: z-score of ln(R2000/S&P 500) against its own 10-year history.
 *   2. Rates are favourable -> fed funds rate above a floor (the paper: above ~3%).
 * (The paper's other two arguments — price-to-book and return-on-assets — need fundamentals that no free
 * long-history source provides, so they are NOT modelled; the z-score is the closest free stand-in for "cheap".)
 *
 * The strategy holds a small-cap asset while enough signals are on. When they go off it buys an AAA bond (Moody's
 * Aaa yield from FRED) if the yield is high enough, or sits in T-bills otherwise. The bond is held to maturity or
 * sold early when its yield has fallen far below what it was bought at (the price has rallied), or when the
 * small-cap signal returns — all configurable. The bond is marked to market daily, so a bond held to maturity
 * still ends up delivering its purchase yield, but the path in between is real.
 *
 * Every decision uses data up to the day's close and takes effect the next day.
 */
@Service
public class SmallCapsService {

    private static final int EQUITY = 0, BOND = 1, CASH = 2;
    private static final String[] STATE_NAMES = {"EQUITY", "BOND", "CASH"};
    private static final double TRADING_DAYS = 252.0;
    private static final double MIN_EQUITY_SHARE = 0.15;

    private final YahooFinanceService yahoo;
    private final FredClient fred;

    public SmallCapsService(YahooFinanceService yahoo, FredClient fred) {
        this.yahoo = yahoo;
        this.fred = fred;
    }

    // ------------------------------------------------------------------ parameters & market data

    private static final class Params {
        double spreadMax, zMax, rateMin, minBondYield, bondMaturity, yieldDropPp;
        int enterAt, exitAt, confirmDays;
        boolean holdToMaturity, sellOnSignal;

        static Params from(SmallCapsRequest r) {
            Params p = new Params();
            p.spreadMax = r.spreadMax;
            p.zMax = r.zMax;
            p.rateMin = r.rateMin;
            p.enterAt = r.enterAt;
            p.exitAt = r.exitAt;
            p.confirmDays = Math.max(1, r.confirmDays);
            p.minBondYield = r.minBondYield;
            p.bondMaturity = r.bondMaturityYears;
            p.holdToMaturity = r.holdToMaturity;
            p.sellOnSignal = r.sellOnSignal;
            p.yieldDropPp = r.yieldDropPp;
            return p;
        }
    }

    private static final class Market {
        LocalDate[] days;
        int n;
        double[] assetRet, cashRet, spyRet, dt;
        double[] spread, z, rate, aaa; // signal inputs as of each day's close (NaN = not available yet)
        String assetLabel;
        String assetTickers;
        String firstAvailable;
    }

    private Market loadMarket(SmallCapsRequest req) {
        if (req.yearFrom > req.yearTo) throw new IllegalArgumentException("yearFrom must not be after yearTo");
        String asset = req.asset == null ? "RUSSELL_2000" : req.asset;
        boolean needIwm = !asset.equals("INTL_SMALL");
        boolean needIntl = !asset.equals("RUSSELL_2000");
        if (!asset.equals("RUSSELL_2000") && !asset.equals("INTL_SMALL") && !asset.equals("GLOBAL_SMALL")) {
            throw new IllegalArgumentException("Unknown asset: " + asset);
        }

        NavigableMap<LocalDate, BigDecimal> spy = yahoo.fetchAdjustedDailyCloses("SPY");
        NavigableMap<LocalDate, BigDecimal> iwm = needIwm ? yahoo.fetchAdjustedDailyCloses("IWM") : null;
        NavigableMap<LocalDate, BigDecimal> intl = needIntl ? yahoo.fetchAdjustedDailyCloses("DFISX") : null;
        NavigableMap<LocalDate, BigDecimal> rut = yahoo.fetchDailyCloses("^RUT");
        NavigableMap<LocalDate, BigDecimal> spx = yahoo.fetchDailyCloses("^GSPC");
        NavigableMap<LocalDate, BigDecimal> dff = toDoubleMapSource("DFF");
        NavigableMap<LocalDate, BigDecimal> dtb3 = toDoubleMapSource("DTB3");
        NavigableMap<LocalDate, BigDecimal> daaa = toDoubleMapSource("DAAA");
        if (spy.isEmpty() || rut.isEmpty() || spx.isEmpty()) throw new IllegalStateException("Sin datos de Yahoo Finance (SPY / ^RUT / ^GSPC)");
        if (needIwm && iwm.isEmpty()) throw new IllegalStateException("Sin datos de IWM");
        if (needIntl && intl.isEmpty()) throw new IllegalStateException("Sin datos de DFISX");
        if (dff.isEmpty() || dtb3.isEmpty() || daaa.isEmpty()) throw new IllegalStateException("Sin datos de FRED (DFF / DTB3 / DAAA)");

        LocalDate latestStart = spy.firstKey();
        if (needIwm && iwm.firstKey().isAfter(latestStart)) latestStart = iwm.firstKey();
        if (needIntl && intl.firstKey().isAfter(latestStart)) latestStart = intl.firstKey();

        LocalDate start = LocalDate.of(req.yearFrom, 1, 1);
        if (latestStart.isAfter(start)) {
            start = (latestStart.getMonthValue() > 1 || latestStart.getDayOfMonth() > 10)
                    ? LocalDate.of(latestStart.getYear() + 1, 1, 1) : latestStart;
        }
        LocalDate today = LocalDate.now();
        LocalDate end = req.yearTo >= today.getYear() ? today : LocalDate.of(req.yearTo, 12, 31);
        if (start.isAfter(end)) throw new IllegalArgumentException("Con esos datos el rango arranca en " + latestStart + ": elegí un rango que termine después");

        List<LocalDate> list = new ArrayList<>(spy.subMap(start, true, end, true).keySet());
        if (list.size() < 260) throw new IllegalStateException("Muy pocos días de datos (" + list.size() + ") para una estrategia de ciclo");

        Market m = new Market();
        m.n = list.size();
        m.days = list.toArray(new LocalDate[0]);
        m.assetRet = new double[m.n];
        m.cashRet = new double[m.n];
        m.spyRet = new double[m.n];
        m.dt = new double[m.n];
        m.spread = new double[m.n];
        m.z = new double[m.n];
        m.rate = new double[m.n];
        m.aaa = new double[m.n];

        // log(R2000 / S&P 500) on dates both indices have, with prefix sums for the rolling z-score
        List<LocalDate> rd = new ArrayList<>();
        List<Double> lv = new ArrayList<>();
        for (Map.Entry<LocalDate, BigDecimal> e : rut.entrySet()) {
            BigDecimal s = spx.get(e.getKey());
            if (s != null && s.signum() > 0 && e.getValue().signum() > 0) {
                rd.add(e.getKey());
                lv.add(Math.log(e.getValue().doubleValue() / s.doubleValue()));
            }
        }
        LocalDate[] rDates = rd.toArray(new LocalDate[0]);
        double[] pre = new double[rDates.length + 1], pre2 = new double[rDates.length + 1];
        for (int i = 0; i < rDates.length; i++) {
            double v = lv.get(i);
            pre[i + 1] = pre[i] + v;
            pre2[i + 1] = pre2[i] + v * v;
        }

        for (int i = 0; i < m.n; i++) {
            LocalDate day = m.days[i];
            LocalDate prev = i == 0 ? day : m.days[i - 1];
            m.dt[i] = i == 0 ? 0 : ChronoUnit.DAYS.between(prev, day) / 365.25;
            if (i > 0) {
                m.spyRet[i] = ret(spy, prev, day);
                double iw = needIwm ? ret(iwm, prev, day) : 0, it = needIntl ? ret(intl, prev, day) : 0;
                m.assetRet[i] = asset.equals("RUSSELL_2000") ? iw : asset.equals("INTL_SMALL") ? it : 0.5 * iw + 0.5 * it;
                Double r = floor(dtb3, prev);
                m.cashRet[i] = Math.pow(1.0 + (r == null ? 0 : r) / 100.0, ChronoUnit.DAYS.between(prev, day) / 365.0) - 1.0;
            }
            Double fr = floor(dff, day), ay = floor(daaa, day);
            m.rate[i] = fr == null ? Double.NaN : fr;
            m.aaa[i] = ay == null ? Double.NaN : ay;

            // trailing 10-year return spread (annualised, in percentage points)
            LocalDate old = day.minusYears(10);
            m.spread[i] = Double.NaN;
            m.z[i] = Double.NaN;
            if (!rut.firstKey().isAfter(old) && !spx.firstKey().isAfter(old)) {
                double rNow = rut.floorEntry(day).getValue().doubleValue(), rOld = rut.floorEntry(old).getValue().doubleValue();
                double sNow = spx.floorEntry(day).getValue().doubleValue(), sOld = spx.floorEntry(old).getValue().doubleValue();
                m.spread[i] = (Math.pow(rNow / rOld, 0.1) - Math.pow(sNow / sOld, 0.1)) * 100.0;
                int j = lastIndexAtOrBefore(rDates, day);
                int k = firstIndexAfter(rDates, old);
                int cnt = j - k + 1;
                if (cnt >= 1000) {
                    double mean = (pre[j + 1] - pre[k]) / cnt;
                    double var = (pre2[j + 1] - pre2[k]) / cnt - mean * mean;
                    double sd = Math.sqrt(Math.max(var, 1e-12));
                    m.z[i] = (lv.get(j) - mean) / sd;
                }
            }
        }
        m.assetLabel = switch (asset) {
            case "RUSSELL_2000" -> "Russell 2000 (IWM)";
            case "INTL_SMALL" -> "Small caps internacionales (DFISX)";
            default -> "Small caps globales: 50% Russell 2000 + 50% internacionales";
        };
        m.assetTickers = switch (asset) {
            case "RUSSELL_2000" -> "IWM";
            case "INTL_SMALL" -> "DFISX";
            default -> "IWM + DFISX";
        };
        m.firstAvailable = latestStart.toString();
        return m;
    }

    private NavigableMap<LocalDate, BigDecimal> toDoubleMapSource(String seriesId) {
        java.util.TreeMap<LocalDate, BigDecimal> t = new java.util.TreeMap<>();
        t.putAll(fred.fetchSeries(seriesId));
        return t;
    }

    private static Double floor(NavigableMap<LocalDate, BigDecimal> s, LocalDate d) {
        Map.Entry<LocalDate, BigDecimal> e = s.floorEntry(d);
        return e == null ? null : e.getValue().doubleValue();
    }

    private static double ret(NavigableMap<LocalDate, BigDecimal> s, LocalDate a, LocalDate b) {
        Map.Entry<LocalDate, BigDecimal> e0 = s.floorEntry(a), e1 = s.floorEntry(b);
        if (e0 == null || e1 == null || e0.getValue().signum() == 0) return 0.0;
        return e1.getValue().doubleValue() / e0.getValue().doubleValue() - 1.0;
    }

    private static int lastIndexAtOrBefore(LocalDate[] a, LocalDate d) {
        int lo = 0, hi = a.length - 1, res = -1;
        while (lo <= hi) {
            int mid = (lo + hi) >>> 1;
            if (!a[mid].isAfter(d)) { res = mid; lo = mid + 1; } else hi = mid - 1;
        }
        return res;
    }

    private static int firstIndexAfter(LocalDate[] a, LocalDate d) {
        int lo = 0, hi = a.length - 1, res = a.length;
        while (lo <= hi) {
            int mid = (lo + hi) >>> 1;
            if (a[mid].isAfter(d)) { res = mid; hi = mid - 1; } else lo = mid + 1;
        }
        return res;
    }

    // ------------------------------------------------------------------ the simulation

    private static final class Sim {
        double[] ret;
        double[] wealth;
        int[] stateDays = new int[3];
        int bondsBought;
        List<Map<String, Object>> segments = new ArrayList<>();
        int finalState;
        boolean finalSignalOn;
    }

    private static double bondPrice(double c, double m, double y) {
        if (m <= 0) return 1.0;
        if (Math.abs(y) < 1e-9) return 1.0 + c * m;
        double disc = Math.pow(1.0 + y, -m);
        return c * (1.0 - disc) / y + disc;
    }

    private static int score(Market m, Params p, int i) {
        int s = 0;
        if (!Double.isNaN(m.spread[i]) && m.spread[i] <= p.spreadMax) s++;
        if (!Double.isNaN(m.z[i]) && m.z[i] <= p.zMax) s++;
        if (!Double.isNaN(m.rate[i]) && m.rate[i] >= p.rateMin) s++;
        return s;
    }

    private Sim simulate(Market m, Params p, boolean detail) {
        Sim out = new Sim();
        out.ret = new double[m.n];
        out.wealth = new double[m.n];
        out.wealth[0] = 1.0;

        boolean sigOn = score(m, p, 0) >= p.enterAt;
        int state;
        double bondC = 0, bondM = 0, bondP = 1, bondY0 = 0;
        LocalDate bondMaturityDate = null;
        int segStart = 0;
        double segWealth = 1.0;
        String segNote = "";

        // initial position
        if (sigOn) state = EQUITY;
        else if (!Double.isNaN(m.aaa[0]) && m.aaa[0] >= p.minBondYield) {
            state = BOND; bondY0 = m.aaa[0] / 100.0; bondC = bondY0; bondM = p.bondMaturity; bondP = 1.0; out.bondsBought++;
            bondMaturityDate = m.days[0].plusDays((long) (p.bondMaturity * 365.25));
            segNote = "yield " + String.format(java.util.Locale.US, "%.2f", m.aaa[0]) + "%";
        } else state = CASH;

        double wealth = 1.0;
        int streak = 0;
        for (int i = 1; i < m.n; i++) {
            double r;
            boolean matured = false;
            if (state == EQUITY) r = m.assetRet[i];
            else if (state == CASH) r = m.cashRet[i];
            else {
                double mNow = bondM - m.dt[i];
                if (mNow <= 0) {
                    r = Math.pow(1.0 + bondC, bondM) / bondP - 1.0;
                    matured = true;
                    bondM = 0;
                } else {
                    double y = Double.isNaN(m.aaa[i]) ? bondY0 : m.aaa[i] / 100.0;
                    double pNow = bondPrice(bondC, mNow, y);
                    r = pNow / bondP * Math.pow(1.0 + bondC, m.dt[i]) - 1.0;
                    bondP = pNow;
                    bondM = mNow;
                }
            }
            wealth *= 1.0 + r;
            out.ret[i] = r;
            out.wealth[i] = wealth;
            out.stateDays[state]++;

            int sc = score(m, p, i);
            boolean wantsFlip = sigOn ? sc <= p.exitAt : sc >= p.enterAt;
            streak = wantsFlip ? streak + 1 : 0;
            if (streak >= p.confirmDays) { sigOn = !sigOn; streak = 0; }

            int next = state;
            String reason = "";
            double aaaNow = m.aaa[i];
            boolean bondOk = !Double.isNaN(aaaNow) && aaaNow >= p.minBondYield;
            if (state == EQUITY) {
                if (!sigOn) { next = bondOk ? BOND : CASH; reason = "señal de small caps apagada"; }
            } else if (state == CASH) {
                if (sigOn) { next = EQUITY; reason = "señal de small caps encendida"; }
                else if (bondOk) { next = BOND; reason = "el yield Aaa llegó al mínimo"; }
            } else {
                boolean sell = false;
                if (matured) { sell = true; reason = "vencimiento"; }
                else if (!p.holdToMaturity) {
                    if (p.sellOnSignal && sigOn) { sell = true; reason = "señal de small caps encendida"; }
                    else if (p.yieldDropPp > 0 && !Double.isNaN(aaaNow) && aaaNow / 100.0 <= bondY0 - p.yieldDropPp / 100.0) {
                        sell = true; reason = "el yield cayó " + String.format(java.util.Locale.US, "%.1f", p.yieldDropPp) + " pts: se vende con ganancia de precio";
                    }
                }
                if (sell) next = sigOn ? EQUITY : (bondOk ? BOND : CASH);
            }

            if (next != state || (state == BOND && matured)) {
                if (detail) {
                    Map<String, Object> seg = new LinkedHashMap<>();
                    seg.put("type", STATE_NAMES[state]);
                    seg.put("entryDate", m.days[segStart].toString());
                    seg.put("exitDate", m.days[i].toString());
                    seg.put("return", wealth / segWealth - 1.0);
                    seg.put("note", segNote);
                    seg.put("exitReason", reason);
                    if (state == BOND) {
                        seg.put("bondYield", bondY0 * 100.0);
                        seg.put("maturityDate", bondMaturityDate == null ? null : bondMaturityDate.toString());
                    }
                    out.segments.add(seg);
                }
                segStart = i;
                segWealth = wealth;
                if (next == BOND) {
                    bondY0 = aaaNow / 100.0; bondC = bondY0; bondM = p.bondMaturity; bondP = 1.0; out.bondsBought++;
                    bondMaturityDate = m.days[i].plusDays((long) (p.bondMaturity * 365.25));
                    segNote = "yield " + String.format(java.util.Locale.US, "%.2f", aaaNow) + "%";
                } else segNote = "";
                state = next;
            }
        }
        if (detail) {
            Map<String, Object> seg = new LinkedHashMap<>();
            seg.put("type", STATE_NAMES[state]);
            seg.put("entryDate", m.days[segStart].toString());
            seg.put("exitDate", null);
            seg.put("return", wealth / segWealth - 1.0);
            seg.put("note", segNote);
            seg.put("exitReason", "abierta");
            if (state == BOND) {
                seg.put("bondYield", bondY0 * 100.0);
                seg.put("maturityDate", bondMaturityDate == null ? null : bondMaturityDate.toString());
            }
            out.segments.add(seg);
        }
        out.finalState = state;
        out.finalSignalOn = sigOn;
        return out;
    }

    // ------------------------------------------------------------------ statistics helpers

    private static Map<String, Object> stats(double[] ret, double years) {
        double wealth = 1, peak = 1, maxDd = 0, sum = 0, sum2 = 0;
        int n = ret.length - 1;
        for (int i = 1; i < ret.length; i++) {
            wealth *= 1.0 + ret[i];
            peak = Math.max(peak, wealth);
            maxDd = Math.min(maxDd, wealth / peak - 1.0);
            sum += ret[i];
            sum2 += ret[i] * ret[i];
        }
        double mean = sum / n;
        double var = n > 1 ? (sum2 - n * mean * mean) / (n - 1) : 0;
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("totalReturn", wealth - 1.0);
        m.put("cagr", years <= 0 ? 0.0 : Math.pow(wealth, 1.0 / years) - 1.0);
        m.put("volatility", Math.sqrt(Math.max(var, 0)) * Math.sqrt(TRADING_DAYS));
        m.put("maxDrawdown", maxDd);
        return m;
    }

    private static double d(Map<String, Object> m, String k) {
        return ((Number) m.get(k)).doubleValue();
    }

    private static double[] wealthOf(double[] ret) {
        double[] w = new double[ret.length];
        w[0] = 1;
        for (int i = 1; i < ret.length; i++) w[i] = w[i - 1] * (1.0 + ret[i]);
        return w;
    }

    private static double percentile(double[] sorted, double q) {
        if (sorted.length == 0) return Double.NaN;
        double pos = q * (sorted.length - 1);
        int lo = (int) Math.floor(pos), hi = (int) Math.ceil(pos);
        return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
    }

    private static Map<String, Object> distribution(double[] values) {
        double[] s = values.clone();
        Arrays.sort(s);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("p5", percentile(s, 0.05));
        m.put("p25", percentile(s, 0.25));
        m.put("p50", percentile(s, 0.50));
        m.put("p75", percentile(s, 0.75));
        m.put("p95", percentile(s, 0.95));
        m.put("mean", Arrays.stream(values).average().orElse(Double.NaN));
        return m;
    }

    private static List<Map<String, Object>> histogram(double[] values, int bins) {
        double lo = Arrays.stream(values).min().orElse(0), hi = Arrays.stream(values).max().orElse(1);
        if (hi - lo < 1e-12) hi = lo + 1e-6;
        int[] counts = new int[bins];
        for (double v : values) counts[Math.min(bins - 1, (int) ((v - lo) / (hi - lo) * bins))]++;
        List<Map<String, Object>> out = new ArrayList<>();
        for (int b = 0; b < bins; b++) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("from", lo + (hi - lo) * b / bins);
            m.put("to", lo + (hi - lo) * (b + 1) / bins);
            m.put("count", counts[b]);
            out.add(m);
        }
        return out;
    }

    // ------------------------------------------------------------------ public API

    public Map<String, Object> backtest(SmallCapsRequest req) {
        Market m = loadMarket(req);
        Params p = Params.from(req);
        validate(p);
        Sim s = simulate(m, p, true);
        double years = ChronoUnit.DAYS.between(m.days[0], m.days[m.n - 1]) / 365.25;
        double[] assetW = wealthOf(m.assetRet), spyW = wealthOf(m.spyRet);

        List<Map<String, Object>> cumulative = new ArrayList<>();
        List<Map<String, Object>> weekly = new ArrayList<>();
        Map<Integer, Map<String, Object>> byYear = new LinkedHashMap<>();
        for (int i = 1; i < m.n; i++) {
            Map<String, Object> yp = byYear.computeIfAbsent(m.days[i].getYear(), y -> new LinkedHashMap<>(Map.of("year", y)));
            yp.put("cumulativeStrategy", s.wealth[i] - 1.0);
            yp.put("cumulativeAsset", assetW[i] - 1.0);
            yp.put("cumulativeSp500", spyW[i] - 1.0);
            if (m.days[i].getDayOfWeek() == DayOfWeek.FRIDAY || i == m.n - 1) {
                Map<String, Object> w = new LinkedHashMap<>();
                w.put("date", m.days[i].toString());
                w.put("cumulativeStrategy", s.wealth[i] - 1.0);
                w.put("cumulativeAsset", assetW[i] - 1.0);
                w.put("cumulativeSp500", spyW[i] - 1.0);
                weekly.add(w);
            }
        }
        cumulative.addAll(byYear.values());

        int last = m.n - 1;
        Map<String, Object> read = new LinkedHashMap<>();
        read.put("date", m.days[last].toString());
        read.put("spread10y", nan(m.spread[last]));
        read.put("zScore", nan(m.z[last]));
        read.put("fedFunds", nan(m.rate[last]));
        read.put("aaaYield", nan(m.aaa[last]));
        read.put("spreadOn", !Double.isNaN(m.spread[last]) && m.spread[last] <= p.spreadMax);
        read.put("zOn", !Double.isNaN(m.z[last]) && m.z[last] <= p.zMax);
        read.put("rateOn", !Double.isNaN(m.rate[last]) && m.rate[last] >= p.rateMin);
        read.put("score", score(m, p, last));
        read.put("signalOn", s.finalSignalOn);
        read.put("position", STATE_NAMES[s.finalState]);

        int total = s.stateDays[0] + s.stateDays[1] + s.stateDays[2];
        Map<String, Object> time = new LinkedHashMap<>();
        time.put("equity", s.stateDays[0] / (double) total);
        time.put("bond", s.stateDays[1] / (double) total);
        time.put("cash", s.stateDays[2] / (double) total);

        Map<String, Object> meta = new LinkedHashMap<>();
        meta.put("currency", "USD");
        meta.put("yearFrom", req.yearFrom);
        meta.put("yearTo", req.yearTo);
        meta.put("effectiveYearFrom", m.days[0].getYear());
        meta.put("firstDay", m.days[0].toString());
        meta.put("lastDay", m.days[last].toString());
        meta.put("tradingDays", m.n);
        meta.put("assetLabel", m.assetLabel);
        meta.put("assetTickers", m.assetTickers);
        meta.put("bondsBought", s.bondsBought);

        Map<String, Object> st = new LinkedHashMap<>();
        st.put("strategy", stats(s.ret, years));
        st.put("asset", stats(m.assetRet, years));
        st.put("sp500", stats(m.spyRet, years));

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("meta", meta);
        result.put("cumulative", cumulative);
        result.put("weekly", weekly);
        result.put("stats", st);
        result.put("timeInState", time);
        result.put("segments", s.segments);
        result.put("currentRead", read);
        return result;
    }

    private static Object nan(double v) {
        return Double.isNaN(v) ? null : v;
    }

    private static void validate(Params p) {
        if (p.enterAt < 1 || p.enterAt > 3) throw new IllegalArgumentException("enterAt debe estar entre 1 y 3");
        if (p.exitAt < 0 || p.exitAt >= p.enterAt) throw new IllegalArgumentException("exitAt debe ser menor que enterAt");
        if (p.bondMaturity < 1 || p.bondMaturity > 30) throw new IllegalArgumentException("El vencimiento del bono debe estar entre 1 y 30 años");
    }

    // ------------------------------------------------------------------ bootstrap

    /** Monthly returns (last trading day of each month) from a daily return array. */
    private static double[] monthly(Market m, double[] dailyRet) {
        List<Double> out = new ArrayList<>();
        double w = 1, monthStart = 1;
        for (int i = 1; i < m.n; i++) {
            w *= 1.0 + dailyRet[i];
            boolean monthEnd = i == m.n - 1 || m.days[i + 1].getMonthValue() != m.days[i].getMonthValue();
            if (monthEnd) { out.add(w / monthStart - 1.0); monthStart = w; }
        }
        return out.stream().mapToDouble(Double::doubleValue).toArray();
    }

    private static double[] pathStats(double[] monthlyRet, int[] idx) {
        double w = 1, peak = 1, dd = 0, sum = 0, sum2 = 0;
        for (int k : idx) {
            double r = monthlyRet[k];
            w *= 1.0 + r;
            peak = Math.max(peak, w);
            dd = Math.min(dd, w / peak - 1.0);
            sum += r;
            sum2 += r * r;
        }
        int n = idx.length;
        double mean = sum / n, var = (sum2 - n * mean * mean) / Math.max(1, n - 1);
        double cagr = Math.pow(w, 12.0 / n) - 1.0;
        return new double[]{cagr, Math.sqrt(Math.max(var, 0)) * Math.sqrt(12), dd, w};
    }

    public Map<String, Object> bootstrap(SmallCapsRequest req) {
        Market m = loadMarket(req);
        Params p = Params.from(req);
        validate(p);
        Sim s = simulate(m, p, false);
        double[] ms = monthly(m, s.ret), ma = monthly(m, m.assetRet);
        int months = ms.length, block = Math.max(1, Math.min(req.blockMonths, months / 2));
        int paths = Math.max(200, Math.min(req.n <= 0 ? 2000 : req.n, 20000));
        SplittableRandom rnd = new SplittableRandom(req.seed);

        double[] cagrS = new double[paths], cagrA = new double[paths], ddS = new double[paths], ddA = new double[paths];
        double[] volS = new double[paths], volA = new double[paths], diff = new double[paths], sharpeS = new double[paths], sharpeA = new double[paths];
        int beatCagr = 0, beatDd = 0, beatBoth = 0, lossS = 0;
        for (int pth = 0; pth < paths; pth++) {
            int[] idx = new int[months];
            int k = 0;
            while (k < months) {
                int startIdx = rnd.nextInt(months);
                for (int b = 0; b < block && k < months; b++) idx[k++] = (startIdx + b) % months;
            }
            double[] a = pathStats(ms, idx), c = pathStats(ma, idx);
            cagrS[pth] = a[0]; volS[pth] = a[1]; ddS[pth] = a[2];
            cagrA[pth] = c[0]; volA[pth] = c[1]; ddA[pth] = c[2];
            diff[pth] = a[0] - c[0];
            sharpeS[pth] = a[1] > 0 ? a[0] / a[1] : 0;
            sharpeA[pth] = c[1] > 0 ? c[0] / c[1] : 0;
            boolean bc = a[0] > c[0], bd = a[2] > c[2];
            if (bc) beatCagr++;
            if (bd) beatDd++;
            if (bc && bd) beatBoth++;
            if (a[3] < 1.0) lossS++;
        }
        Map<String, Object> out = new LinkedHashMap<>();
        Map<String, Object> meta = new LinkedHashMap<>();
        meta.put("paths", paths);
        meta.put("months", months);
        meta.put("blockMonths", block);
        meta.put("seed", req.seed);
        meta.put("assetLabel", m.assetLabel);
        out.put("meta", meta);
        out.put("probBeatCagr", beatCagr / (double) paths);
        out.put("probBetterDrawdown", beatDd / (double) paths);
        out.put("probBeatBoth", beatBoth / (double) paths);
        out.put("probLoss", lossS / (double) paths);
        out.put("cagrStrategy", distribution(cagrS));
        out.put("cagrAsset", distribution(cagrA));
        out.put("cagrDifference", distribution(diff));
        out.put("drawdownStrategy", distribution(ddS));
        out.put("drawdownAsset", distribution(ddA));
        out.put("volatilityStrategy", distribution(volS));
        out.put("volatilityAsset", distribution(volA));
        out.put("sharpeStrategy", distribution(sharpeS));
        out.put("sharpeAsset", distribution(sharpeA));
        out.put("differenceHistogram", histogram(diff, 24));
        return out;
    }

    // ------------------------------------------------------------------ parameter Monte Carlo

    private static final String[] PARAM_NAMES = {"spreadMax", "zMax", "rateMin", "enterAt", "exitAt", "minBondYield", "bondMaturity", "yieldDropPp", "holdToMaturity", "sellOnSignal", "confirmDays"};

    public Map<String, Object> monteCarlo(SmallCapsRequest req) {
        Market m = loadMarket(req);
        Params base = Params.from(req);
        validate(base);
        double years = ChronoUnit.DAYS.between(m.days[0], m.days[m.n - 1]) / 365.25;
        int runs = Math.max(50, Math.min(req.n <= 0 ? 300 : req.n, 1000));
        SplittableRandom rnd = new SplittableRandom(req.seed);

        Map<String, Object> assetStats = stats(m.assetRet, years);
        double assetCagr = d(assetStats, "cagr"), assetDd = d(assetStats, "maxDrawdown"), assetVol = d(assetStats, "volatility");

        double[][] paramRows = new double[runs][];
        double[] cagr = new double[runs], vol = new double[runs], dd = new double[runs], sharpe = new double[runs], eqShare = new double[runs];
        int beatCagr = 0, betterDd = 0, beatBoth = 0;
        for (int r = 0; r < runs; r++) {
            Params p = new Params();
            p.spreadMax = -8 + rnd.nextDouble() * 10;           // -8 .. +2 pp/yr
            p.zMax = -1.5 + rnd.nextDouble() * 2.0;              // -1.5 .. +0.5
            p.rateMin = 0.5 + rnd.nextDouble() * 4.5;            // 0.5 .. 5
            p.enterAt = 1 + rnd.nextInt(3);                      // 1..3
            p.exitAt = rnd.nextInt(p.enterAt);                   // 0..enterAt-1
            p.minBondYield = 2.5 + rnd.nextDouble() * 4.0;       // 2.5 .. 6.5
            p.bondMaturity = new double[]{3, 5, 7, 10, 15}[rnd.nextInt(5)];
            p.yieldDropPp = new double[]{0, 1, 1.5, 2, 3}[rnd.nextInt(5)];
            p.holdToMaturity = rnd.nextInt(4) == 0;
            p.sellOnSignal = rnd.nextInt(3) == 0;
            p.confirmDays = new int[]{1, 5, 21, 63}[rnd.nextInt(4)];
            Sim s = simulate(m, p, false);
            Map<String, Object> st = stats(s.ret, years);
            cagr[r] = d(st, "cagr"); vol[r] = d(st, "volatility"); dd[r] = d(st, "maxDrawdown");
            sharpe[r] = vol[r] > 0 ? cagr[r] / vol[r] : 0;
            eqShare[r] = s.stateDays[EQUITY] / (double) (s.stateDays[0] + s.stateDays[1] + s.stateDays[2]);
            paramRows[r] = new double[]{p.spreadMax, p.zMax, p.rateMin, p.enterAt, p.exitAt, p.minBondYield, p.bondMaturity, p.yieldDropPp, p.holdToMaturity ? 1 : 0, p.sellOnSignal ? 1 : 0, p.confirmDays};
            boolean bc = cagr[r] > assetCagr, bd = dd[r] > assetDd;
            if (bc) beatCagr++;
            if (bd) betterDd++;
            if (bc && bd) beatBoth++;
        }

        // Where does the user's own configuration land among the random ones?
        Sim baseSim = simulate(m, base, false);
        Map<String, Object> baseStats = stats(baseSim.ret, years);
        double baseSharpe = d(baseStats, "volatility") > 0 ? d(baseStats, "cagr") / d(baseStats, "volatility") : 0;
        int below = 0;
        for (double v : sharpe) if (v <= baseSharpe) below++;

        // Which variables matter: Spearman correlation of each parameter with CAGR and with CAGR/vol
        List<Map<String, Object>> sensitivity = new ArrayList<>();
        for (int j = 0; j < PARAM_NAMES.length; j++) {
            double[] col = new double[runs];
            for (int r = 0; r < runs; r++) col[r] = paramRows[r][j];
            Map<String, Object> e = new LinkedHashMap<>();
            e.put("param", PARAM_NAMES[j]);
            e.put("corrCagr", spearman(col, cagr));
            e.put("corrSharpe", spearman(col, sharpe));
            e.put("corrDrawdown", spearman(col, dd));
            sensitivity.add(e);
        }

        // A config that almost never holds small caps is just a bond fund with a great-looking ratio, so the
        // ranking only considers configs that spend at least MIN_EQUITY_SHARE of the time in small caps.
        List<Integer> eligible = new ArrayList<>();
        for (int i = 0; i < runs; i++) if (eqShare[i] >= MIN_EQUITY_SHARE) eligible.add(i);
        Integer[] order = eligible.toArray(new Integer[0]);
        Arrays.sort(order, (a, b) -> Double.compare(sharpe[b], sharpe[a]));
        List<Map<String, Object>> top = new ArrayList<>();
        for (int i = 0; i < Math.min(10, order.length); i++) {
            int r = order[i];
            Map<String, Object> e = new LinkedHashMap<>();
            for (int j = 0; j < PARAM_NAMES.length; j++) e.put(PARAM_NAMES[j], paramRows[r][j]);
            e.put("equityShare", eqShare[r]);
            e.put("cagr", cagr[r]); e.put("volatility", vol[r]); e.put("maxDrawdown", dd[r]); e.put("sharpe", sharpe[r]);
            top.add(e);
        }

        Map<String, Object> meta = new LinkedHashMap<>();
        meta.put("runs", runs);
        meta.put("minEquityShare", MIN_EQUITY_SHARE);
        meta.put("eligibleForRanking", eligible.size());
        meta.put("seed", req.seed);
        meta.put("assetLabel", m.assetLabel);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("meta", meta);
        out.put("assetCagr", assetCagr);
        out.put("assetDrawdown", assetDd);
        out.put("assetVolatility", assetVol);
        out.put("shareBeatCagr", beatCagr / (double) runs);
        out.put("shareBetterDrawdown", betterDd / (double) runs);
        out.put("shareBeatBoth", beatBoth / (double) runs);
        out.put("cagr", distribution(cagr));
        out.put("volatility", distribution(vol));
        out.put("drawdown", distribution(dd));
        out.put("sharpe", distribution(sharpe));
        out.put("equityShare", distribution(eqShare));
        out.put("cagrHistogram", histogram(cagr, 24));
        out.put("baseCagr", d(baseStats, "cagr"));
        out.put("baseSharpe", baseSharpe);
        out.put("baseSharpePercentile", below / (double) runs);
        out.put("sensitivity", sensitivity);
        out.put("top", top);
        return out;
    }

    private static double spearman(double[] x, double[] y) {
        double[] rx = ranks(x), ry = ranks(y);
        int n = x.length;
        double mx = 0, my = 0;
        for (int i = 0; i < n; i++) { mx += rx[i]; my += ry[i]; }
        mx /= n; my /= n;
        double sxy = 0, sxx = 0, syy = 0;
        for (int i = 0; i < n; i++) {
            sxy += (rx[i] - mx) * (ry[i] - my);
            sxx += (rx[i] - mx) * (rx[i] - mx);
            syy += (ry[i] - my) * (ry[i] - my);
        }
        return sxx == 0 || syy == 0 ? 0 : sxy / Math.sqrt(sxx * syy);
    }

    private static double[] ranks(double[] v) {
        Integer[] idx = new Integer[v.length];
        for (int i = 0; i < idx.length; i++) idx[i] = i;
        Arrays.sort(idx, (a, b) -> Double.compare(v[a], v[b]));
        double[] r = new double[v.length];
        int i = 0;
        while (i < idx.length) {
            int j = i;
            while (j + 1 < idx.length && v[idx[j + 1]] == v[idx[i]]) j++;
            double avg = (i + j) / 2.0 + 1;
            for (int k = i; k <= j; k++) r[idx[k]] = avg;
            i = j + 1;
        }
        return r;
    }
}
