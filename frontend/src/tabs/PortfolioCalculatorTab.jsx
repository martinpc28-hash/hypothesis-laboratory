import { useMemo, useState } from "react";
import { ui, colors } from "../theme.js";
import LineChart from "../LineChart.jsx";

function pct(v, digits = 1) {
  return v === null || v === undefined || Number.isNaN(v) ? "—" : `${(v * 100).toFixed(digits)}%`;
}

// Every strategy tab already exposes a year-end CUMULATIVE return series (the same shape used for
// their own charts). This derives each year's own isolated return from two consecutive cumulative
// points — the same technique VixTimingTab uses for its "en dinero" per-year table — so the
// calculator can blend strategies without needing a new backend endpoint: it just re-reads
// whatever the other three tabs already computed.
function yearlyReturnMap(cumulative, key) {
  const map = new Map();
  let prev = 0;
  for (const c of cumulative || []) {
    const cur = c[key];
    if (cur === undefined || cur === null) continue;
    map.set(c.year, (1 + cur) / (1 + prev) - 1);
    prev = cur;
  }
  return map;
}

// Stats from a plain array of ANNUAL returns (not daily) — CAGR/vol/drawdown computed directly
// from the yearly series, not annualized with a √252 factor like every other tab in this project
// (those work from daily returns; this only has what the source tabs expose, one point per year).
// This is a real, disclosed limitation: a "max drawdown" computed only from year-END values can
// miss a sharp intra-year drop that recovered by December, and volatility of 27 yearly numbers is
// a much noisier estimate than volatility of ~6,700 daily ones.
function statsFromYearlyReturns(returnsInOrder) {
  let wealth = 1, peak = 1, maxDD = 0;
  for (const r of returnsInOrder) {
    wealth *= 1 + r;
    peak = Math.max(peak, wealth);
    maxDD = Math.min(maxDD, (wealth - peak) / peak);
  }
  const n = returnsInOrder.length;
  const totalReturn = wealth - 1;
  const cagr = n > 0 ? Math.pow(wealth, 1 / n) - 1 : 0;
  const mean = n ? returnsInOrder.reduce((a, b) => a + b, 0) / n : 0;
  const variance = n > 1 ? returnsInOrder.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / (n - 1) : 0;
  const vol = Math.sqrt(variance);
  return { totalReturn, cagr, volatility: vol, maxDrawdown: maxDD };
}

const LEG_COLORS = [colors.primary, colors.warning, colors.success, colors.danger];

export default function PortfolioCalculatorTab({
  seasonalityTestResult,
  seasonalityMacroResult,
  vixTimingResult,
  creditRotationResult,
}) {
  const seasonalityAvailable = !!seasonalityTestResult?.strategy?.cumulative;
  const seasonalityMacroAvailable = !!seasonalityMacroResult?.macroFilteredStrategy?.cumulative;
  const vixAvailable = !!vixTimingResult?.cumulative;
  const creditAvailable = !!creditRotationResult?.cumulative;

  const [seasonalityIncluded, setSeasonalityIncluded] = useState(true);
  const [seasonalityWeight, setSeasonalityWeight] = useState(34);
  const [seasonalityVariant, setSeasonalityVariant] = useState("MACRO");

  const [vixIncluded, setVixIncluded] = useState(true);
  const [vixWeight, setVixWeight] = useState(33);

  const [creditIncluded, setCreditIncluded] = useState(true);
  const [creditWeight, setCreditWeight] = useState(33);
  const [creditCurrency, setCreditCurrency] = useState("USD");

  const [yearFrom, setYearFrom] = useState("");
  const [yearTo, setYearTo] = useState("");
  const [error, setError] = useState(null);
  const [calc, setCalc] = useState(null);

  const totalEnteredWeight =
    (seasonalityIncluded ? Number(seasonalityWeight) || 0 : 0) +
    (vixIncluded ? Number(vixWeight) || 0 : 0) +
    (creditIncluded ? Number(creditWeight) || 0 : 0);

  function buildLegs() {
    const legs = [];
    if (seasonalityIncluded && seasonalityAvailable) {
      const useMacro = seasonalityVariant === "MACRO" && seasonalityMacroAvailable;
      const cumulative = useMacro
        ? seasonalityMacroResult.macroFilteredStrategy.cumulative
        : seasonalityTestResult.strategy.cumulative;
      const key = useMacro ? "cumulativeMacroFiltered" : "cumulativeStrategy";
      const tickers = seasonalityTestResult?.meta?.tickers?.join("+") || "Seasonality";
      // The macro/top-quartile variant's OWN tab already computed real daily-return-based
      // cagr/volatility/maxDrawdown/totalReturn — reused as-is below when this leg isn't clipped
      // to a narrower common window, instead of re-deriving a noisier approximation from just its
      // yearly returns (same number the annual approximation would converge to for CAGR/totalReturn
      // anyway, but volatility/maxDrawdown are genuinely more accurate here).
      const realStats = useMacro ? seasonalityMacroResult.macroFilteredStrategy.stats : seasonalityTestResult.strategy.stats.strategy;
      legs.push({
        name: `Seasonality ${tickers} (${useMacro ? "con filtro macro" : "top quartile"})`,
        weight: Number(seasonalityWeight) || 0,
        returns: yearlyReturnMap(cumulative, key),
        realStats,
      });
    }
    if (vixIncluded && vixAvailable) {
      legs.push({
        name: "VIX Timing",
        weight: Number(vixWeight) || 0,
        returns: yearlyReturnMap(vixTimingResult.cumulative, "cumulativeStrategy"),
        realStats: vixTimingResult.stats?.strategy,
      });
    }
    if (creditIncluded && creditAvailable) {
      const key = creditCurrency === "EUR" ? "cumulativeStrategyEur" : "cumulativeStrategyUsd";
      legs.push({
        name: `Credit Rotation (${creditCurrency})`,
        weight: Number(creditWeight) || 0,
        returns: yearlyReturnMap(creditRotationResult.cumulative, key),
        realStats: creditRotationResult.stats?.[creditCurrency.toLowerCase()]?.strategy,
      });
    }
    return legs;
  }

  function calculate() {
    setError(null);
    setCalc(null);
    const legs = buildLegs();
    if (legs.length === 0) {
      setError("Elegí al menos una estrategia (y corré esa pestaña primero si todavía no tiene resultado).");
      return;
    }
    const totalWeight = legs.reduce((a, l) => a + l.weight, 0);
    if (totalWeight <= 0) {
      setError("Los pesos de las estrategias incluidas suman 0% — poné al menos un peso mayor a 0.");
      return;
    }
    const normalized = legs.map((l) => ({ ...l, normWeight: l.weight / totalWeight }));

    let years = null;
    for (const l of normalized) {
      const legYears = new Set(l.returns.keys());
      years = years === null ? legYears : new Set([...years].filter((y) => legYears.has(y)));
    }
    let sortedYears = [...years].sort((a, b) => a - b);
    if (yearFrom !== "") sortedYears = sortedYears.filter((y) => y >= Number(yearFrom));
    if (yearTo !== "") sortedYears = sortedYears.filter((y) => y <= Number(yearTo));
    if (sortedYears.length === 0) {
      setError("No hay años en común entre las estrategias elegidas (y el rango de años) — probá un rango más amplio.");
      return;
    }

    const legWealths = normalized.map(() => 1);
    const blendedReturns = [];
    const points = [];
    for (const y of sortedYears) {
      let blended = 0;
      normalized.forEach((l) => {
        blended += l.normWeight * (l.returns.get(y) ?? 0);
      });
      blendedReturns.push(blended);
      const point = { year: y };
      normalized.forEach((l, i) => {
        legWealths[i] *= 1 + (l.returns.get(y) ?? 0);
        point[`cumulativeLeg${i}`] = legWealths[i] - 1;
      });
      points.push(point);
    }
    // Portfolio cumulative computed as its own compounded series (not derived from the legs'
    // wealths above, though they'd match) — kept as an explicit pass for clarity.
    let portfolioWealth = 1;
    blendedReturns.forEach((r, i) => {
      portfolioWealth *= 1 + r;
      points[i].cumulativePortfolio = portfolioWealth - 1;
    });

    const portfolioStats = statsFromYearlyReturns(blendedReturns);
    const legStats = normalized.map((l) => {
      const legReturns = sortedYears.map((y) => l.returns.get(y) ?? 0);
      // Only trust the leg's own real (daily-based) stats when the combined window doesn't clip
      // it down further than what it was originally computed over — a real stat for a DIFFERENT
      // (wider) period than what's actually being blended here would be misleading.
      const legYears = [...l.returns.keys()];
      const notClipped =
        l.realStats && legYears.length === sortedYears.length && Math.min(...legYears) === sortedYears[0] &&
        Math.max(...legYears) === sortedYears[sortedYears.length - 1];
      return {
        name: l.name,
        weight: l.normWeight,
        stats: notClipped ? l.realStats : statsFromYearlyReturns(legReturns),
        isReal: !!notClipped,
      };
    });

    setCalc({ years: sortedYears, points, portfolioStats, legStats, legNames: normalized.map((l) => l.name) });
  }

  const series = useMemo(() => {
    if (!calc) return [];
    const s = [{ key: "cumulativePortfolio", label: "Cartera combinada", color: colors.text }];
    calc.legNames.forEach((name, i) => {
      s.push({ key: `cumulativeLeg${i}`, label: name, color: LEG_COLORS[i % LEG_COLORS.length] });
    });
    return s;
  }, [calc]);

  return (
    <div>
      <div style={ui.card}>
        <h2 style={ui.cardTitle}>Calculadora de cartera combinada</h2>
        <p style={ui.cardSubtitle}>
          Combina los resultados YA corridos en Seasonality, VIX Timing y Credit Rotation con el % que le asignes a
          cada uno, y calcula qué rentabilidad hubiera dado la mezcla en el período en común. Corré esas 3 pestañas
          primero — esta calculadora no vuelve a pedir datos, solo mezcla lo que ya calculaste ahí. El rebalanceo es
          anual (a fin de cada año se vuelve a los % originales), y la volatilidad/drawdown de la mezcla se calculan
          sobre retornos ANUALES (no diarios, como en las otras pestañas) — con menos puntos, son estimaciones más
          ruidosas, y un drawdown solo de fin de año puede no capturar una caída fuerte que se recuperó antes de
          diciembre.
        </p>

        <div style={ui.tableScroll}>
          <table style={ui.table}>
            <thead>
              <tr>
                <th style={ui.th}></th>
                <th style={ui.th}>Estrategia</th>
                <th style={ui.th}>Variante</th>
                <th style={ui.th}>Peso (%)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={ui.td}>
                  <input
                    type="checkbox"
                    checked={seasonalityIncluded}
                    disabled={!seasonalityAvailable}
                    onChange={(e) => setSeasonalityIncluded(e.target.checked)}
                  />
                </td>
                <td style={ui.td}>
                  Seasonality
                  {!seasonalityAvailable && <div style={ui.muted}>Corré Seasonality primero</div>}
                </td>
                <td style={ui.td}>
                  {seasonalityAvailable && (
                    <select
                      style={ui.input}
                      value={seasonalityVariant}
                      onChange={(e) => setSeasonalityVariant(e.target.value)}
                      disabled={!seasonalityIncluded}
                    >
                      {seasonalityMacroAvailable && <option value="MACRO">Con filtro macro</option>}
                      <option value="TOP_QUARTILE">Top quartile (solo señal)</option>
                    </select>
                  )}
                </td>
                <td style={ui.td}>
                  <input
                    style={{ ...ui.input, width: 80 }}
                    type="number"
                    value={seasonalityWeight}
                    disabled={!seasonalityIncluded || !seasonalityAvailable}
                    onChange={(e) => setSeasonalityWeight(e.target.value)}
                  />
                </td>
              </tr>
              <tr>
                <td style={ui.td}>
                  <input
                    type="checkbox"
                    checked={vixIncluded}
                    disabled={!vixAvailable}
                    onChange={(e) => setVixIncluded(e.target.checked)}
                  />
                </td>
                <td style={ui.td}>
                  VIX Timing
                  {!vixAvailable && <div style={ui.muted}>Corré VIX Timing primero</div>}
                </td>
                <td style={ui.td}>—</td>
                <td style={ui.td}>
                  <input
                    style={{ ...ui.input, width: 80 }}
                    type="number"
                    value={vixWeight}
                    disabled={!vixIncluded || !vixAvailable}
                    onChange={(e) => setVixWeight(e.target.value)}
                  />
                </td>
              </tr>
              <tr>
                <td style={ui.td}>
                  <input
                    type="checkbox"
                    checked={creditIncluded}
                    disabled={!creditAvailable}
                    onChange={(e) => setCreditIncluded(e.target.checked)}
                  />
                </td>
                <td style={ui.td}>
                  Credit Rotation
                  {!creditAvailable && <div style={ui.muted}>Corré Credit Rotation primero</div>}
                </td>
                <td style={ui.td}>
                  {creditAvailable && (
                    <select
                      style={ui.input}
                      value={creditCurrency}
                      onChange={(e) => setCreditCurrency(e.target.value)}
                      disabled={!creditIncluded}
                    >
                      <option value="USD">USD</option>
                      <option value="EUR">EUR</option>
                    </select>
                  )}
                </td>
                <td style={ui.td}>
                  <input
                    style={{ ...ui.input, width: 80 }}
                    type="number"
                    value={creditWeight}
                    disabled={!creditIncluded || !creditAvailable}
                    onChange={(e) => setCreditWeight(e.target.value)}
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p style={{ ...ui.muted, marginTop: 8 }}>
          Suma de pesos ingresados: {totalEnteredWeight}% — no hace falta que sumen 100, se normalizan
          automáticamente entre las estrategias marcadas.
        </p>

        <div style={{ ...ui.form, marginTop: 12 }}>
          <label style={ui.label}>
            Año desde (opcional)
            <input style={ui.input} type="number" value={yearFrom} onChange={(e) => setYearFrom(e.target.value)} />
          </label>
          <label style={ui.label}>
            Año hasta (opcional)
            <input style={ui.input} type="number" value={yearTo} onChange={(e) => setYearTo(e.target.value)} />
          </label>
          <button style={ui.button("primary")} onClick={calculate}>
            Calcular cartera combinada
          </button>
        </div>
        {error && <p style={{ color: colors.danger, marginTop: 8 }}>{error}</p>}
      </div>

      {calc && (
        <>
          <div style={ui.card}>
            <h3 style={ui.cardTitle}>
              Evolución del dinero {calc.years[0]}–{calc.years[calc.years.length - 1]}
            </h3>
            <LineChart points={calc.points} series={series} xKey="year" />
          </div>

          <div style={ui.card}>
            <h3 style={ui.cardTitle}>Riesgo y retorno</h3>
            <div style={ui.tableScroll}>
              <table style={ui.table}>
                <thead>
                  <tr>
                    <th style={ui.th}>Serie</th>
                    <th style={ui.th}>Peso efectivo</th>
                    <th style={ui.th}>Retorno total</th>
                    <th style={ui.th}>CAGR</th>
                    <th style={ui.th}>Volatilidad (anual)</th>
                    <th style={ui.th}>Máx. drawdown (fin de año)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style={{ ...ui.td, fontWeight: 700 }}>Cartera combinada</td>
                    <td style={ui.td}>100%</td>
                    <td style={{ ...ui.td, color: calc.portfolioStats.totalReturn >= 0 ? colors.success : colors.danger, fontWeight: 700 }}>
                      {pct(calc.portfolioStats.totalReturn)}
                    </td>
                    <td style={{ ...ui.td, color: calc.portfolioStats.cagr >= 0 ? colors.success : colors.danger }}>
                      {pct(calc.portfolioStats.cagr)}
                    </td>
                    <td style={ui.td}>{pct(calc.portfolioStats.volatility)}</td>
                    <td style={{ ...ui.td, color: colors.danger }}>{pct(calc.portfolioStats.maxDrawdown)}</td>
                  </tr>
                  {calc.legStats.map((l, i) => (
                    <tr key={i}>
                      <td style={ui.td}>
                        {l.name}
                        {l.isReal && (
                          <span
                            title="Volatilidad y drawdown reales (diarios), calculados por su propia pestaña — no una aproximación anual."
                            style={{ marginLeft: 6, color: colors.success, cursor: "help" }}
                          >
                            ✓
                          </span>
                        )}
                      </td>
                      <td style={ui.td}>{pct(l.weight, 0)}</td>
                      <td style={{ ...ui.td, color: l.stats.totalReturn >= 0 ? colors.success : colors.danger }}>
                        {pct(l.stats.totalReturn)}
                      </td>
                      <td style={ui.td}>{pct(l.stats.cagr)}</td>
                      <td style={ui.td}>{pct(l.stats.volatility)}</td>
                      <td style={{ ...ui.td, color: colors.danger }}>{pct(l.stats.maxDrawdown)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p style={{ ...ui.muted, marginTop: 8 }}>
              Las filas con <span style={{ color: colors.success }}>✓</span> muestran la volatilidad y el máximo
              drawdown REALES (calculados sobre retornos diarios por esa misma pestaña), no una aproximación — pasa
              cuando el período que estás combinando cubre exactamente todo lo que esa estrategia corrió. Las demás
              filas (y siempre la fila "Cartera combinada", porque mezclar 3 calendarios diarios distintos no es
              posible) están recortadas al período {calc.years[0]}–{calc.years[calc.years.length - 1]} y aproximadas
              a partir de sus retornos ANUALES — no son necesariamente el resultado completo que viste en su propia
              pestaña.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
