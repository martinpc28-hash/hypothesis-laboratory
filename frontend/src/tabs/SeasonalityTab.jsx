import { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { ui, colors } from "../theme.js";
import HeatmapGrid, { divergingColor } from "../HeatmapGrid.jsx";
import ScatterChart from "../ScatterChart.jsx";
import LineChart from "../LineChart.jsx";
import AuditPanel, { Drawer, ComponentDetail } from "../AuditPanel.jsx";

// Shared style for any "Return" number the user can click to audit (see AuditPanel) —
// a dotted underline + pointer cursor signals it's interactive without being noisy.
const auditableCell = {
  cursor: "pointer",
  textDecoration: "underline",
  textDecorationStyle: "dotted",
  textDecorationColor: colors.border,
  textUnderlineOffset: 3,
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const UNIVERSE_LABELS = { SECTOR: "Sectors", COUNTRY: "Countries" };

// e.g. startMonth=1 (Jan), lengthMonths=1 → signal is ONLY January, and the portfolio is
// bought entering February (the month right after the window ends) and held through 12/31.
// Shown explicitly because "Jan (1m)" alone, without the arrow, was confusing about when
// the portfolio actually starts.
function windowLabel(startMonth, lengthMonths) {
  const holdStartMonth = startMonth + lengthMonths; // always <=12 for combos that actually appear
  return `${MONTH_NAMES[startMonth - 1]} (${lengthMonths}m) → holdings from ${MONTH_NAMES[holdStartMonth - 1]}`;
}
const CURRENT_YEAR = new Date().getFullYear();
// Fixed at 2000 (not a rolling "N years back") rather than the prior 20-year rolling window:
// testing this combo back to 2000 — through the dot-com crash — turned up a much stronger,
// more economically sensible macro split (10Y Treasury level) than the shorter 2006+ window
// ever surfaced, so the extra history is worth defaulting to rather than opting into.
const DEFAULT_YEAR_FROM = 2000;
const DEFAULT_YEAR_TO = CURRENT_YEAR - 1;

function pct(v, digits = 1) {
  return v === null || v === undefined || Number.isNaN(v) ? "—" : `${(v * 100).toFixed(digits)}%`;
}

export default function SeasonalityTab({ setStatus }) {
  const [universe, setUniverse] = useState({ countries: [], sectors: [] });
  const [sources, setSources] = useState([]);

  const [universeType, setUniverseType] = useState("SECTOR"); // "COUNTRY" | "SECTOR"
  const [selectedSectors, setSelectedSectors] = useState(new Set());
  const [selectedCountries, setSelectedCountries] = useState(new Set());
  const [manualTicker, setManualTicker] = useState("");
  const [manualTickers, setManualTickers] = useState([]);
  const [currencyMode, setCurrencyMode] = useState("USD");

  const [dataSource, setDataSource] = useState("YAHOO_FINANCE");
  const [yearFrom, setYearFrom] = useState(DEFAULT_YEAR_FROM);
  const [yearTo, setYearTo] = useState(DEFAULT_YEAR_TO);
  const [signalStartMonth, setSignalStartMonth] = useState(1);
  const [signalLengthMonths, setSignalLengthMonths] = useState(2);
  const [minAssetsPerYear, setMinAssetsPerYear] = useState(4);

  const [testResult, setTestResult] = useState(null);
  const [sweepResult, setSweepResult] = useState(null);
  const [testLoading, setTestLoading] = useState(false);
  const [sweepLoading, setSweepLoading] = useState(false);
  const [audit, setAudit] = useState(null);

  // Macro regime context for whatever combo is currently shown above (e.g. XLK+XLE): does its
  // edge hold up across inflation/growth/rate/yield-curve/VIX regimes, or is it concentrated in
  // one of them? Separate from testResult/testLoading since it's an optional, heavier follow-up
  // (5 extra FRED series) the user asks for explicitly rather than something that should slow
  // down the main test's own auto-run.
  const [macroResult, setMacroResult] = useState(null);
  const [macroLoading, setMacroLoading] = useState(false);
  const [macroAudit, setMacroAudit] = useState(null);
  const [macroPickReason, setMacroPickReason] = useState(null);

  // Combinatorial optimizer ("Monte Carlo" per the user's ask) — tries every valid
  // (universe, signal window) combination and ranks by risk-adjusted return. Always USD:
  // mixing currencies into one return/volatility ranking across countries and sectors
  // wouldn't be a fair comparison, same reasoning as the fixed S&P 500/MSCI benchmarks above.
  const [mcUniverses, setMcUniverses] = useState(new Set(["SECTOR", "COUNTRY"]));
  const [mcLengths, setMcLengths] = useState(new Set([1, 2, 3]));
  const [mcYearFrom, setMcYearFrom] = useState(DEFAULT_YEAR_FROM);
  const [mcYearTo, setMcYearTo] = useState(DEFAULT_YEAR_TO);
  const [mcMinAssetsPerYear, setMcMinAssetsPerYear] = useState(2);
  // "ROTATING" (default) re-picks the top quartile of the WHOLE universe every year, like the
  // strategy above. "FIXED" commits to the same mcFixedSize tickers for the whole period,
  // held together. "ROTATING_SUBSET" restricts that same rotation logic to a chosen group of
  // mcFixedSize tickers instead of the whole universe — e.g. size 2 reproduces "always hold
  // whichever of these two led", searched over every possible pair instead of picked by hand.
  const [mcMode, setMcMode] = useState("ROTATING");
  const [mcFixedSize, setMcFixedSize] = useState(3);
  // Restricts every window tested to start in January — off by default (sweeps all 12 months
  // to find seasonality effects anywhere in the year), but useful to isolate "which assets"
  // from "which month" when comparing against a hand-picked Jan-Feb test elsewhere on the page.
  const [mcForceJanuary, setMcForceJanuary] = useState(false);
  // A combo built on very few years (e.g. a pair involving a ticker that only started trading
  // recently) can show a deceptively high score from a short, lucky sample. Null = let the
  // backend default to half the requested year range.
  const [mcMinYearsUsed, setMcMinYearsUsed] = useState(null);
  // What "best" means: this drives which single candidate wins each (universe, window) cell in
  // FIXED/ROTATING_SUBSET mode, not just how the results table is displayed afterward — a
  // different pair can genuinely win the SAME window under a different criterion, e.g. one with
  // higher raw return but more volatility than the risk-adjusted winner. That's why this has to
  // be a real search parameter (sent to the backend, triggers a re-run), not a client-side sort
  // of already-computed rows.
  const [mcRankBy, setMcRankBy] = useState("SCORE");
  const [mcResult, setMcResult] = useState(null);
  const [mcLoading, setMcLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [u, s] = await Promise.all([api.getSeasonalityUniverse(), api.getSeasonalitySources()]);
        setUniverse(u);
        setSources(s);
        const defaultSectors = new Set(u.sectors.map((a) => a.ticker));
        setSelectedSectors(defaultSectors);
        // Auto-run once with the default config, so the user sees output first.
        runTest({ tickersOverride: [...defaultSectors] });
      } catch (e) {
        setStatus({ type: "error", text: `Could not load the asset universe: ${e.message}` });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeTickers = useMemo(() => {
    const base = universeType === "SECTOR" ? [...selectedSectors] : [...selectedCountries];
    return [...new Set([...base, ...manualTickers])];
  }, [universeType, selectedSectors, selectedCountries, manualTickers]);

  // If the user trims the universe down (e.g. to just 2 sectors to compare head-to-head),
  // a stale higher "min assets/year" would silently zero out every year's stats —
  // clamp it down automatically so a 2-asset comparison actually produces numbers. Never
  // raises it back up on its own, so a deliberately strict threshold on a big universe is
  // left alone when more assets get added later.
  useEffect(() => {
    if (activeTickers.length >= 2 && minAssetsPerYear > activeTickers.length) {
      setMinAssetsPerYear(activeTickers.length);
    }
  }, [activeTickers.length]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggle(set, setSet, ticker) {
    const next = new Set(set);
    if (next.has(ticker)) next.delete(ticker);
    else next.add(ticker);
    setSet(next);
  }

  function addManualTicker() {
    const t = manualTicker.trim().toUpperCase();
    if (!t) return;
    if (!manualTickers.includes(t)) setManualTickers([...manualTickers, t]);
    setManualTicker("");
  }

  function removeManualTicker(t) {
    setManualTickers(manualTickers.filter((x) => x !== t));
  }

  async function runTest({ tickersOverride } = {}) {
    const tickers = tickersOverride || activeTickers;
    if (tickers.length < 2) {
      setStatus({ type: "error", text: "Pick at least 2 assets." });
      return;
    }
    setTestLoading(true);
    setStatus(null);
    setMacroResult(null); // stale otherwise — it's specific to the ticker set/window being replaced
    try {
      const result = await api.runSeasonalityTest({
        tickers,
        dataSource,
        currencyMode: universeType === "COUNTRY" ? currencyMode : "USD",
        yearFrom,
        yearTo,
        signalStartMonth,
        signalLengthMonths,
        minAssetsPerYear,
      });
      setTestResult(result);
    } catch (e) {
      setStatus({ type: "error", text: `Test failed: ${e.message}` });
    } finally {
      setTestLoading(false);
    }
  }

  async function runMacroInsights() {
    if (activeTickers.length < 2) return;
    setMacroLoading(true);
    setStatus(null);
    try {
      const result = await api.runSeasonalityMacroInsights({
        tickers: activeTickers,
        dataSource,
        currencyMode: universeType === "COUNTRY" ? currencyMode : "USD",
        yearFrom,
        yearTo,
        signalStartMonth,
        signalLengthMonths,
        minAssetsPerYear,
      });
      setMacroResult(result);
    } catch (e) {
      setStatus({ type: "error", text: `Macro insights failed: ${e.message}` });
    } finally {
      setMacroLoading(false);
    }
  }

  async function runSweep() {
    if (activeTickers.length < 2) {
      setStatus({ type: "error", text: "Pick at least 2 assets for the window sweep." });
      return;
    }
    setSweepLoading(true);
    setStatus(null);
    try {
      const result = await api.runSeasonalitySweep({
        tickers: activeTickers,
        dataSource,
        currencyMode: universeType === "COUNTRY" ? currencyMode : "USD",
        yearFrom,
        yearTo,
        minAssetsPerYear,
      });
      setSweepResult(result);
    } catch (e) {
      setStatus({ type: "error", text: `Window sweep failed: ${e.message}` });
    } finally {
      setSweepLoading(false);
    }
  }

  function toggleInSet(set, setSet, value) {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setSet(next);
  }

  async function runMonteCarlo() {
    if (mcUniverses.size === 0) {
      setStatus({ type: "error", text: "Pick at least one universe (sectors and/or countries) for the Monte Carlo." });
      return;
    }
    if (mcLengths.size === 0) {
      setStatus({ type: "error", text: "Pick at least one window length to test." });
      return;
    }
    if (mcYearFrom > mcYearTo) {
      setStatus({ type: "error", text: "The Monte Carlo's start year can't be greater than the end year." });
      return;
    }
    if ((mcMode === "FIXED" || mcMode === "ROTATING_SUBSET") && (!mcFixedSize || mcFixedSize < 2)) {
      setStatus({ type: "error", text: "For this mode, pick a number of assets of at least 2." });
      return;
    }
    setMcLoading(true);
    setStatus(null);
    try {
      const result = await api.runSeasonalityMonteCarlo({
        universes: [...mcUniverses],
        dataSource,
        currencyMode: "USD",
        yearFrom: mcYearFrom,
        yearTo: mcYearTo,
        minAssetsPerYear: mcMinAssetsPerYear,
        lengthMonths: [...mcLengths],
        startMonths: mcForceJanuary ? [1] : undefined,
        mode: mcMode,
        fixedSize: mcMode === "FIXED" || mcMode === "ROTATING_SUBSET" ? mcFixedSize : undefined,
        minYearsUsed: mcMinYearsUsed,
        rankBy: mcRankBy,
      });
      setMcResult(result);
    } catch (e) {
      setStatus({ type: "error", text: `Monte Carlo run failed: ${e.message}` });
    } finally {
      setMcLoading(false);
    }
  }

  return (
    <div>
      <div style={ui.card}>
        <h2 style={ui.cardTitle}>Seasonality Hypothesis Lab</h2>
        <p style={ui.cardSubtitle}>
          Do assets that outperform in an early window of the year go on to lead the rest of the year? Pick a
          universe, a data source, and a signal window (January-February by default) to test it.
        </p>
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        {/* Universe picker */}
        <div style={{ ...ui.card, flex: 1, minWidth: 300 }}>
          <h3 style={ui.cardTitle}>Universe</h3>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <button
              style={ui.button(universeType === "SECTOR" ? "primary" : "secondary")}
              onClick={() => setUniverseType("SECTOR")}
            >
              Sectors
            </button>
            <button
              style={ui.button(universeType === "COUNTRY" ? "primary" : "secondary")}
              onClick={() => setUniverseType("COUNTRY")}
            >
              Countries
            </button>
          </div>

          {universeType === "COUNTRY" && (
            <div style={{ display: "flex", gap: 12, marginBottom: 10, alignItems: "center" }}>
              <span style={{ fontSize: 13, color: colors.textMuted }}>Currency:</span>
              <button style={ui.button(currencyMode === "USD" ? "primary" : "secondary")} onClick={() => setCurrencyMode("USD")}>
                USD
              </button>
              <button style={ui.button(currencyMode === "LOCAL" ? "primary" : "secondary")} onClick={() => setCurrencyMode("LOCAL")}>
                Local currency
              </button>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, maxHeight: 220, overflowY: "auto" }}>
            {(universeType === "SECTOR" ? universe.sectors : universe.countries).map((a) => {
              const set = universeType === "SECTOR" ? selectedSectors : selectedCountries;
              const setSet = universeType === "SECTOR" ? setSelectedSectors : setSelectedCountries;
              return (
                <label key={a.ticker} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, cursor: "pointer" }}>
                  <input type="checkbox" checked={set.has(a.ticker)} onChange={() => toggle(set, setSet, a.ticker)} />
                  {a.label} <span style={{ color: colors.textMuted }}>({a.ticker})</span>
                </label>
              );
            })}
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <input
              style={{ ...ui.input, flex: 1 }}
              placeholder="Manual ticker, e.g. NVDA"
              value={manualTicker}
              onChange={(e) => setManualTicker(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addManualTicker()}
            />
            <button style={ui.button("secondary")} onClick={addManualTicker}>
              + Add
            </button>
          </div>
          {manualTickers.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
              {manualTickers.map((t) => (
                <span key={t} style={{ ...ui.badge("neutral"), cursor: "pointer" }} onClick={() => removeManualTicker(t)}>
                  {t} ✕
                </span>
              ))}
            </div>
          )}
          <p style={{ ...ui.muted, marginTop: 10 }}>{activeTickers.length} assets selected.</p>
        </div>

        {/* Test config */}
        <div style={{ ...ui.card, flex: 1, minWidth: 300 }}>
          <h3 style={ui.cardTitle}>Configuration</h3>
          <div style={ui.row}>
            <label style={ui.label}>
              Data source
              <select style={ui.input} value={dataSource} onChange={(e) => setDataSource(e.target.value)}>
                {sources.map((s) => (
                  <option key={s.id} value={s.id} disabled={!s.available}>
                    {s.name} {!s.available ? "(coming soon)" : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div style={{ ...ui.row, marginTop: 10 }}>
            <label style={ui.label}>
              Years from
              <input style={ui.input} type="number" value={yearFrom} onChange={(e) => setYearFrom(Number(e.target.value))} />
            </label>
            <label style={ui.label}>
              Years to
              <input style={ui.input} type="number" value={yearTo} onChange={(e) => setYearTo(Number(e.target.value))} />
            </label>
          </div>
          <div style={{ ...ui.row, marginTop: 10 }}>
            <label style={ui.label}>
              Signal window — start month
              <select style={ui.input} value={signalStartMonth} onChange={(e) => setSignalStartMonth(Number(e.target.value))}>
                {MONTH_NAMES.map((m, i) => (
                  <option key={i} value={i + 1}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <label style={ui.label}>
              Length (months)
              <select style={ui.input} value={signalLengthMonths} onChange={(e) => setSignalLengthMonths(Number(e.target.value))}>
                {[1, 2, 3].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div style={{ ...ui.row, marginTop: 10 }}>
            <label style={ui.label}>
              Min assets/year
              <input
                style={ui.input}
                type="number"
                min={2}
                value={minAssetsPerYear}
                onChange={(e) => setMinAssetsPerYear(Number(e.target.value))}
              />
            </label>
          </div>
          {activeTickers.length === 2 && (
            <p style={{ ...ui.muted, marginTop: 10 }}>
              With only 2 assets the "top quartile" is simply whichever one won that year — it's a
              head-to-head comparison, not a proper quartile statistic.
            </p>
          )}

          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button style={ui.button("primary")} onClick={() => runTest()} disabled={testLoading}>
              {testLoading ? "Running…" : "Run test"}
            </button>
            <button style={ui.button("secondary")} onClick={runSweep} disabled={sweepLoading}>
              {sweepLoading ? "Running…" : "Window sweep"}
            </button>
          </div>
        </div>
      </div>

      {testResult && (
        <TestResults
          result={testResult}
          onAudit={setAudit}
          macroResult={macroResult}
          macroLoading={macroLoading}
          onRunMacroInsights={runMacroInsights}
          onMacroAudit={setMacroAudit}
          onMacroPickReason={setMacroPickReason}
        />
      )}
      {sweepResult && <SweepResults result={sweepResult} />}

      <MonteCarloSection
        mcUniverses={mcUniverses}
        setMcUniverses={setMcUniverses}
        mcLengths={mcLengths}
        setMcLengths={setMcLengths}
        mcYearFrom={mcYearFrom}
        setMcYearFrom={setMcYearFrom}
        mcYearTo={mcYearTo}
        setMcYearTo={setMcYearTo}
        mcMinAssetsPerYear={mcMinAssetsPerYear}
        setMcMinAssetsPerYear={setMcMinAssetsPerYear}
        mcMode={mcMode}
        setMcMode={setMcMode}
        mcFixedSize={mcFixedSize}
        setMcFixedSize={setMcFixedSize}
        mcForceJanuary={mcForceJanuary}
        setMcForceJanuary={setMcForceJanuary}
        mcMinYearsUsed={mcMinYearsUsed}
        setMcMinYearsUsed={setMcMinYearsUsed}
        mcRankBy={mcRankBy}
        setMcRankBy={setMcRankBy}
        mcLoading={mcLoading}
        onRun={runMonteCarlo}
        mcResult={mcResult}
        toggleInSet={toggleInSet}
      />

      <AuditPanel audit={audit} onClose={() => setAudit(null)} />
      <MacroAuditDrawer detail={macroAudit} onClose={() => setMacroAudit(null)} />
      <MacroPickReasonDrawer detail={macroPickReason} onClose={() => setMacroPickReason(null)} onMacroAudit={setMacroAudit} />
    </div>
  );
}

function DataBadge({ meta }) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
      <span style={ui.badge("success")}>{meta.source}</span>
      <span style={ui.badge("neutral")}>{meta.currency}</span>
      <span style={ui.badge("neutral")}>
        {meta.yearFrom}–{meta.yearTo}
      </span>
      <span style={ui.badge("primary")}>
        Signal: {MONTH_NAMES[meta.signalStartMonth - 1]}–
        {MONTH_NAMES[(meta.signalStartMonth - 1 + meta.signalLengthMonths - 1) % 12]}
      </span>
    </div>
  );
}

function CoverageStrip({ coverage, tickers, yearFrom, yearTo }) {
  const years = [];
  for (let y = yearFrom; y <= yearTo; y++) years.push(y);
  const byKey = new Map(coverage.byTickerYear.map((r) => [`${r.ticker}-${r.year}`, r.covered]));
  const insufficientYears = new Set(coverage.byYear.filter((r) => !r.sufficient).map((r) => r.year));

  const cells = tickers.map((t) =>
    years.map((y) => {
      const covered = byKey.get(`${t}-${y}`);
      const flagged = insufficientYears.has(y);
      return {
        label: covered ? "✓" : "",
        color: !covered ? colors.surfaceAlt : flagged ? colors.warningSoft : colors.successSoft,
        title: `${t} ${y}: ${covered ? "has data" : "no data"}${flagged ? " — year with too few assets" : ""}`,
      };
    })
  );

  return (
    <div style={ui.card}>
      <h3 style={ui.cardTitle}>Data coverage</h3>
      <p style={ui.cardSubtitle}>
        Years in <span style={{ background: colors.warningSoft, padding: "0 4px" }}>yellow</span> have fewer assets
        with data than the configured minimum — they're excluded from the statistics.
      </p>
      <div style={ui.tableScroll}>
        <HeatmapGrid rowLabels={tickers} colLabels={years} cells={cells} cellWidth={34} rowLabelWidth={70} />
      </div>
    </div>
  );
}

function CorrelationBlock({ title, corr, points, xLabel, yLabel }) {
  return (
    <div style={{ flex: 1, minWidth: 320 }}>
      <h4 style={{ margin: "0 0 8px 0", fontSize: 14 }}>{title}</h4>
      <ScatterChart points={points} rho={corr.rho} pValue={corr.pValue} n={corr.n} xLabel={xLabel} yLabel={yLabel} />
    </div>
  );
}

function PersistenceTable({ persistenceRest, persistenceFullYear }) {
  return (
    <div style={ui.tableScroll}>
      <table style={ui.table}>
        <thead>
          <tr>
            <th style={ui.th}>Comparison</th>
            <th style={ui.th}>Observed persistence</th>
            <th style={ui.th}>Expected by chance</th>
            <th style={ui.th}>Years used</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={ui.td}>Rest of year</td>
            <td style={{ ...ui.td, fontWeight: 700 }}>{pct(persistenceRest.average)}</td>
            <td style={ui.td}>{pct(persistenceRest.expectedRandom)}</td>
            <td style={ui.td}>{persistenceRest.yearsUsed}</td>
          </tr>
          <tr>
            <td style={ui.td}>Full year</td>
            <td style={{ ...ui.td, fontWeight: 700 }}>{pct(persistenceFullYear.average)}</td>
            <td style={ui.td}>{pct(persistenceFullYear.expectedRandom)}</td>
            <td style={ui.td}>{persistenceFullYear.yearsUsed}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

const HEATMAP_FIELD_META = {
  signalReturn: { auditField: "signalAudit", label: "Return — signal window" },
  restReturn: { auditField: "restAudit", label: "Return — rest of year" },
  fullYearReturn: { auditField: "fullYearAudit", label: "Return — full year" },
};

// Row label for the fixed S&P 500 reference row appended to every heatmap — a string, not a
// ticker, so it never collides with a user-selected "SPY" (the COUNTRY universe's own "United
// States" ticker) in the row-label list, even though both would show the same underlying data.
const SP500_ROW_LABEL = "S&P 500";

function RankingHeatmaps({ panel, sp500Panel, tickers, yearFrom, yearTo, onAudit }) {
  const years = [];
  for (let y = yearFrom; y <= yearTo; y++) years.push(y);
  const byKey = new Map(panel.map((p) => [`${p.ticker}-${p.year}`, p]));
  const sp500ByYear = new Map((sp500Panel || []).map((p) => [p.year, p]));
  const rowLabels = [...tickers, SP500_ROW_LABEL];

  // Per year, who had the best signal-window return — the "winner" the user asked to see.
  // Scoped to the user's own selected tickers only: the S&P 500 row is a fixed reference to
  // compare against, not a candidate that can "win".
  const winnerByYear = new Map();
  for (const y of years) {
    let best = null;
    for (const t of tickers) {
      const p = byKey.get(`${t}-${y}`);
      if (p && p.signalReturn !== null && (best === null || p.signalReturn > best.signalReturn)) {
        best = { ticker: t, signalReturn: p.signalReturn };
      }
    }
    if (best) winnerByYear.set(y, best.ticker);
  }

  function buildCells(field, { highlightWinner = false } = {}) {
    const { auditField, label } = HEATMAP_FIELD_META[field];
    return rowLabels.map((t) =>
      years.map((y) => {
        const isBenchmarkRow = t === SP500_ROW_LABEL;
        const p = isBenchmarkRow ? sp500ByYear.get(y) : byKey.get(`${t}-${y}`);
        const v = p ? p[field] : null;
        const isWinner = highlightWinner && !isBenchmarkRow && winnerByYear.get(y) === t;
        const componentAudit = p ? p[auditField] : null;
        return {
          label: v === null || v === undefined ? "" : `${isWinner ? "*" : ""}${(v * 100).toFixed(0)}%`,
          color: v === null || v === undefined ? colors.surfaceAlt : divergingColor(v, 0.4),
          title: p
            ? `${t} ${y}: ${(v * 100).toFixed(1)}%${isWinner ? " — won the signal window that year" : ""} — click to audit`
            : "no data",
          onClick:
            componentAudit && componentAudit.value !== null
              ? () => onAudit({ title: `${t} · ${y}`, subtitle: label, components: [componentAudit] })
              : undefined,
        };
      })
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h4 style={{ margin: "0 0 8px 0", fontSize: 14 }}>
          Return — signal window <span style={{ fontWeight: 400, color: colors.textMuted }}>(* = year's winner)</span>
        </h4>
        <div style={ui.tableScroll}>
          <HeatmapGrid
            rowLabels={rowLabels}
            colLabels={years}
            cells={buildCells("signalReturn", { highlightWinner: true })}
            cellWidth={48}
            rowLabelWidth={70}
          />
        </div>
      </div>
      <div>
        <h4 style={{ margin: "0 0 8px 0", fontSize: 14 }}>Return — rest of year</h4>
        <div style={ui.tableScroll}>
          <HeatmapGrid rowLabels={rowLabels} colLabels={years} cells={buildCells("restReturn")} cellWidth={44} rowLabelWidth={70} />
        </div>
      </div>
      <div>
        <h4 style={{ margin: "0 0 8px 0", fontSize: 14 }}>Return — full year</h4>
        <div style={ui.tableScroll}>
          <HeatmapGrid rowLabels={rowLabels} colLabels={years} cells={buildCells("fullYearReturn")} cellWidth={44} rowLabelWidth={70} />
        </div>
      </div>
      <p style={{ ...ui.muted, margin: 0 }}>
        Click any cell with a value to see the exact calculation (dates and prices used). The "{SP500_ROW_LABEL}" row
        is a fixed benchmark (SPY, USD), always shown for comparison — it never counts as the year's winner.
      </p>
    </div>
  );
}

// Footer row for the per-year strategy tables: how many years the differential came out
// positive vs. negative, out of the years with actual data (a quick "does this beat the
// benchmark more often than not" tally), plus the total alpha actually generated over the
// whole period — the spread between the strategy's and the benchmark's TOTAL compounded
// return (last point of the cumulative curve), not a sum or average of the yearly diffs.
// That distinction matters: compounding means the two aren't the same number.
function DiffScoreRow({ perYear, diffKey, cumulative, strategyCumKey, benchmarkCumKey, colSpan, alphaLabel = "top quartile minus benchmark" }) {
  const rows = perYear.filter((r) => r[diffKey] !== null && r[diffKey] !== undefined);
  const positive = rows.filter((r) => r[diffKey] >= 0).length;
  const pctPositive = rows.length ? Math.round((positive / rows.length) * 100) : 0;

  const lastCumulative = cumulative && cumulative.length ? cumulative[cumulative.length - 1] : null;
  const hasAlpha = lastCumulative && lastCumulative[strategyCumKey] !== undefined && lastCumulative[benchmarkCumKey] !== undefined;
  const totalAlpha = hasAlpha ? lastCumulative[strategyCumKey] - lastCumulative[benchmarkCumKey] : null;

  return (
    <tr>
      <td
        colSpan={colSpan}
        style={{
          ...ui.td,
          borderTop: `2px solid ${colors.border}`,
          borderBottom: "none",
          whiteSpace: "normal",
        }}
      >
        <div style={{ fontWeight: 700, color: colors.text }}>
          {positive}/{rows.length} years with a positive differential ({pctPositive}%)
        </div>
        {hasAlpha && (
          <div style={{ marginTop: 4, fontWeight: 700, color: totalAlpha >= 0 ? colors.success : colors.danger }}>
            Total alpha generated: {totalAlpha >= 0 ? "+" : ""}
            {pct(totalAlpha)}{" "}
            <span style={{ fontWeight: 400, color: colors.textMuted }}>
              (cumulative return over the whole period: {alphaLabel})
            </span>
          </div>
        )}
      </td>
    </tr>
  );
}

function TestResults({ result, onAudit, macroResult, macroLoading, onRunMacroInsights, onMacroAudit, onMacroPickReason }) {
  const {
    meta,
    panel,
    coverage,
    correlationVsRest,
    correlationVsFullYear,
    correlationVsRestExcessSp500,
    persistenceVsRest,
    persistenceVsFullYear,
    strategy,
  } = result;
  const tickers = meta.tickers;

  const restPoints = panel
    .filter((p) => p.signalReturn !== null && p.restReturn !== null && p.covered)
    .map((p) => ({ x: p.signalReturn, y: p.restReturn, label: `${p.ticker} ${p.year}` }));
  const fullYearPoints = panel
    .filter((p) => p.signalReturn !== null && p.fullYearReturn !== null && p.covered)
    .map((p) => ({ x: p.signalReturn, y: p.fullYearReturn, label: `${p.ticker} ${p.year}` }));

  // One point per YEAR (not per ticker) — the top-quartile-by-signal group the strategy would
  // actually hold that year (same grouping "Strategy performance" uses), with the S&P 500's own
  // signal/rest-of-year return for that same year subtracted out of both axes. Isolates "the
  // pick beat/lagged the market" from "the whole market moved together that year" (pure beta) —
  // computed backend-side (see correlationVsRestExcessSp500's comment) since it needs the same
  // quartile grouping the strategy backtest uses, not something reconstructable from the raw panel.
  const restPointsExcessSp500 = (result.pickVsSp500Panel || [])
    .filter((p) => p.signalExcess !== null && p.restExcess !== null)
    .map((p) => ({ x: p.signalExcess, y: p.restExcess, label: `${p.year}` }));

  return (
    <div>
      <div style={ui.card}>
        <DataBadge meta={meta} />
        <p style={ui.muted}>
          The p-value of the correlation against "full year" tends to come out lower (more "significant") because the
          signal window is already part of the full year — that's arithmetic, not persistence. The comparison against
          "rest of year" is the one that isolates whether the effect persists once the signal window ends.
        </p>
      </div>

      <CoverageStrip coverage={coverage} tickers={tickers} yearFrom={meta.yearFrom} yearTo={meta.yearTo} />

      <div style={ui.card}>
        <h3 style={ui.cardTitle}>Return heatmap by year</h3>
        <RankingHeatmaps
          panel={panel}
          sp500Panel={result.sp500Panel}
          tickers={tickers}
          yearFrom={meta.yearFrom}
          yearTo={meta.yearTo}
          onAudit={onAudit}
        />
      </div>

      <div style={ui.card}>
        <h3 style={ui.cardTitle}>Signal vs. comparison correlation (Spearman)</h3>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
          <CorrelationBlock
            title="Signal vs. rest of year"
            corr={correlationVsRest}
            points={restPoints}
            xLabel="Signal window return"
            yLabel="Rest of year return"
          />
          <CorrelationBlock
            title="Signal vs. full year"
            corr={correlationVsFullYear}
            points={fullYearPoints}
            xLabel="Signal window return"
            yLabel="Full year return"
          />
          <CorrelationBlock
            title="The pick vs. rest of year (excess over S&P 500)"
            corr={correlationVsRestExcessSp500}
            points={restPointsExcessSp500}
            xLabel="Pick's signal window return − S&P 500"
            yLabel="Pick's rest of year return − S&P 500"
          />
        </div>
        <p style={{ ...ui.muted, marginTop: 8 }}>
          Unlike the two panels above (every individual ticker, whether or not it was ever held), this one is ONE
          point per year — the top-quartile-by-signal group the strategy actually holds that year (just "the
          winner" for a 2-ticker universe) — with the S&amp;P 500's own return for that same window subtracted out
          of both axes. Removes "the whole market moved together that year" (beta) so what's left is whether the
          strength of the SIGNAL'S ACTUAL PICK predicts whether that same pick beats or lags the market afterward —
          the number that actually matters for the strategy this page backtests.
        </p>
      </div>

      <div style={ui.card}>
        <h3 style={ui.cardTitle}>Quartile persistence</h3>
        <p style={ui.cardSubtitle}>
          % of assets in the top quartile of the signal window that stay in the top quartile of the
          comparison window. 25% is what's expected if there's no relationship.
        </p>
        <PersistenceTable persistenceRest={persistenceVsRest} persistenceFullYear={persistenceVsFullYear} />
      </div>

      <div style={ui.card}>
        <h3 style={ui.cardTitle}>Strategy performance</h3>
        <p style={ui.cardSubtitle}>
          Equal-weighted portfolio of the top quartile by signal, bought at the end of the signal window and held
          through year-end, against the full equal-weighted universe over the same period (avoids look-ahead bias). S&amp;P
          500 (SPY) and MSCI World (the real index, not an ETF proxy) are added as a fixed benchmark using their own
          FULL calendar-year return (buy-and-hold all year, not just the strategy's holding period) — always in USD,
          regardless of the test's currency.
          {!strategy.sp500Available || !strategy.msciWorldAvailable ? (
            <>
              {" "}
              {!strategy.sp500Available && "S&P 500 is not shown"}
              {!strategy.sp500Available && !strategy.msciWorldAvailable && " and "}
              {!strategy.msciWorldAvailable && "MSCI World is not shown"} because it doesn't have data for the whole
              requested year range.
            </>
          ) : null}
        </p>
        <LineChart
          points={strategy.cumulative}
          series={[
            { key: "cumulativeStrategy", label: "Top quartile", color: colors.primary },
            { key: "cumulativeBenchmark", label: "Universe", color: colors.textMuted },
            ...(strategy.sp500Available ? [{ key: "cumulativeSp500", label: "S&P 500", color: colors.warning }] : []),
            ...(strategy.msciWorldAvailable ? [{ key: "cumulativeMsciWorld", label: "MSCI World", color: "#a78bfa" }] : []),
          ]}
        />

        <div style={{ ...ui.tableScroll, marginTop: 12 }}>
          <table style={ui.table}>
            <thead>
              <tr>
                <th style={ui.th}>Series</th>
                <th style={ui.th}>Annualized return (CAGR)</th>
                <th style={ui.th}>Annualized volatility</th>
                <th style={ui.th}>Maximum drawdown</th>
              </tr>
            </thead>
            <tbody>
              {[
                { key: "strategy", label: "Top quartile", show: true },
                { key: "benchmark", label: "Universe", show: true },
                { key: "sp500", label: "S&P 500", show: strategy.sp500Available },
                { key: "msciWorld", label: "MSCI World", show: strategy.msciWorldAvailable },
              ]
                .filter((s) => s.show && strategy.stats[s.key])
                .map((s) => (
                  <tr key={s.key}>
                    <td style={ui.td}>{s.label}</td>
                    <td style={{ ...ui.td, color: strategy.stats[s.key].cagr >= 0 ? colors.success : colors.danger, fontWeight: 700 }}>
                      {pct(strategy.stats[s.key].cagr)}
                    </td>
                    <td style={ui.td}>{pct(strategy.stats[s.key].volatility)}</td>
                    <td style={{ ...ui.td, color: colors.danger, fontWeight: 700 }}>
                      {pct(strategy.stats[s.key].maxDrawdown)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <p style={ui.muted}>
          Volatility = standard deviation of the equal-weighted portfolio's actual DAILY returns over the
          periods it's actually held each year, annualized (×√252) — not an average of yearly returns.
          Maximum drawdown = the largest drop from a peak to a trough in each series' cumulative curve (see the
          "Drawdown" column in the tables below for a year-by-year view).
        </p>

        <div style={{ ...ui.tableScroll, marginTop: 12 }}>
          <table style={ui.table}>
            <thead>
              <tr>
                <th style={ui.th}>Year</th>
                <th style={ui.th}>Top quartile</th>
                <th style={ui.th}>Universe</th>
                <th style={ui.th}>Differential</th>
                <th style={ui.th}>Max Drawdown (top quartile)</th>
              </tr>
            </thead>
            <tbody>
              {strategy.perYear.map((r) => (
                <tr key={r.year}>
                  <td style={ui.td}>{r.year}</td>
                  <td
                    style={{ ...ui.td, ...auditableCell }}
                    title="Click to audit this number"
                    onClick={() =>
                      onAudit({ title: `Top quartile · ${r.year}`, subtitle: "Rest of year return (equal-weighted)", components: r.strategyReturnAudit })
                    }
                  >
                    {pct(r.strategyReturn)}
                  </td>
                  <td
                    style={{ ...ui.td, ...auditableCell }}
                    title="Click to audit this number"
                    onClick={() =>
                      onAudit({ title: `Universe · ${r.year}`, subtitle: "Rest of year return (equal-weighted, full universe)", components: r.benchmarkReturnAudit })
                    }
                  >
                    {pct(r.benchmarkReturn)}
                  </td>
                  <td style={{ ...ui.td, color: r.diff >= 0 ? colors.success : colors.danger, fontWeight: 700 }}>
                    {r.diff >= 0 ? "+" : ""}
                    {pct(r.diff)}
                  </td>
                  <td style={{ ...ui.td, color: r.strategyDrawdown < 0 ? colors.danger : colors.textMuted }}>
                    {pct(r.strategyDrawdown)}
                  </td>
                </tr>
              ))}
              <DiffScoreRow
                perYear={strategy.perYear}
                diffKey="diff"
                cumulative={strategy.cumulative}
                strategyCumKey="cumulativeStrategy"
                benchmarkCumKey="cumulativeBenchmark"
                colSpan={5}
              />
            </tbody>
          </table>
        </div>

        {strategy.sp500Available && (
          <div style={{ ...ui.tableScroll, marginTop: 16 }}>
            <table style={ui.table}>
              <thead>
                <tr>
                  <th style={ui.th}>Year</th>
                  <th style={ui.th}>Top quartile</th>
                  <th style={ui.th}>S&amp;P 500</th>
                  <th style={ui.th}>Differential</th>
                  <th style={ui.th}>Max Drawdown (top quartile)</th>
                  <th style={ui.th}>Max Drawdown (S&amp;P 500)</th>
                </tr>
              </thead>
              <tbody>
                {strategy.perYear.map((r) => (
                  <tr key={r.year}>
                    <td style={ui.td}>{r.year}</td>
                    <td
                      style={{ ...ui.td, ...auditableCell }}
                      title="Click to audit this number"
                      onClick={() =>
                        onAudit({ title: `Top quartile · ${r.year}`, subtitle: "Rest of year return (equal-weighted)", components: r.strategyReturnAudit })
                      }
                    >
                      {pct(r.strategyReturn)}
                    </td>
                    <td
                      style={{ ...ui.td, ...auditableCell }}
                      title="Click to audit this number"
                      onClick={() =>
                        onAudit({ title: `S&P 500 · ${r.year}`, subtitle: "Full calendar-year return (SPY, USD)", components: r.sp500ReturnAudit })
                      }
                    >
                      {pct(r.sp500Return)}
                    </td>
                    <td style={{ ...ui.td, color: r.diffVsSp500 >= 0 ? colors.success : colors.danger, fontWeight: 700 }}>
                      {r.diffVsSp500 >= 0 ? "+" : ""}
                      {pct(r.diffVsSp500)}
                    </td>
                    <td style={{ ...ui.td, color: r.strategyDrawdown < 0 ? colors.danger : colors.textMuted }}>
                      {pct(r.strategyDrawdown)}
                    </td>
                    <td style={{ ...ui.td, color: r.sp500Drawdown < 0 ? colors.danger : colors.textMuted }}>
                      {pct(r.sp500Drawdown)}
                    </td>
                  </tr>
                ))}
                <DiffScoreRow
                  perYear={strategy.perYear}
                  diffKey="diffVsSp500"
                  cumulative={strategy.cumulative}
                  strategyCumKey="cumulativeStrategy"
                  benchmarkCumKey="cumulativeSp500"
                  colSpan={6}
                />
              </tbody>
            </table>
          </div>
        )}
      </div>

      <MacroInsightsSection
        tickers={tickers}
        strategy={strategy}
        macroResult={macroResult}
        macroLoading={macroLoading}
        onRun={onRunMacroInsights}
        onAudit={onAudit}
        onMacroAudit={onMacroAudit}
        onMacroPickReason={onMacroPickReason}
      />
    </div>
  );
}

// Friendly label + unit formatter for each macro feature the backend's split-finder can pick —
// kept here rather than sent from the backend since it's pure display concern. inflationYoY/
// growthYoY are fractions (0.042 = 4.2%); rateLevel/rateChangeYoY/yieldCurveSlope are already in
// percentage points as FRED publishes them; vixAverage is a plain index level, not a percentage.
const MACRO_FEATURE_META = {
  inflationYoY: { label: "Inflation (YoY, CPI)", format: (v) => pct(v, 1) },
  growthYoY: { label: "Growth (YoY, Industrial Production)", format: (v) => pct(v, 1) },
  rateLevel: { label: "10-Year Treasury yield", format: (v) => `${v.toFixed(2)}%` },
  rateChangeYoY: { label: "10-Year yield, change vs. a year ago", format: (v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}pp` },
  yieldCurveSlope: { label: "Yield curve slope (10Y − 2Y)", format: (v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}pp` },
  vixAverage: { label: "VIX (average during the signal window)", format: (v) => v.toFixed(1) },
};

function MacroInsightsSection({ tickers, strategy, macroResult, macroLoading, onRun, onAudit, onMacroAudit, onMacroPickReason }) {
  return (
    <div style={ui.card}>
      <h3 style={ui.cardTitle}>Macro regime context</h3>
      <p style={ui.cardSubtitle}>
        Does this combo's edge ({tickers.join("+")}) hold up across different economic backdrops, or is it
        concentrated in one of them? Pulls inflation (CPI), growth (Industrial Production), the 10-Year Treasury
        yield, the 10Y-2Y yield curve slope, and the VIX from FRED for each year — all "as of" the moment the signal
        window ends, never later, so nothing here could have leaked into a real decision after the fact — then
        searches for the single macro reading that best separates the years this combo worked from the years it
        didn't. Click any macro number to see exactly where it comes from and what time span it covers.
      </p>

      {!macroResult && (
        <button style={ui.button("secondary")} onClick={onRun} disabled={macroLoading}>
          {macroLoading ? "Fetching macro data…" : "Run macro regime analysis"}
        </button>
      )}

      {macroResult && (
        <MacroInsightsResult
          result={macroResult}
          strategy={strategy}
          onAudit={onAudit}
          onMacroAudit={onMacroAudit}
          onMacroPickReason={onMacroPickReason}
        />
      )}
    </div>
  );
}

// Small clickable number with the same "auditable" dotted underline used elsewhere — opens the
// macro audit drawer for one feature reading instead of the return-audit one.
function MacroValue({ value, entry, format, onMacroAudit, featureLabel }) {
  if (value === null || value === undefined) return <span>—</span>;
  return (
    <span
      style={auditableCell}
      title="Click to see where this number comes from"
      onClick={() => entry && onMacroAudit({ featureLabel, entry })}
    >
      {format(value)}
    </span>
  );
}

// What the asset-recommendation split would have picked for ONE year, applying the same
// feature+threshold found on the whole sample to that year's own macro reading — lets the
// yearly table show, side by side with the actual Winner, whether the macro-based read would
// have called it correctly that year (including years the raw signal itself got wrong).
function macroPickFor(row, assetSplit) {
  if (!assetSplit) return null;
  const value = row[assetSplit.feature];
  if (value === null || value === undefined) return null;
  const isBelow = value <= assetSplit.threshold;
  const tickerAShare = isBelow ? assetSplit.tickerAShareBelow : assetSplit.tickerAShareAbove;
  return tickerAShare >= 0.5 ? assetSplit.tickerA : assetSplit.tickerB;
}

function MacroInsightsResult({ result, strategy, onAudit, onMacroAudit, onMacroPickReason }) {
  const { meta, yearly, edgeSplit, assetSplit, liveRead, macroFilteredStrategy } = result;
  const byKey = (row, feature) => (row.macroAudit ? row.macroAudit[feature] : null);
  const showAssetCols = meta.tickers.length === 2;
  const macroReturnByYear = new Map((macroFilteredStrategy?.perYear ?? []).map((m) => [m.year, m]));

  return (
    <div>
      <p style={ui.muted}>
        {meta.source} · {meta.yearFrom}–{meta.yearTo} · {meta.yearsUsed} years with data
      </p>

      {liveRead && <LiveReadCallout liveRead={liveRead} onAudit={onAudit} onMacroAudit={onMacroAudit} />}

      {assetSplit ? (
        <AssetSplitCallout assetSplit={assetSplit} yearsUsed={meta.yearsUsed} />
      ) : meta.tickers.length === 2 ? (
        <p style={{ ...ui.muted, marginTop: 8 }}>
          No macro feature separated the years {meta.tickers[0]} led from the years {meta.tickers[1]} led by enough
          margin — no asset recommendation shown, on purpose, rather than forcing one that isn't real.
        </p>
      ) : null}

      {edgeSplit ? (
        <div
          style={{
            background: colors.surfaceAlt,
            border: `1px solid ${colors.border}`,
            borderRadius: 10,
            padding: 16,
            marginTop: 8,
            marginBottom: 16,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: colors.textMuted }}>
            Does trusting the signal even help? (separate from which asset to hold)
          </div>
          <p style={{ margin: "6px 0 12px 0", fontSize: 14 }}>
            When <strong>{MACRO_FEATURE_META[edgeSplit.feature]?.label || edgeSplit.feature}</strong> was{" "}
            <strong>below {MACRO_FEATURE_META[edgeSplit.feature]?.format(edgeSplit.threshold) ?? edgeSplit.threshold}</strong>,
            buying the signal's pick beat the group average in{" "}
            <strong style={{ color: colors.success }}>{pct(edgeSplit.hitRateBelow, 0)}</strong> of {edgeSplit.nBelow} years
            (avg edge {pct(edgeSplit.meanDiffBelow)}). Above that threshold, it worked in{" "}
            <strong style={{ color: edgeSplit.hitRateAbove >= 0.5 ? colors.success : colors.danger }}>
              {pct(edgeSplit.hitRateAbove, 0)}
            </strong>{" "}
            of {edgeSplit.nAbove} years (avg edge {pct(edgeSplit.meanDiffAbove)}).
          </p>
          <p style={{ ...ui.muted, margin: 0 }}>
            {edgeSplit.fixed
              ? "Regla fija (no se recalcula en cada corrida) — mismo motivo que el split de activo: evita que el umbral cambie entre corridas por una diferencia mínima de datos."
              : `One of 6 macro features tested, kept to a single split (a one-level decision tree, or "stump") because ${meta.yearsUsed} yearly observations isn't enough data to trust anything with more moving parts. A hypothesis to watch, not a proven rule — found by looking at the same years it's reported on, so some of this is expected to be noise even if the underlying effect is real.`}
          </p>
        </div>
      ) : (
        <p style={{ ...ui.muted, marginTop: 8 }}>
          No macro feature separated the good years from the bad years by enough margin — no split shown, on purpose,
          rather than forcing one that isn't real.
        </p>
      )}

      <div style={ui.tableScroll}>
        <table style={ui.table}>
          <thead>
            <tr>
              <th style={ui.th}>Year</th>
              <th style={ui.th} title="Whether the RAW signal's own pick beat the universe average — independent of the Macro pick/return columns, which can still be right even when this is a miss (and vice versa).">
                Hit (signal only)
              </th>
              {showAssetCols && <th style={ui.th}>Signal pick</th>}
              {showAssetCols && <th style={ui.th}>Winner</th>}
              {showAssetCols && assetSplit && (
                <th style={ui.th} title="Colored green when it matches Winner that year, red when it doesn't — check this, not the Hit column, to see if the macro filter would have saved you.">
                  Macro pick
                </th>
              )}
              {showAssetCols && macroFilteredStrategy && (
                <th style={ui.th} title="The return you'd actually have made that year holding whatever the macro filter picked (always defers to macro on disagreement) — this is the number that reflects the macro filter, unlike Edge/Hit above.">
                  Macro filter return
                </th>
              )}
              <th style={ui.th}>Inflation (YoY)</th>
              <th style={ui.th}>Growth (YoY)</th>
              <th style={ui.th}>10Y yield</th>
              <th style={ui.th}>10Y yield Δ (YoY)</th>
              <th style={ui.th}>Yield curve (10Y−2Y)</th>
              <th style={ui.th}>VIX (avg)</th>
            </tr>
          </thead>
          <tbody>
            {yearly.map((r) => {
              const macroPick = showAssetCols ? macroPickFor(r, assetSplit) : null;
              const macroAgrees = macroPick && r.winner ? macroPick === r.winner : null;
              return (
              <tr key={r.year}>
                <td style={ui.td}>{r.year}</td>
                <td style={{ ...ui.td, color: r.hit ? colors.success : colors.danger, fontWeight: 700 }}>{r.hit ? "✓" : "✕"}</td>
                {showAssetCols && (
                  <td
                    style={r.signalPick ? { ...ui.td, ...auditableCell } : ui.td}
                    title={r.signalPick ? "Click to audit this pick's return" : undefined}
                    onClick={
                      r.signalPick
                        ? () =>
                            onAudit({
                              title: `Signal pick · ${r.year}`,
                              subtitle: "Rest of year return (chosen by highest signal-window return)",
                              components: r.strategyReturnAudit,
                            })
                        : undefined
                    }
                  >
                    {r.signalPick ?? "—"}
                  </td>
                )}
                {showAssetCols && <td style={ui.td}>{r.winner ?? "—"}</td>}
                {showAssetCols && assetSplit && (
                  <td
                    style={{
                      ...ui.td,
                      ...(macroPick ? auditableCell : null),
                      color: macroAgrees === null ? colors.textMuted : macroAgrees ? colors.success : colors.danger,
                    }}
                    title={macroPick ? "Click to see why this asset was picked" : undefined}
                    onClick={
                      macroPick
                        ? () =>
                            onMacroPickReason({
                              year: r.year,
                              feature: assetSplit.feature,
                              value: r[assetSplit.feature],
                              threshold: assetSplit.threshold,
                              tickerA: assetSplit.tickerA,
                              tickerB: assetSplit.tickerB,
                              tickerAShareBelow: assetSplit.tickerAShareBelow,
                              tickerAShareAbove: assetSplit.tickerAShareAbove,
                              nBelow: assetSplit.nBelow,
                              nAbove: assetSplit.nAbove,
                              pick: macroPick,
                              entry: byKey(r, assetSplit.feature),
                            })
                        : undefined
                    }
                  >
                    {macroPick ?? "—"}
                  </td>
                )}
                {showAssetCols && macroFilteredStrategy && (() => {
                  const macroRow = macroReturnByYear.get(r.year);
                  return (
                    <td
                      style={{
                        ...ui.td,
                        ...(macroRow ? auditableCell : null),
                        color: !macroRow ? colors.textMuted : macroRow.chosenReturn >= 0 ? colors.success : colors.danger,
                        fontWeight: 700,
                      }}
                      title={macroRow ? "Click to see where this number comes from" : undefined}
                      onClick={
                        macroRow
                          ? () =>
                              onAudit({
                                title: `Macro filter return · ${r.year}`,
                                subtitle: `Holds ${macroRow.macroPick} (macro pick) — always defers to macro on disagreement with the signal`,
                                components: [macroRow.chosenReturnAudit],
                              })
                          : undefined
                      }
                    >
                      {macroRow ? `${macroRow.chosenReturn >= 0 ? "+" : ""}${pct(macroRow.chosenReturn)}` : "—"}
                    </td>
                  );
                })()}
                <td style={ui.td}>
                  <MacroValue
                    value={r.inflationYoY}
                    entry={byKey(r, "inflationYoY")}
                    format={MACRO_FEATURE_META.inflationYoY.format}
                    featureLabel={MACRO_FEATURE_META.inflationYoY.label}
                    onMacroAudit={onMacroAudit}
                  />
                </td>
                <td style={ui.td}>
                  <MacroValue
                    value={r.growthYoY}
                    entry={byKey(r, "growthYoY")}
                    format={MACRO_FEATURE_META.growthYoY.format}
                    featureLabel={MACRO_FEATURE_META.growthYoY.label}
                    onMacroAudit={onMacroAudit}
                  />
                </td>
                <td style={ui.td}>
                  <MacroValue
                    value={r.rateLevel}
                    entry={byKey(r, "rateLevel")}
                    format={MACRO_FEATURE_META.rateLevel.format}
                    featureLabel={MACRO_FEATURE_META.rateLevel.label}
                    onMacroAudit={onMacroAudit}
                  />
                </td>
                <td style={ui.td}>
                  <MacroValue
                    value={r.rateChangeYoY}
                    entry={byKey(r, "rateChangeYoY")}
                    format={MACRO_FEATURE_META.rateChangeYoY.format}
                    featureLabel={MACRO_FEATURE_META.rateChangeYoY.label}
                    onMacroAudit={onMacroAudit}
                  />
                </td>
                <td style={ui.td}>
                  <MacroValue
                    value={r.yieldCurveSlope}
                    entry={byKey(r, "yieldCurveSlope")}
                    format={MACRO_FEATURE_META.yieldCurveSlope.format}
                    featureLabel={MACRO_FEATURE_META.yieldCurveSlope.label}
                    onMacroAudit={onMacroAudit}
                  />
                </td>
                <td style={ui.td}>
                  <MacroValue
                    value={r.vixAverage}
                    entry={byKey(r, "vixAverage")}
                    format={MACRO_FEATURE_META.vixAverage.format}
                    featureLabel={MACRO_FEATURE_META.vixAverage.label}
                    onMacroAudit={onMacroAudit}
                  />
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {macroFilteredStrategy && strategy && (
        <MacroFilteredStrategySection macroFilteredStrategy={macroFilteredStrategy} strategy={strategy} tickers={meta.tickers} />
      )}
    </div>
  );
}

// "What if you'd followed the macro filter every year instead of the raw signal (always deferring
// to macro on disagreement, since agreement is a no-op)" — plotted alongside the same Top
// quartile/Universe/S&P 500 lines already shown above, plus the head-to-head stats comparison and
// the agree/disagree tally, so the macro filter's actual track record is never left implicit.
function MacroFilteredStrategySection({ macroFilteredStrategy, strategy, tickers }) {
  const cumByYear = new Map(strategy.cumulative.map((p) => [p.year, p]));
  for (const c of macroFilteredStrategy.cumulative) {
    cumByYear.set(c.year, { ...(cumByYear.get(c.year) || { year: c.year }), cumulativeMacroFiltered: c.cumulativeMacroFiltered });
  }
  const mergedCumulative = [...cumByYear.values()].sort((a, b) => a.year - b.year);

  const series = [
    { key: "cumulativeStrategy", label: "Top quartile (signal only)", color: colors.primary },
    { key: "cumulativeBenchmark", label: "Universe", color: colors.textMuted },
    ...(strategy.sp500Available ? [{ key: "cumulativeSp500", label: "S&P 500", color: colors.warning }] : []),
    { key: "cumulativeMacroFiltered", label: "Macro-filtered strategy", color: colors.success },
  ];

  const signalOnlyTotalReturn = strategy.cumulative.length
    ? strategy.cumulative[strategy.cumulative.length - 1].cumulativeStrategy
    : null;
  const total = macroFilteredStrategy.agreementCount + macroFilteredStrategy.disagreementCount;

  const rows = [
    { key: "signal", label: "Top quartile (signal only)", stats: strategy.stats.strategy, totalReturn: signalOnlyTotalReturn },
    { key: "macro", label: "Macro-filtered strategy", stats: macroFilteredStrategy.stats, totalReturn: macroFilteredStrategy.stats.totalReturn },
  ];

  // Money-focused view: join the macro-filtered pick's per-year return with the same S&P 500
  // full-year return already computed for the "Top quartile" table above (strategy.perYear),
  // so "does this beat the market" is answered year by year, not just as one cumulative number.
  const sp500ByYear = new Map(strategy.perYear.map((p) => [p.year, p.sp500Return]));
  const strategyReturnByYear = new Map(strategy.perYear.map((p) => [p.year, p.strategyReturn]));
  const macroPerYearVsSp500 = macroFilteredStrategy.perYear
    .map((m) => {
      const sp500Return = sp500ByYear.get(m.year);
      if (sp500Return === undefined || sp500Return === null) return null;
      return { ...m, sp500Return, diffVsSp500: m.chosenReturn - sp500Return };
    })
    .filter(Boolean);

  const winYears = macroPerYearVsSp500.filter((r) => r.diffVsSp500 > 0);
  const lossYears = macroPerYearVsSp500.filter((r) => r.diffVsSp500 <= 0);
  const avgWin = winYears.length ? winYears.reduce((a, r) => a + r.diffVsSp500, 0) / winYears.length : null;
  const avgLoss = lossYears.length ? lossYears.reduce((a, r) => a + r.diffVsSp500, 0) / lossYears.length : null;
  const winLossRatio = avgWin !== null && avgLoss ? Math.abs(avgWin / avgLoss) : null;

  // The years the macro filter actually changes anything are the disagreement years (on
  // agreement years it's identical to the raw signal pick, a no-op) — so that's where its real
  // money value shows up: what did overriding the signal's own pick actually buy, on average?
  const overrideYears = macroPerYearVsSp500.filter((r) => !r.agree);
  const overrideAvgMacroReturn = overrideYears.length
    ? overrideYears.reduce((a, r) => a + r.chosenReturn, 0) / overrideYears.length
    : null;
  const overrideAvgSignalOnlyReturn = overrideYears.length
    ? overrideYears.reduce((a, r) => a + (strategyReturnByYear.get(r.year) ?? 0), 0) / overrideYears.length
    : null;

  const sp500TotalMultiple =
    strategy.sp500Available && strategy.cumulative.length
      ? 1 + strategy.cumulative[strategy.cumulative.length - 1].cumulativeSp500
      : null;
  const macroTotalMultiple =
    macroFilteredStrategy.stats.totalReturn !== undefined && macroFilteredStrategy.stats.totalReturn !== null
      ? 1 + macroFilteredStrategy.stats.totalReturn
      : null;
  const signalTotalMultiple = signalOnlyTotalReturn !== null ? 1 + signalOnlyTotalReturn : null;
  const firstYear = macroPerYearVsSp500.length ? macroPerYearVsSp500[0].year : null;
  const lastYear = macroPerYearVsSp500.length ? macroPerYearVsSp500[macroPerYearVsSp500.length - 1].year : null;

  // The bootstrap + subperiod split below were run offline (2026-09-24) specifically against the
  // FIXED XLE/XLK rule over its full 2000-2026 history — not something recomputed live for
  // whatever range is currently selected, same convention as the "Regla fija" validation text in
  // AssetSplitCallout above. Only shown for that exact combo so it's never misattributed to a
  // different pair of tickers.
  const tickerSet = new Set(tickers.map((t) => t.toUpperCase()));
  const isFixedXleXlk = tickerSet.size === 2 && tickerSet.has("XLE") && tickerSet.has("XLK");

  return (
    <div style={{ marginTop: 24, paddingTop: 20, borderTop: `1px solid ${colors.border}` }}>
      <h4 style={{ margin: "0 0 8px 0", fontSize: 15 }}>Strategy performance — with macro filter</h4>
      <p style={ui.cardSubtitle}>
        Same setup as "Strategy performance" above, plus a variant that, every year, holds whichever asset "Which
        asset does this regime favor?" picked instead of the raw signal's own pick — always deferring to the macro
        read on disagreement (when they agree, it's the same holding either way, so those years are a no-op for the
        comparison). {tickers.join(" and ")}'s raw signal and the macro filter <strong>agreed</strong> in{" "}
        <strong>{macroFilteredStrategy.agreementCount}</strong> of {total} years and <strong>disagreed</strong> in the
        other <strong>{macroFilteredStrategy.disagreementCount}</strong>.
      </p>

      <LineChart points={mergedCumulative} series={series} />

      <div style={{ ...ui.tableScroll, marginTop: 12 }}>
        <table style={ui.table}>
          <thead>
            <tr>
              <th style={ui.th}>Series</th>
              <th style={ui.th}>Annualized return (CAGR)</th>
              <th style={ui.th}>Annualized volatility</th>
              <th style={ui.th}>Maximum drawdown</th>
              <th style={ui.th}>Total return</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td style={ui.td}>{r.label}</td>
                <td style={{ ...ui.td, color: r.stats.cagr >= 0 ? colors.success : colors.danger, fontWeight: 700 }}>
                  {pct(r.stats.cagr)}
                </td>
                <td style={ui.td}>{pct(r.stats.volatility)}</td>
                <td style={{ ...ui.td, color: colors.danger, fontWeight: 700 }}>{pct(r.stats.maxDrawdown)}</td>
                <td style={{ ...ui.td, color: r.totalReturn >= 0 ? colors.success : colors.danger, fontWeight: 700 }}>
                  {pct(r.totalReturn)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {sp500TotalMultiple !== null && macroTotalMultiple !== null && (
        <div
          style={{
            background: colors.successSoft,
            border: `1px solid ${colors.border}`,
            borderRadius: 10,
            padding: 16,
            marginTop: 16,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: colors.success }}>
            En dinero ({firstYear}–{lastYear})
          </div>
          <p style={{ margin: "6px 0 8px 0", fontSize: 14 }}>
            $1 invertido en {firstYear} termina en <strong>${macroTotalMultiple.toFixed(2)}</strong> con el filtro
            macro, frente a <strong>${signalTotalMultiple !== null ? signalTotalMultiple.toFixed(2) : "—"}</strong>{" "}
            siguiendo solo la señal y <strong>${sp500TotalMultiple.toFixed(2)}</strong> en el S&amp;P 500.
          </p>
          <p style={{ margin: "0 0 8px 0", fontSize: 14 }}>
            Le ganó al S&amp;P 500 en <strong>{winYears.length}</strong> de <strong>{macroPerYearVsSp500.length}</strong> años
            (<strong>{pct(winYears.length / macroPerYearVsSp500.length, 0)}</strong>). En los años que le ganó, lo hizo
            por <strong style={{ color: colors.success }}>{avgWin !== null ? `+${pct(avgWin)}` : "—"}</strong> en promedio;
            en los que perdió, por <strong style={{ color: colors.danger }}>{avgLoss !== null ? pct(avgLoss) : "—"}</strong>.
          </p>
          {winLossRatio !== null && (
            <p style={{ margin: "0 0 8px 0", fontSize: 14 }}>
              Esa asimetría —ganar{" "}
              <strong>{winLossRatio.toFixed(1)}x</strong> más grande de lo que se pierde— es la razón de fondo por la
              que el total compuesto es tan alto pese a ganar "solo" el {pct(winYears.length / macroPerYearVsSp500.length, 0)} de
              los años. Es un patrón fuerte — puesto a prueba más abajo antes de confiar en él a futuro.
            </p>
          )}
          {overrideYears.length > 0 && (
            <p style={{ margin: 0, fontSize: 14 }}>
              El filtro macro solo cambia algo en los <strong>{overrideYears.length}</strong> años en que contradice a
              la señal (cuando coinciden, da igual). Esos años, seguir al filtro macro dio en promedio{" "}
              <strong style={{ color: overrideAvgMacroReturn >= overrideAvgSignalOnlyReturn ? colors.success : colors.danger }}>
                {pct(overrideAvgMacroReturn)}
              </strong>
              , frente a <strong>{pct(overrideAvgSignalOnlyReturn)}</strong> si se hubiera seguido la señal sola — la
              diferencia real que pone sobre la mesa anular la señal.
            </p>
          )}
        </div>
      )}

      {isFixedXleXlk && (
        <div
          style={{
            background: colors.primarySoft,
            border: `1px solid ${colors.border}`,
            borderRadius: 10,
            padding: 16,
            marginTop: 12,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: colors.primary }}>
            ¿Es real esa asimetría? Puesta a prueba (2000–2026)
          </div>
          <p style={{ margin: "6px 0 8px 0", fontSize: 14 }}>
            <strong>Bootstrap</strong> — 20.000 remuestreos con reemplazo de los mismos 27 años (cada escenario vuelve
            a barajar esos 27 resultados reales, permitiendo repetidos). El ratio ganancia/pérdida se mantiene por
            encima de 1x en el <strong>99.8%</strong> de los escenarios (IC 95%: [1.48x, 8.15x], observado 3.1x), y el
            alfa total compuesto contra el S&amp;P 500 sigue siendo positivo en el <strong>99.8%</strong> de los
            casos — no depende de un puñado de años con suerte ni del orden en que ocurrieron.
          </p>
          <p style={{ margin: "0 0 8px 0", fontSize: 14 }}>
            <strong>Split real en dos mitades</strong> (sin mezclar, historia tal cual ocurrió) — dos regímenes de
            mercado casi opuestos: <strong>2000–2012</strong> (ratio 3.6x; filtro macro +183.7% mientras el S&amp;P
            500 perdió -11.3% en esos 13 años) y <strong>2013–2026</strong> (ratio 2.5x; filtro macro +845.4% contra
            un S&amp;P 500 que ya venía fuerte, +432.4%, en esos 14 años). El win rate es casi idéntico en ambas
            mitades (62% y 64%) y la asimetría no se invierte en ninguna — aunque es más débil en la segunda mitad.
          </p>
          <p style={{ ...ui.muted, margin: 0 }}>
            Con solo 27 años reales de datos totales, esto es evidencia de robustez, no una prueba definitiva: cada
            mitad por separado (n=13/14) tiene mucho margen de error propio, y ninguno de estos dos análisis puede
            descartar que las condiciones de mercado futuras sean distintas a las de los últimos 27 años.
          </p>
        </div>
      )}

      {macroPerYearVsSp500.length > 0 && (
        <div style={{ ...ui.tableScroll, marginTop: 16 }}>
          <table style={ui.table}>
            <thead>
              <tr>
                <th style={ui.th}>Year</th>
                <th style={ui.th}>Macro pick</th>
                <th style={ui.th}>vs. signal</th>
                <th style={ui.th}>Macro-filtered return</th>
                <th style={ui.th}>S&amp;P 500</th>
                <th style={ui.th}>Differential</th>
              </tr>
            </thead>
            <tbody>
              {macroPerYearVsSp500.map((r) => (
                <tr key={r.year}>
                  <td style={ui.td}>{r.year}</td>
                  <td style={ui.td}>{r.macroPick}</td>
                  <td style={{ ...ui.td, color: r.agree ? colors.textMuted : colors.warning }}>
                    {r.agree ? "Agrees" : "Overrides"}
                  </td>
                  <td style={ui.td}>{pct(r.chosenReturn)}</td>
                  <td style={ui.td}>{pct(r.sp500Return)}</td>
                  <td style={{ ...ui.td, color: r.diffVsSp500 >= 0 ? colors.success : colors.danger, fontWeight: 700 }}>
                    {r.diffVsSp500 >= 0 ? "+" : ""}
                    {pct(r.diffVsSp500)}
                  </td>
                </tr>
              ))}
              <DiffScoreRow
                perYear={macroPerYearVsSp500}
                diffKey="diffVsSp500"
                cumulative={mergedCumulative}
                strategyCumKey="cumulativeMacroFiltered"
                benchmarkCumKey="cumulativeSp500"
                colSpan={6}
                alphaLabel="macro-filtered strategy minus S&P 500"
              />
            </tbody>
          </table>
        </div>
      )}

      <p style={{ ...ui.muted, marginTop: 8 }}>
        Same historical-backtest caveat as everywhere else here: this compares two rules over the same {total} years
        the macro split itself was found on — encouraging, not proof it will keep working.
      </p>
    </div>
  );
}

// The direct "which asset to hold" answer: the macro split that best predicts who actually led
// each year (not just whether trusting the signal paid off — see the separate edgeSplit block).
function AssetSplitCallout({ assetSplit, yearsUsed }) {
  const meta = MACRO_FEATURE_META[assetSplit.feature] || { label: assetSplit.feature, format: (v) => v };
  const belowFavors = assetSplit.tickerAShareBelow >= 0.5 ? assetSplit.tickerA : assetSplit.tickerB;
  const belowShare = assetSplit.tickerAShareBelow >= 0.5 ? assetSplit.tickerAShareBelow : 1 - assetSplit.tickerAShareBelow;
  const aboveFavors = assetSplit.tickerAShareAbove >= 0.5 ? assetSplit.tickerA : assetSplit.tickerB;
  const aboveShare = assetSplit.tickerAShareAbove >= 0.5 ? assetSplit.tickerAShareAbove : 1 - assetSplit.tickerAShareAbove;

  return (
    <div
      style={{
        background: colors.primarySoft,
        border: `1px solid ${colors.border}`,
        borderRadius: 10,
        padding: 16,
        marginTop: 8,
        marginBottom: 16,
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: colors.primary }}>
        Which asset does this regime favor?
      </div>
      <p style={{ margin: "6px 0 12px 0", fontSize: 14 }}>
        When <strong>{meta.label}</strong> was <strong>below {meta.format(assetSplit.threshold)}</strong>,{" "}
        <strong>{belowFavors}</strong> led in <strong style={{ color: colors.success }}>{pct(belowShare, 0)}</strong> of{" "}
        {assetSplit.nBelow} years. Above that threshold, <strong>{aboveFavors}</strong> led in{" "}
        <strong style={{ color: colors.success }}>{pct(aboveShare, 0)}</strong> of {assetSplit.nAbove} years.
      </p>
      <p style={{ ...ui.muted, margin: 0 }}>
        {assetSplit.fixed
          ? "Regla fija (no se recalcula en cada corrida): validada con ventanas rodantes de 4/6/8/10 años contra el S&P 500 (le ganó en 83-94% de las ventanas, p<0.003). Fijarla evita que el umbral cambie de una corrida a otra por una diferencia mínima de datos."
          : `Best split out of 6 macro features tested, predicting who actually led — not just whether the signal was worth trusting. Same small-sample caveat as everywhere else on this page: ${yearsUsed} yearly observations is a hypothesis to watch, not a proven rule.`}
      </p>
    </div>
  );
}

// This year's read: what the raw Jan-Feb-style signal picked vs. what current macro conditions
// have historically favored — a disagreement between the two is exactly the "the seasonal
// pattern might be a false positive this year" flag the page is meant to surface.
function LiveReadCallout({ liveRead, onAudit, onMacroAudit }) {
  const hasMacroPick = liveRead.macroPick !== undefined && liveRead.macroPick !== null;
  const disagree = hasMacroPick && liveRead.agreesWithSignal === false;
  const hasSince = liveRead.sinceSignalReturnA !== undefined;

  return (
    <div
      style={{
        background: disagree ? colors.warningSoft : colors.successSoft,
        border: `1px solid ${colors.border}`,
        borderRadius: 10,
        padding: 16,
        marginTop: 8,
        marginBottom: 16,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: 0.4,
          color: disagree ? colors.warning : colors.success,
        }}
      >
        This year's read ({liveRead.year})
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 24, marginTop: 8, fontSize: 14 }}>
        <div>
          <div style={{ ...ui.muted, marginBottom: 2 }}>The raw signal picked</div>
          <div style={{ fontWeight: 700, fontSize: 16 }}>{liveRead.signalPick ?? "—"}</div>
          <div style={{ fontSize: 12.5, marginTop: 2 }}>
            <span
              style={auditableCell}
              title="Click to audit this number"
              onClick={() => onAudit({ title: `${liveRead.tickerA} · signal window`, components: [liveRead.signalAuditA] })}
            >
              {liveRead.tickerA} {pct(liveRead.signalReturnA)}
            </span>{" "}
            vs.{" "}
            <span
              style={auditableCell}
              title="Click to audit this number"
              onClick={() => onAudit({ title: `${liveRead.tickerB} · signal window`, components: [liveRead.signalAuditB] })}
            >
              {liveRead.tickerB} {pct(liveRead.signalReturnB)}
            </span>
          </div>
        </div>

        {hasMacroPick && (
          <div>
            <div style={{ ...ui.muted, marginBottom: 2 }}>Current macro conditions favor</div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>{liveRead.macroPick}</div>
            <div style={{ fontSize: 12.5, marginTop: 2 }}>
              <MacroValue
                value={liveRead.macroValue}
                entry={liveRead.macroAudit ? liveRead.macroAudit[liveRead.macroFeature] : null}
                format={MACRO_FEATURE_META[liveRead.macroFeature]?.format || ((v) => v)}
                featureLabel={MACRO_FEATURE_META[liveRead.macroFeature]?.label || liveRead.macroFeature}
                onMacroAudit={onMacroAudit}
              />{" "}
              ({liveRead.macroSide} the historical {MACRO_FEATURE_META[liveRead.macroFeature]?.format(liveRead.macroThreshold)}{" "}
              split) — favored this asset in {pct(liveRead.macroHistoricalWinShare, 0)} of comparable years
            </div>
          </div>
        )}

        {hasSince && (
          <div>
            <div style={{ ...ui.muted, marginBottom: 2 }}>Actual performance since the signal window ended</div>
            <div style={{ fontSize: 12.5 }}>
              <span
                style={auditableCell}
                title="Click to audit this number"
                onClick={() => onAudit({ title: `${liveRead.tickerA} · since signal window`, components: [liveRead.sinceSignalAuditA] })}
              >
                {liveRead.tickerA} {pct(liveRead.sinceSignalReturnA)}
              </span>{" "}
              vs.{" "}
              <span
                style={auditableCell}
                title="Click to audit this number"
                onClick={() => onAudit({ title: `${liveRead.tickerB} · since signal window`, components: [liveRead.sinceSignalAuditB] })}
              >
                {liveRead.tickerB} {pct(liveRead.sinceSignalReturnB)}
              </span>{" "}
              <span style={ui.muted}>(through {liveRead.asOfDate})</span>
            </div>
          </div>
        )}
      </div>

      {disagree && (
        <p style={{ margin: "12px 0 0 0", fontSize: 13, color: colors.warning, fontWeight: 600 }}>
          ⚠ The raw seasonal signal and the macro-based read disagree this year — exactly the situation where blindly
          following January-February performance risks a false positive.
        </p>
      )}
    </div>
  );
}

// Audit drawer for one macro FeatureAudit (seriesId/dates/formula) — the live read's own
// signal/since-signal numbers are ordinary ReturnCalc audits and go through the page's regular
// onAudit/AuditPanel instead (see LiveReadCallout), not this component.
function MacroAuditDrawer({ detail, onClose }) {
  if (!detail) return null;
  const { featureLabel, entry } = detail;
  const isRange = entry.windowStart && entry.windowEnd;
  return (
    <Drawer kicker="Macro data source" title={featureLabel} subtitle={`${entry.seriesName} (FRED: ${entry.seriesId})`} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13.5 }}>
        <Row label="Requested as of" value={entry.requestedAsOf} />
        {isRange ? (
          <>
            <Row label="Interval covered" value={`${entry.windowStart} → ${entry.windowEnd}`} />
            <Row label="Readings averaged" value={entry.observationCount} />
          </>
        ) : (
          <>
            <Row label="Data point used" value={entry.asOfDate} />
            <Row label="Value" value={entry.asOfValue} />
            {entry.priorDate && <Row label="Compared against" value={`${entry.priorDate} (value ${entry.priorValue})`} />}
          </>
        )}
        <div
          style={{
            marginTop: 6,
            paddingTop: 10,
            borderTop: `1px dashed ${colors.border}`,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            fontSize: 12.5,
            color: colors.textMuted,
          }}
        >
          {entry.formula || "No data available for this reading."}
        </div>
      </div>
    </Drawer>
  );
}

function Row({ label, value }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
      <span style={{ color: colors.textMuted }}>{label}</span>
      <span style={{ fontWeight: 600 }}>{value === null || value === undefined ? "—" : value}</span>
    </div>
  );
}

// Explains one year's "Macro pick" cell: which side of the historical split that year's own
// reading falls on, what that side has favored historically, and a link to audit the reading
// itself — the same split shown in AssetSplitCallout, just applied to THIS year specifically.
function MacroPickReasonDrawer({ detail, onClose, onMacroAudit }) {
  if (!detail) return null;
  const meta = MACRO_FEATURE_META[detail.feature] || { label: detail.feature, format: (v) => v };
  const isBelow = detail.value <= detail.threshold;
  const belowFavors = detail.tickerAShareBelow >= 0.5 ? detail.tickerA : detail.tickerB;
  const belowShare = detail.tickerAShareBelow >= 0.5 ? detail.tickerAShareBelow : 1 - detail.tickerAShareBelow;
  const aboveFavors = detail.tickerAShareAbove >= 0.5 ? detail.tickerA : detail.tickerB;
  const aboveShare = detail.tickerAShareAbove >= 0.5 ? detail.tickerAShareAbove : 1 - detail.tickerAShareAbove;
  const thisSideFavors = isBelow ? belowFavors : aboveFavors;
  const thisSideShare = isBelow ? belowShare : aboveShare;
  const thisSideN = isBelow ? detail.nBelow : detail.nAbove;

  return (
    <Drawer kicker="Macro pick reasoning" title={`${detail.pick} · ${detail.year}`} subtitle={`Based on ${meta.label}`} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: 13.5 }}>
        <div
          style={{ ...(detail.entry ? auditableCell : null), fontSize: 15, fontWeight: 700 }}
          title={detail.entry ? "Click to see where this number comes from" : undefined}
          onClick={detail.entry ? () => onMacroAudit({ featureLabel: meta.label, entry: detail.entry }) : undefined}
        >
          This year's reading: {meta.format(detail.value)}
        </div>

        <p style={{ margin: 0 }}>
          {detail.year} falls <strong>{isBelow ? "below" : "above"}</strong> the historical split at{" "}
          <strong>{meta.format(detail.threshold)}</strong>, and in that group <strong>{thisSideFavors}</strong> led in{" "}
          <strong style={{ color: colors.success }}>{pct(thisSideShare, 0)}</strong> of {thisSideN} comparable years —
          that's why <strong>{detail.pick}</strong> is the pick for this year.
        </p>

        <div style={{ paddingTop: 10, borderTop: `1px dashed ${colors.border}`, fontSize: 12.5, color: colors.textMuted }}>
          Full split, for reference: below {meta.format(detail.threshold)} → {belowFavors} led {pct(belowShare, 0)} of{" "}
          {detail.nBelow} years. Above it → {aboveFavors} led {pct(aboveShare, 0)} of {detail.nAbove} years.
        </div>
      </div>
    </Drawer>
  );
}

function SweepResults({ result }) {
  const { meta, cells } = result;
  const byKey = new Map(cells.map((c) => [`${c.startMonth}-${c.lengthMonths}`, c]));
  const lengths = [1, 2, 3];

  const grid = MONTH_NAMES.map((_, monthIdx) =>
    lengths.map((len) => {
      const c = byKey.get(`${monthIdx + 1}-${len}`);
      if (!c) return { label: "—", color: colors.surfaceAlt, title: "window crosses year-end — excluded" };
      return {
        label: c.rho === null ? "n/a" : c.rho.toFixed(2),
        color: c.rho === null ? colors.surfaceAlt : divergingColor(c.rho, 0.5),
        title: `Start ${MONTH_NAMES[monthIdx]}, ${len} month(s): ρ=${c.rho?.toFixed(3) ?? "n/a"} (n=${c.n})`,
      };
    })
  );

  return (
    <div style={ui.card}>
      <h3 style={ui.cardTitle}>Window sweep</h3>
      <p style={ui.cardSubtitle}>
        Spearman correlation (signal vs. rest of year) for 1, 2, and 3-month windows starting in each month. If
        January-February stands out from the rest, the effect is seasonal; if all 2-month windows look
        alike, it's generic momentum.
      </p>
      <div style={ui.tableScroll}>
        <HeatmapGrid
          rowLabels={MONTH_NAMES}
          colLabels={["1 month", "2 months", "3 months"]}
          cells={grid}
          cellWidth={70}
          rowLabelWidth={50}
        />
      </div>
      <p style={{ ...ui.muted, marginTop: 8 }}>
        Source: {meta.source} · {meta.yearFrom}–{meta.yearTo} · {meta.comparison}
      </p>
    </div>
  );
}

function MonteCarloSection({
  mcUniverses,
  setMcUniverses,
  mcLengths,
  setMcLengths,
  mcYearFrom,
  setMcYearFrom,
  mcYearTo,
  setMcYearTo,
  mcMinAssetsPerYear,
  setMcMinAssetsPerYear,
  mcMode,
  setMcMode,
  mcFixedSize,
  setMcFixedSize,
  mcForceJanuary,
  setMcForceJanuary,
  mcMinYearsUsed,
  setMcMinYearsUsed,
  mcRankBy,
  setMcRankBy,
  mcLoading,
  onRun,
  mcResult,
  toggleInSet,
}) {
  const needsSize = mcMode === "FIXED" || mcMode === "ROTATING_SUBSET";
  const defaultMinYears = Math.max(2, Math.round((mcYearTo - mcYearFrom + 1) / 2));
  return (
    <div style={ui.card}>
      <h2 style={ui.cardTitle}>Combinatorial optimization (Monte Carlo)</h2>
      <p style={ui.cardSubtitle}>
        Tests EVERY valid combination of universe (sectors and/or countries — never mixed in the same
        portfolio) × signal window (start month × length), and ranks them by risk-adjusted return (CAGR ÷
        volatility) by default — or by raw CAGR or total return instead, see "Rank combinations by" below — to
        find which one would historically have performed best on that measure. It's an exhaustive sweep — it
        evaluates every possible combination, not a random sample — but we call it "Monte Carlo" as requested.
        Always in USD, so sectors and countries can be compared in one table.
      </p>

      <div style={{ marginBottom: 16 }}>
        <p style={{ fontSize: 13, color: colors.textMuted, margin: "0 0 6px 0", fontWeight: 600 }}>Asset selection mode</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, cursor: "pointer" }}>
            <input
              type="radio"
              name="mcMode"
              checked={mcMode === "ROTATING"}
              onChange={() => setMcMode("ROTATING")}
              style={{ marginTop: 2 }}
            />
            <span>
              <strong>Rotate top quartile across the whole universe</strong>
              <br />
              <span style={{ color: colors.textMuted }}>
                Re-picks the top quartile by signal from the WHOLE universe, every year (same as the main
                strategy above).
              </span>
            </span>
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, cursor: "pointer" }}>
            <input
              type="radio"
              name="mcMode"
              checked={mcMode === "ROTATING_SUBSET"}
              onChange={() => setMcMode("ROTATING_SUBSET")}
              style={{ marginTop: 2 }}
            />
            <span>
              <strong>Rotate the winner within a chosen group</strong>
              <br />
              <span style={{ color: colors.textMuted }}>
                Pick how many assets (2, 3, 4…) and it searches, among EVERY possible combination of that size, for
                the group where "always keep whichever came out ahead on signal" performed best. With 2 assets this
                reproduces "always the winner between these two," tested for every possible pair — not one picked
                by hand.
              </span>
            </span>
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, cursor: "pointer" }}>
            <input
              type="radio"
              name="mcMode"
              checked={mcMode === "FIXED"}
              onChange={() => setMcMode("FIXED")}
              style={{ marginTop: 2 }}
            />
            <span>
              <strong>Fixed portfolio (no rotation)</strong>
              <br />
              <span style={{ color: colors.textMuted }}>
                Pick how many assets and it searches for the combination that performed best holding the SAME
                assets for the whole period (no rotation — it keeps them together).
              </span>
            </span>
          </label>
        </div>
      </div>

      <div style={{ marginBottom: 16 }}>
        <p style={{ fontSize: 13, color: colors.textMuted, margin: "0 0 6px 0", fontWeight: 600 }}>Rank combinations by</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {RANK_BY_OPTIONS.map((o) => (
            <button key={o.key} style={ui.button(mcRankBy === o.key ? "primary" : "secondary")} onClick={() => setMcRankBy(o.key)}>
              {o.label}
            </button>
          ))}
        </div>
        <p style={{ ...ui.muted, marginTop: 6 }}>
          This changes which candidate actually wins each window in "Rotate the winner within a chosen group" and
          "Fixed portfolio" mode — not just how the results table below is sorted. A different combination can be the
          real winner for the SAME window under a different ranking.
        </p>
      </div>

      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        <div style={{ minWidth: 160 }}>
          <p style={{ fontSize: 13, color: colors.textMuted, margin: "0 0 6px 0", fontWeight: 600 }}>Universe to explore</p>
          {["SECTOR", "COUNTRY"].map((u) => (
            <label key={u} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, cursor: "pointer", marginBottom: 4 }}>
              <input type="checkbox" checked={mcUniverses.has(u)} onChange={() => toggleInSet(mcUniverses, setMcUniverses, u)} />
              {UNIVERSE_LABELS[u]}
            </label>
          ))}
        </div>

        <div style={{ minWidth: 160 }}>
          <p style={{ fontSize: 13, color: colors.textMuted, margin: "0 0 6px 0", fontWeight: 600 }}>Window length to test</p>
          {[1, 2, 3].map((len) => (
            <label key={len} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, cursor: "pointer", marginBottom: 4 }}>
              <input type="checkbox" checked={mcLengths.has(len)} onChange={() => toggleInSet(mcLengths, setMcLengths, len)} />
              {len} month{len > 1 ? "s" : ""}
            </label>
          ))}
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, cursor: "pointer", marginTop: 8 }}>
            <input type="checkbox" checked={mcForceJanuary} onChange={(e) => setMcForceJanuary(e.target.checked)} />
            Force January start
          </label>
        </div>

        <div style={ui.row}>
          <label style={ui.label}>
            Years from
            <input style={ui.input} type="number" value={mcYearFrom} onChange={(e) => setMcYearFrom(Number(e.target.value))} />
          </label>
          <label style={ui.label}>
            Years to
            <input style={ui.input} type="number" value={mcYearTo} onChange={(e) => setMcYearTo(Number(e.target.value))} />
          </label>
          {needsSize ? (
            <label style={ui.label}>
              No. of assets
              <input
                style={ui.input}
                type="number"
                min={2}
                value={mcFixedSize}
                onChange={(e) => setMcFixedSize(Number(e.target.value))}
              />
            </label>
          ) : (
            <label style={ui.label}>
              Min assets/year
              <input
                style={ui.input}
                type="number"
                min={2}
                value={mcMinAssetsPerYear}
                onChange={(e) => setMcMinAssetsPerYear(Number(e.target.value))}
              />
            </label>
          )}
          <label style={ui.label}>
            Min years used
            <input
              style={ui.input}
              type="number"
              min={2}
              placeholder={String(defaultMinYears)}
              value={mcMinYearsUsed ?? ""}
              onChange={(e) => setMcMinYearsUsed(e.target.value === "" ? null : Number(e.target.value))}
            />
          </label>
        </div>
      </div>
      <p style={{ ...ui.muted, marginTop: 10 }}>
        "Min years used" discards combinations built on too few years (e.g. an asset that only started
        trading recently) — without that floor, a result with only 5-7 years of history can look better than one
        with 20 years just by small-sample luck. Empty = half of the requested year range ({defaultMinYears}
        {" "}in this case).
      </p>

      <div style={{ marginTop: 16 }}>
        <button style={ui.button("primary")} onClick={onRun} disabled={mcLoading}>
          {mcLoading ? "Running combinations…" : "Run Monte Carlo"}
        </button>
      </div>

      {mcResult && <MonteCarloResults result={mcResult} />}
    </div>
  );
}

// picksByYear is identical every year in FIXED mode (same basket held throughout) but rotates
// year to year in ROTATING mode — these two helpers read that without the caller needing to
// know which mode produced the data.
function fixedTickersOf(picksByYear) {
  const years = Object.keys(picksByYear || {});
  return years.length ? picksByYear[years[0]] : null;
}

const MODE_LABELS = {
  ROTATING: "Whole-universe rotation",
  ROTATING_SUBSET: `Rotation within a chosen group`,
  FIXED: `Fixed portfolio`,
};

// What "best" means is subjective: someone who cares about raw return over smoothness wants the
// highest CAGR or total return, even if it came with more volatility, instead of the risk-
// adjusted winner. This has to be a real backend search parameter (see mcRankBy in
// MonteCarloSection), not a client-side re-sort — a different combination can genuinely win the
// SAME window under a different criterion.
const RANK_BY_OPTIONS = [
  { key: "SCORE", label: "Risk-adjusted (CAGR ÷ Vol)" },
  { key: "CAGR", label: "CAGR" },
  { key: "TOTAL_RETURN", label: "Total return" },
];

function MonteCarloResults({ result }) {
  const { meta, combos, best } = result;
  const [picksDetail, setPicksDetail] = useState(null);
  const isFixed = meta.mode === "FIXED";

  if (!combos || combos.length === 0) {
    return (
      <p style={{ ...ui.muted, marginTop: 16 }}>
        No combination had enough data with this configuration
        {meta.discardedForShortSample > 0 &&
          ` (${meta.discardedForShortSample} were discarded for having fewer than ${meta.minYearsUsed} years of history — lower "Min years used" if you want to see them)`}
        .
      </p>
    );
  }

  const rankLabel = (RANK_BY_OPTIONS.find((o) => o.key === meta.rankBy) || RANK_BY_OPTIONS[0]).label;

  return (
    <div style={{ marginTop: 20 }}>
      <p style={ui.muted}>
        {meta.combosEvaluated} combinations evaluated · {meta.source} · {meta.yearFrom}–{meta.yearTo} ·{" "}
        {MODE_LABELS[meta.mode] || meta.mode}
        {(meta.mode === "FIXED" || meta.mode === "ROTATING_SUBSET") && ` of ${meta.fixedSize} assets`}
        {meta.startMonths && meta.startMonths.length === 1 && meta.startMonths[0] === 1 && " · signal forced to January"}
        · ranked by {rankLabel}
        {meta.discardedForShortSample > 0 &&
          ` · ${meta.discardedForShortSample} combination(s) with fewer than ${meta.minYearsUsed} years discarded`}
      </p>

      {best && (
        <div
          onClick={() => setPicksDetail(best)}
          title={isFixed ? "Click to confirm the chosen assets" : "Click to see which assets this combination picked each year"}
          style={{
            background: colors.primarySoft,
            border: `1px solid ${colors.border}`,
            borderRadius: 10,
            padding: 16,
            marginTop: 8,
            marginBottom: 16,
            cursor: "pointer",
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: colors.primary }}>
            Optimal combination (highest {rankLabel})
          </div>
          <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>
            {UNIVERSE_LABELS[best.universe]} · Signal {windowLabel(best.startMonth, best.lengthMonths)}
          </div>
          {isFixed && (
            <div style={{ marginTop: 8, fontSize: 14 }}>
              Assets: <strong>{(fixedTickersOf(best.picksByYear) || []).join(", ")}</strong>{" "}
              <span style={{ color: colors.textMuted, fontWeight: 400 }}>(the same ones for the whole period, no rotation)</span>
            </div>
          )}
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginTop: 10, fontSize: 13.5 }}>
            <span>
              CAGR: <strong style={{ color: best.cagr >= 0 ? colors.success : colors.danger }}>{pct(best.cagr)}</strong>
            </span>
            <span>
              Total return: <strong>{pct(best.totalReturn)}</strong>
            </span>
            <span>
              Volatility: <strong>{pct(best.volatility)}</strong>
            </span>
            <span>
              Max drawdown: <strong style={{ color: colors.danger }}>{pct(best.maxDrawdown)}</strong>
            </span>
            <span>
              Years used: <strong>{best.yearsUsed}</strong>
            </span>
          </div>
          <div style={{ marginTop: 10, fontSize: 12, color: colors.primary, fontWeight: 600 }}>
            {isFixed ? "Click to confirm the chosen assets" : "Click to see which assets it picked each year"}
          </div>
        </div>
      )}

      <ComboScatter combos={combos} best={best} />

      <div style={{ ...ui.tableScroll, marginTop: 16 }}>
        <table style={ui.table}>
          <thead>
            <tr>
              <th style={ui.th}>Universe</th>
              <th style={ui.th}>Signal window</th>
              <th style={ui.th}>CAGR</th>
              <th style={ui.th}>Total return</th>
              <th style={ui.th}>Volatility</th>
              <th style={ui.th}>Max Drawdown</th>
              <th style={ui.th}>Score (CAGR/Vol)</th>
              <th style={ui.th}>Years</th>
              <th style={ui.th}>Assets</th>
            </tr>
          </thead>
          <tbody>
            {combos.map((c, i) => (
              <tr key={`${c.universe}-${c.startMonth}-${c.lengthMonths}`} style={i === 0 ? { background: colors.primarySoft } : undefined}>
                <td style={ui.td}>
                  {i === 0 ? "* " : ""}
                  {UNIVERSE_LABELS[c.universe]}
                </td>
                <td style={ui.td}>{windowLabel(c.startMonth, c.lengthMonths)}</td>
                <td style={{ ...ui.td, color: c.cagr >= 0 ? colors.success : colors.danger, fontWeight: 700 }}>{pct(c.cagr)}</td>
                <td style={ui.td}>{pct(c.totalReturn)}</td>
                <td style={ui.td}>{pct(c.volatility)}</td>
                <td style={{ ...ui.td, color: colors.danger }}>{pct(c.maxDrawdown)}</td>
                <td style={ui.td}>{c.score.toFixed(2)}</td>
                <td style={ui.td}>{c.yearsUsed}</td>
                <td style={{ ...ui.td, whiteSpace: isFixed ? "normal" : "nowrap" }}>
                  {isFixed ? (
                    <span
                      style={{ ...auditableCell, color: colors.text }}
                      title="Click to confirm the chosen assets"
                      onClick={() => setPicksDetail(c)}
                    >
                      {(fixedTickersOf(c.picksByYear) || []).join(", ")}
                    </span>
                  ) : (
                    <button
                      style={{ ...ui.button("ghost"), height: "auto", padding: "2px 8px", fontSize: 12.5, color: colors.primary }}
                      onClick={() => setPicksDetail(c)}
                    >
                      View ▸
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p style={{ ...ui.muted, marginTop: 8 }}>
        Score = CAGR ÷ annualized volatility (similar to a Sharpe ratio, but without subtracting the risk-free
        rate) — one way to RANK combinations against each other, not a standalone standard financial metric. It isn't
        always the same ranking as raw return: a combo with a lower score can still have a higher CAGR or total
        return if it came with more volatility — use "Rank combinations by" above to search for the best one by that
        criterion instead. This is a historical backtest either way: it doesn't guarantee the same combination will
        repeat in the future.
      </p>

      {picksDetail && <ComboPicksDrawer detail={picksDetail} onClose={() => setPicksDetail(null)} />}
    </div>
  );
}

function ComboPicksDrawer({ detail, onClose }) {
  const years = Object.keys(detail.picksByYear || {})
    .map(Number)
    .sort((a, b) => a - b);

  // FIXED mode holds the exact same basket every year — detect that and show one consolidated
  // line instead of repeating an identical row per year, which would just look redundant.
  const signature = (list) => [...(list || [])].sort().join(",");
  const isConstant = years.length > 0 && years.every((y) => signature(detail.picksByYear[y]) === signature(detail.picksByYear[years[0]]));

  return (
    <Drawer
      kicker="Portfolio composition"
      title={`${UNIVERSE_LABELS[detail.universe]} · Signal ${windowLabel(detail.startMonth, detail.lengthMonths)}`}
      subtitle={
        isConstant
          ? "Fixed portfolio: the same assets every year, bought at the start of the 'holdings from' month and held through December 31."
          : "Top-quartile-by-signal assets this combination picked each year — bought at the start of the 'holdings from' month, held through December 31."
      }
      onClose={onClose}
    >
      {years.length === 0 ? (
        <p style={ui.muted}>No composition data for this combination.</p>
      ) : isConstant ? (
        <div
          style={{
            border: `1px solid ${colors.border}`,
            borderRadius: 10,
            padding: 14,
            background: colors.surfaceAlt,
            fontSize: 14,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: colors.textMuted, marginBottom: 6 }}>
            All years ({years[0]}–{years[years.length - 1]})
          </div>
          <strong>{(detail.picksByYear[years[0]] || []).join(", ")}</strong>
        </div>
      ) : (
        <div style={ui.tableScroll}>
          <table style={ui.table}>
            <thead>
              <tr>
                <th style={ui.th}>Year</th>
                <th style={ui.th}>Assets picked</th>
              </tr>
            </thead>
            <tbody>
              {years.map((year) => (
                <tr key={year}>
                  <td style={ui.td}>{year}</td>
                  <td style={{ ...ui.td, whiteSpace: "normal" }}>{(detail.picksByYear[year] || []).join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Drawer>
  );
}

function ComboScatter({ combos, best }) {
  const width = 640;
  const height = 320;
  const padding = { top: 16, right: 16, bottom: 40, left: 56 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const xs = combos.map((c) => c.volatility);
  const ys = combos.map((c) => c.cagr);
  const xMin = 0;
  const xMax = Math.max(...xs) * 1.08 || 1;
  const yMin = Math.min(0, ...ys);
  const yMax = Math.max(...ys) * 1.08 || 0.01;
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;

  const sx = (v) => padding.left + ((v - xMin) / xRange) * plotWidth;
  const sy = (v) => padding.top + plotHeight - ((v - yMin) / yRange) * plotHeight;

  const zeroY = yMin <= 0 && yMax >= 0 ? sy(0) : null;

  return (
    <div style={ui.tableScroll}>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: "auto", minWidth: 480 }}>
        {zeroY !== null && (
          <line x1={padding.left} y1={zeroY} x2={width - padding.right} y2={zeroY} stroke={colors.border} strokeDasharray="3 3" />
        )}

        {combos.map((c, i) => {
          const isBest =
            best && c.universe === best.universe && c.startMonth === best.startMonth && c.lengthMonths === best.lengthMonths;
          const color = c.universe === "COUNTRY" ? "#a78bfa" : colors.primary;
          return (
            <circle
              key={i}
              cx={sx(c.volatility)}
              cy={sy(c.cagr)}
              r={isBest ? 7 : 3.5}
              fill={isBest ? colors.success : color}
              opacity={isBest ? 1 : 0.55}
              stroke={isBest ? "#fff" : "none"}
              strokeWidth={isBest ? 2 : 0}
            >
              <title>
                {UNIVERSE_LABELS[c.universe]} · {windowLabel(c.startMonth, c.lengthMonths)}: CAGR {(c.cagr * 100).toFixed(1)}%, vol{" "}
                {(c.volatility * 100).toFixed(1)}%{isBest ? " — OPTIMAL" : ""}
              </title>
            </circle>
          );
        })}

        <line x1={padding.left} y1={height - padding.bottom} x2={width - padding.right} y2={height - padding.bottom} stroke={colors.text} />
        <line x1={padding.left} y1={padding.top} x2={padding.left} y2={height - padding.bottom} stroke={colors.text} />
        <text x={width / 2} y={height - 6} fontSize="11" fill={colors.textMuted} textAnchor="middle">
          Annualized volatility
        </text>
        <text x={14} y={height / 2} fontSize="11" fill={colors.textMuted} textAnchor="middle" transform={`rotate(-90, 14, ${height / 2})`}>
          Annualized CAGR
        </text>

        <g transform={`translate(${width - 150}, ${padding.top})`}>
          <circle cx={6} cy={4} r={4} fill={colors.primary} />
          <text x={16} y={8} fontSize="11" fill={colors.textMuted}>
            Sectors
          </text>
          <circle cx={6} cy={20} r={4} fill="#a78bfa" />
          <text x={16} y={24} fontSize="11" fill={colors.textMuted}>
            Countries
          </text>
          <circle cx={6} cy={36} r={5} fill={colors.success} stroke="#fff" strokeWidth={1.5} />
          <text x={16} y={40} fontSize="11" fill={colors.textMuted}>
            Optimal
          </text>
        </g>
      </svg>
    </div>
  );
}
