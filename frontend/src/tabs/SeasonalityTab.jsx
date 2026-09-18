import { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { ui, colors } from "../theme.js";
import HeatmapGrid, { divergingColor } from "../HeatmapGrid.jsx";
import ScatterChart from "../ScatterChart.jsx";
import LineChart from "../LineChart.jsx";
import AuditPanel, { Drawer } from "../AuditPanel.jsx";

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
const DEFAULT_YEAR_FROM = Math.max(2001, CURRENT_YEAR - 20);
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

      {testResult && <TestResults result={testResult} onAudit={setAudit} />}
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
        mcLoading={mcLoading}
        onRun={runMonteCarlo}
        mcResult={mcResult}
        toggleInSet={toggleInSet}
      />

      <AuditPanel audit={audit} onClose={() => setAudit(null)} />
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
function DiffScoreRow({ perYear, diffKey, cumulative, strategyCumKey, benchmarkCumKey, colSpan }) {
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
              (cumulative return over the whole period: top quartile minus benchmark)
            </span>
          </div>
        )}
      </td>
    </tr>
  );
}

function TestResults({ result, onAudit }) {
  const { meta, panel, coverage, correlationVsRest, correlationVsFullYear, persistenceVsRest, persistenceVsFullYear, strategy } = result;
  const tickers = meta.tickers;

  const restPoints = panel
    .filter((p) => p.signalReturn !== null && p.restReturn !== null && p.covered)
    .map((p) => ({ x: p.signalReturn, y: p.restReturn, label: `${p.ticker} ${p.year}` }));
  const fullYearPoints = panel
    .filter((p) => p.signalReturn !== null && p.fullYearReturn !== null && p.covered)
    .map((p) => ({ x: p.signalReturn, y: p.fullYearReturn, label: `${p.ticker} ${p.year}` }));

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
        </div>
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
          500 (SPY) and MSCI World (URTH) are added as a fixed benchmark using their own FULL calendar-year return
          (buy-and-hold all year, not just the strategy's holding period) — always in USD, regardless of the test's
          currency.
          {!strategy.sp500Available || !strategy.msciWorldAvailable ? (
            <>
              {" "}
              {!strategy.sp500Available && "S&P 500 is not shown"}
              {!strategy.sp500Available && !strategy.msciWorldAvailable && " and "}
              {!strategy.msciWorldAvailable && "MSCI World (URTH, trading since 2012) is not shown"} because it doesn't
              have data for the whole requested year range.
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
    </div>
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
        volatility) to find which one would historically have delivered the most return for the least volatility. It's
        an exhaustive sweep — it evaluates every possible combination, not a random sample — but we call it "Monte
        Carlo" as requested. Always in USD, so sectors and countries can be compared in one table.
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

  return (
    <div style={{ marginTop: 20 }}>
      <p style={ui.muted}>
        {meta.combosEvaluated} combinations evaluated · {meta.source} · {meta.yearFrom}–{meta.yearTo} ·{" "}
        {MODE_LABELS[meta.mode] || meta.mode}
        {(meta.mode === "FIXED" || meta.mode === "ROTATING_SUBSET") && ` of ${meta.fixedSize} assets`}
        {meta.startMonths && meta.startMonths.length === 1 && meta.startMonths[0] === 1 && " · signal forced to January"}
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
            Optimal combination (highest risk-adjusted return)
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
        rate) — used only to RANK combinations against each other, not a standalone standard financial metric. This
        is a historical backtest: it doesn't guarantee the same combination will repeat in the future.
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
