import { useState } from "react";
import { api } from "../api.js";
import { ui, colors } from "../theme.js";
import LineChart from "../LineChart.jsx";

const auditableCell = {
  cursor: "pointer",
  textDecoration: "underline",
  textDecorationStyle: "dotted",
  textDecorationColor: colors.border,
  textUnderlineOffset: 3,
};

const CURRENT_YEAR = new Date().getFullYear();
// VWEHX/VWESX (the USD instruments — real Vanguard mutual funds) cover the full 2000-2026 range
// directly, matching the rest of this project's range.
const DEFAULT_YEAR_FROM = 2000;
const DEFAULT_YEAR_TO = CURRENT_YEAR;

// Mirrors CreditRotationService.FEATURES on the backend — kept here as plain labels/units for
// display; the backend is the source of truth for which series/transform each key maps to.
const FEATURES = [
  { key: "CREDIT_SPREAD", label: "Credit spread (Baa − 10Y Treasury)", unit: "pp", hint: "ej. 2.5 a 6" },
  { key: "VIX", label: "VIX (CBOE Volatility Index)", unit: "", hint: "ej. 15 a 35" },
  { key: "YIELD_CURVE", label: "Curva de rendimiento (10Y − 2Y)", unit: "pp", hint: "ej. -1 a 2" },
  { key: "RATE_LEVEL", label: "Rendimiento del Treasury a 10 años", unit: "%", hint: "ej. 1 a 5" },
  { key: "RATE_CHANGE", label: "Cambio del rendimiento a 10Y vs. hace un año", unit: "pp", hint: "ej. -1.5 a 1.5" },
  { key: "INFLATION", label: "Inflación (interanual, CPI)", unit: "fracción", hint: "ej. 0.02 a 0.08 (2%-8%)" },
  { key: "GROWTH", label: "Crecimiento (interanual, Producción Industrial)", unit: "fracción", hint: "ej. -0.05 a 0.05" },
];

function pct(v, digits = 1) {
  return v === null || v === undefined || Number.isNaN(v) ? "—" : `${(v * 100).toFixed(digits)}%`;
}
function featureLabel(key) {
  return FEATURES.find((f) => f.key === key)?.label ?? key;
}
function featureValue(v, key) {
  if (v === null || v === undefined) return "—";
  const f = FEATURES.find((ft) => ft.key === key);
  if (f && f.unit === "fracción") return pct(v, 1);
  return v.toFixed(2);
}

export default function CreditRotationTab({ setStatus }) {
  const [yearFrom, setYearFrom] = useState(DEFAULT_YEAR_FROM);
  const [yearTo, setYearTo] = useState(DEFAULT_YEAR_TO);
  const [feature, setFeature] = useState("VIX");
  const [enterThreshold, setEnterThreshold] = useState(30);
  const [exitThreshold, setExitThreshold] = useState(15);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  const [sweepLoading, setSweepLoading] = useState(false);
  const [sweepResult, setSweepResult] = useState(null);
  const [rankBy, setRankBy] = useState("RISK_ADJUSTED");
  const [rankCurrency, setRankCurrency] = useState("USD");

  async function run(overrides) {
    setLoading(true);
    try {
      const body = {
        yearFrom,
        yearTo,
        feature: overrides?.feature ?? feature,
        enterThreshold: overrides?.enterThreshold ?? enterThreshold,
        exitThreshold: overrides?.exitThreshold ?? exitThreshold,
      };
      const res = await api.runCreditRotationBacktest(body);
      setResult(res);
    } catch (e) {
      setStatus({ type: "error", text: `Credit rotation backtest failed: ${e.message}` });
    } finally {
      setLoading(false);
    }
  }

  async function runSweep() {
    setSweepLoading(true);
    try {
      const res = await api.runCreditRotationSweep({ yearFrom, yearTo, rankBy, rankCurrency });
      setSweepResult(res);
    } catch (e) {
      setStatus({ type: "error", text: `Credit rotation sweep failed: ${e.message}` });
    } finally {
      setSweepLoading(false);
    }
  }

  function applyAndRun(row) {
    setFeature(row.feature);
    setEnterThreshold(Number(row.enterThreshold.toFixed(4)));
    setExitThreshold(Number(row.exitThreshold.toFixed(4)));
    run({ feature: row.feature, enterThreshold: row.enterThreshold, exitThreshold: row.exitThreshold });
  }

  return (
    <div>
      <div style={ui.card}>
        <h2 style={ui.cardTitle}>Rotación de crédito: High Yield vs. Investment Grade</h2>
        <p style={ui.cardSubtitle}>
          Se mantiene el dinero en bonos investment grade (fondo VWESX) hasta que la variable macro elegida cierra en{" "}
          {enterThreshold} o más — ahí se pasa 100% a high yield (fondo VWEHX) — y se vuelve a investment grade cuando
          cierra en {exitThreshold} o menos. Misma convención en las 7 variables: "entra en HY con una lectura ALTA,
          sale a IG con una lectura BAJA" — igual que ya se validó para el VIX en la pestaña VIX Timing — para no
          imponer a mano qué dirección "debería" funcionar en cada variable y dejar que la búsqueda de abajo lo
          decida con datos. La decisión de cada día usa el cierre del día anterior, nunca el del mismo día. Todos los
          resultados se dan siempre en USD y en EUR por separado, nunca uno solo.
        </p>
        <p style={ui.cardSubtitle}>
          100% fondos reales en su divisa nativa, sin conversión cambiaria en ninguno de los dos lados: VWEHX
          (Vanguard High-Yield Corporate) y VWESX (Vanguard Long-Term Investment-Grade) cubren 2000-2026 en USD.
          Candriam Bonds Euro High Yield (real desde 1999-12-28) y DPAM Bonds L - Corporate EUR (real desde
          2000-01-03) cubren prácticamente el mismo rango directamente en EUR — no una conversión del fondo USD.
          Todos los precios reflejan el retorno total (dividendos/cupones reinvertidos) — en bonos, la mayor parte
          del retorno es la distribución, no la apreciación del precio.
        </p>

        <div style={ui.form}>
          <label style={ui.label}>
            Año desde
            <input style={ui.input} type="number" value={yearFrom} onChange={(e) => setYearFrom(Number(e.target.value))} />
          </label>
          <label style={ui.label}>
            Año hasta
            <input style={ui.input} type="number" value={yearTo} onChange={(e) => setYearTo(Number(e.target.value))} />
          </label>
          <label style={ui.label}>
            Variable macro
            <select style={ui.input} value={feature} onChange={(e) => setFeature(e.target.value)}>
              {FEATURES.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label style={ui.label}>
            Entra en HY (≥)
            <input
              style={ui.input}
              type="number"
              step="0.01"
              value={enterThreshold}
              onChange={(e) => setEnterThreshold(Number(e.target.value))}
            />
          </label>
          <label style={ui.label}>
            Sale a IG (≤)
            <input
              style={ui.input}
              type="number"
              step="0.01"
              value={exitThreshold}
              onChange={(e) => setExitThreshold(Number(e.target.value))}
            />
          </label>
          <button style={ui.button("primary")} onClick={() => run()} disabled={loading}>
            {loading ? "Calculando…" : "Correr backtest"}
          </button>
        </div>
        <p style={{ ...ui.muted, marginTop: 8 }}>
          {FEATURES.find((f) => f.key === feature)?.hint} — unidad: {FEATURES.find((f) => f.key === feature)?.unit || "nivel"}
        </p>
      </div>

      <div style={ui.card}>
        <h3 style={ui.cardTitle}>Buscar la mejor combinación</h3>
        <p style={ui.cardSubtitle}>
          Prueba las 7 variables candidatas × una grilla de umbrales de entrada/salida basada en los percentiles
          propios de cada variable en el rango elegido, y ranquea todas las combinaciones probadas — mismo espíritu
          que el "Monte Carlo" combinatorio de Seasonality, aplicado a esta estrategia continua. Cada fila muestra el
          resultado en USD y en EUR; "Ranquear en" solo decide cuál de los dos ordena el ranking. Ojo con las filas
          de pocas operaciones ("trades"): una combinación con 1 sola operación no está probando una regla de
          rotación, solo eligió con el diario cuál de los dos activos ganó en todo el período.
        </p>
        <div style={ui.form}>
          <label style={ui.label}>
            Ranquear por
            <select style={ui.input} value={rankBy} onChange={(e) => setRankBy(e.target.value)}>
              <option value="RISK_ADJUSTED">Ajustado por riesgo (CAGR ÷ Vol)</option>
              <option value="CAGR">CAGR</option>
              <option value="TOTAL_RETURN">Retorno total</option>
            </select>
          </label>
          <label style={ui.label}>
            Ranquear en
            <select style={ui.input} value={rankCurrency} onChange={(e) => setRankCurrency(e.target.value)}>
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
            </select>
          </label>
          <button style={ui.button("secondary")} onClick={runSweep} disabled={sweepLoading}>
            {sweepLoading ? "Buscando…" : "Buscar mejor combinación"}
          </button>
        </div>

        {sweepResult && (
          <div style={{ ...ui.tableScroll, marginTop: 16 }}>
            <p style={ui.muted}>
              {sweepResult.meta.combinationsTested} combinaciones probadas · ranking en {sweepResult.meta.rankCurrency}.
            </p>
            <table style={ui.table}>
              <thead>
                <tr>
                  <th style={ui.th}>Variable</th>
                  <th style={ui.th}>Entra en HY (≥)</th>
                  <th style={ui.th}>Sale a IG (≤)</th>
                  <th style={ui.th}>CAGR (USD)</th>
                  <th style={ui.th}>CAGR (EUR)</th>
                  <th style={ui.th}>Vol. (USD)</th>
                  <th style={ui.th}>Vol. (EUR)</th>
                  <th style={ui.th}>Max. DD (USD)</th>
                  <th style={ui.th}>Max. DD (EUR)</th>
                  <th style={ui.th}>Operaciones</th>
                  <th style={ui.th}></th>
                </tr>
              </thead>
              <tbody>
                {sweepResult.top.map((r, i) => (
                  <tr key={i}>
                    <td style={ui.td}>{featureLabel(r.feature)}</td>
                    <td style={ui.td}>{featureValue(r.enterThreshold, r.feature)}</td>
                    <td style={ui.td}>{featureValue(r.exitThreshold, r.feature)}</td>
                    <td style={{ ...ui.td, color: r.usd.cagr >= 0 ? colors.success : colors.danger, fontWeight: 700 }}>
                      {pct(r.usd.cagr)}
                    </td>
                    <td style={{ ...ui.td, color: r.eur.cagr >= 0 ? colors.success : colors.danger, fontWeight: 700 }}>
                      {pct(r.eur.cagr)}
                    </td>
                    <td style={ui.td}>{pct(r.usd.volatility)}</td>
                    <td style={ui.td}>{pct(r.eur.volatility)}</td>
                    <td style={{ ...ui.td, color: colors.danger }}>{pct(r.usd.maxDrawdown)}</td>
                    <td style={{ ...ui.td, color: colors.danger }}>{pct(r.eur.maxDrawdown)}</td>
                    <td style={{ ...ui.td, color: r.tradesCount <= 1 ? colors.warning : colors.text }}>
                      {r.tradesCount}
                      {r.tradesCount <= 1 && " ⚠"}
                    </td>
                    <td style={ui.td}>
                      <button style={ui.button("secondary")} onClick={() => applyAndRun(r)}>
                        Usar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {result && <CreditRotationResult result={result} />}
    </div>
  );
}

function StatsRow({ label, usd, eur }) {
  return (
    <tr>
      <td style={ui.td}>{label}</td>
      <td style={{ ...ui.td, color: usd.totalReturn >= 0 ? colors.success : colors.danger, fontWeight: 700 }}>
        {pct(usd.totalReturn)}
      </td>
      <td style={{ ...ui.td, color: usd.cagr >= 0 ? colors.success : colors.danger }}>{pct(usd.cagr)}</td>
      <td style={ui.td}>{pct(usd.volatility)}</td>
      <td style={{ ...ui.td, color: colors.danger }}>{pct(usd.maxDrawdown)}</td>
      <td style={{ ...ui.td, color: eur.totalReturn >= 0 ? colors.success : colors.danger, fontWeight: 700, borderLeft: `1px solid ${colors.border}` }}>
        {pct(eur.totalReturn)}
      </td>
      <td style={{ ...ui.td, color: eur.cagr >= 0 ? colors.success : colors.danger }}>{pct(eur.cagr)}</td>
      <td style={ui.td}>{pct(eur.volatility)}</td>
      <td style={{ ...ui.td, color: colors.danger }}>{pct(eur.maxDrawdown)}</td>
    </tr>
  );
}

function CreditRotationResult({ result }) {
  const { meta, stats, cumulative, spyAvailable, trades, tradesCount, daysInHy, daysInIg, pctTimeInHy } = result;
  const [tradeAudit, setTradeAudit] = useState(null);

  const series = [
    { key: "cumulativeStrategyUsd", label: "Rotación (USD)", color: colors.success },
    { key: "cumulativeStrategyEur", label: "Rotación (EUR)", color: colors.primary },
    ...(spyAvailable
      ? [
          { key: "cumulativeSp500Usd", label: "S&P 500 (USD, referencia)", color: colors.warning },
          { key: "cumulativeSp500Eur", label: "S&P 500 (EUR, referencia)", color: colors.textMuted },
        ]
      : []),
  ];

  return (
    <>
      <div style={ui.card}>
        <h3 style={ui.cardTitle}>
          Resultados {meta.yearFrom}–{meta.yearTo}
        </h3>
        <p style={ui.cardSubtitle}>
          {meta.featureLabel} · entra en {meta.hyTicker} con lectura ≥ {meta.enterThreshold} · sale a {meta.igTicker} con
          lectura ≤ {meta.exitThreshold} · USD: {meta.hyTicker}/{meta.igTicker} desde {meta.dataStart} · EUR: fondos
          reales nativos desde {meta.hyEurDataStart} (HY) y {meta.igEurDataStart} (IG) — sin conversión cambiaria
        </p>
        <div style={ui.tableScroll}>
          <table style={ui.table}>
            <thead>
              <tr>
                <th style={ui.th}>Serie</th>
                <th style={ui.th} colSpan={4}>
                  USD (nativa)
                </th>
                <th style={{ ...ui.th, borderLeft: `1px solid ${colors.border}` }} colSpan={4}>
                  EUR (nativa — fondo real, sin conversión)
                </th>
              </tr>
              <tr>
                <th style={ui.th}></th>
                <th style={ui.th}>Retorno total</th>
                <th style={ui.th}>CAGR</th>
                <th style={ui.th}>Vol. anualizada</th>
                <th style={ui.th}>Máx. drawdown</th>
                <th style={{ ...ui.th, borderLeft: `1px solid ${colors.border}` }}>Retorno total</th>
                <th style={ui.th}>CAGR</th>
                <th style={ui.th}>Vol. anualizada</th>
                <th style={ui.th}>Máx. drawdown</th>
              </tr>
            </thead>
            <tbody>
              <StatsRow label="Rotación (estrategia)" usd={stats.usd.strategy} eur={stats.eur.strategy} />
              <StatsRow label={`${meta.hyTicker} (buy & hold)`} usd={stats.usd.hy} eur={stats.eur.hy} />
              <StatsRow label={`${meta.igTicker} (buy & hold)`} usd={stats.usd.ig} eur={stats.eur.ig} />
              {spyAvailable && (
                <StatsRow label="S&P 500 (referencia, no es la alternativa real)" usd={stats.usd.spy} eur={stats.eur.spy} />
              )}
            </tbody>
          </table>
        </div>
        <p style={{ ...ui.muted, marginTop: 8 }}>
          El S&amp;P 500 se muestra solo como referencia de contexto (renta variable vs. renta fija) — la decisión
          real que esta estrategia toma es entre {meta.hyTicker} y {meta.igTicker}, no contra acciones. Su columna
          EUR es la única que sigue siendo conversión cambiaria (no hay un equivalente EUR nativo con esta historia
          que valga la pena perseguir para una simple referencia); tanto {meta.hyTicker}/{meta.igTicker} como sus
          contrapartes EUR ({meta.hyEurTicker}/{meta.igEurTicker}) son 100% fondos reales en su propia divisa.
        </p>
        <div style={{ ...ui.statGrid, marginTop: 16 }}>
          <div style={ui.statCard}>
            <div style={ui.statLabel}>Operaciones a HY</div>
            <div style={ui.statValue}>{tradesCount}</div>
          </div>
          <div style={ui.statCard}>
            <div style={ui.statLabel}>% del tiempo en HY</div>
            <div style={ui.statValue}>{pct(pctTimeInHy, 1)}</div>
          </div>
          <div style={ui.statCard}>
            <div style={ui.statLabel}>Días en HY / en IG</div>
            <div style={ui.statValue}>
              {daysInHy} / {daysInIg}
            </div>
          </div>
        </div>
      </div>

      <div style={ui.card}>
        <h3 style={ui.cardTitle}>Rentabilidad acumulada</h3>
        <LineChart points={cumulative} series={series} xKey="year" />
      </div>

      <div style={ui.card}>
        <h3 style={ui.cardTitle}>Operaciones</h3>
        <p style={ui.cardSubtitle}>Incluye los tramos en {meta.hyTicker} y en {meta.igTicker} — juntos cubren todo el rango elegido.</p>
        <div style={ui.tableScroll}>
          <table style={ui.table}>
            <thead>
              <tr>
                <th style={ui.th}>Tipo</th>
                <th style={ui.th}>Entrada</th>
                <th style={ui.th}>{meta.featureLabel} entrada</th>
                <th style={ui.th}>Salida</th>
                <th style={ui.th}>{meta.featureLabel} salida</th>
                <th style={ui.th}>Retorno (USD)</th>
                <th style={ui.th}>Retorno (EUR)</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t, i) => (
                <tr key={i}>
                  <td style={ui.td}>
                    <span style={ui.badge(t.type === "HY" ? "primary" : "neutral")}>
                      {t.type === "HY" ? `${meta.hyTicker} (high yield)` : `${meta.igTicker} (investment grade)`}
                    </span>
                  </td>
                  <td style={ui.td}>{t.entryDate}</td>
                  <td style={ui.td}>{t.featureAtEntry?.toFixed(2) ?? "—"}</td>
                  <td style={ui.td}>{t.open ? "Abierta (sigue hoy)" : t.exitDate}</td>
                  <td style={ui.td}>{t.open ? "—" : t.featureAtExit?.toFixed(2) ?? "—"}</td>
                  <td style={{ ...ui.td, ...auditableCell }} onClick={() => setTradeAudit(t)}>
                    {pct(t.tradeReturnUsd)}
                  </td>
                  <td style={{ ...ui.td, ...auditableCell }} onClick={() => setTradeAudit(t)}>
                    {pct(t.tradeReturnEur)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {tradeAudit && (
        <div style={ui.card}>
          <h3 style={ui.cardTitle}>Auditoría del tramo</h3>
          <table style={{ width: "100%", fontSize: 12.5, borderCollapse: "collapse" }}>
            <tbody>
              <tr>
                <td style={{ padding: "3px 0", color: colors.textMuted, width: "45%" }}>
                  Fecha / precio de compra (USD, ajustado)
                </td>
                <td style={{ padding: "3px 0", textAlign: "right" }}>
                  {tradeAudit.entryDate} · <strong>${Number(tradeAudit.entryPrice).toFixed(2)}</strong>
                </td>
              </tr>
              <tr>
                <td style={{ padding: "3px 0", color: colors.textMuted }}>
                  {tradeAudit.open ? "Precio actual (tramo abierto), USD" : "Fecha / precio de venta, USD"}
                </td>
                <td style={{ padding: "3px 0", textAlign: "right" }}>
                  {tradeAudit.open ? tradeAudit.asOfDate : tradeAudit.exitDate} ·{" "}
                  <strong>${Number(tradeAudit.open ? tradeAudit.asOfPrice : tradeAudit.exitPrice).toFixed(2)}</strong>
                </td>
              </tr>
              <tr>
                <td style={{ padding: "3px 0", color: colors.textMuted, borderTop: `1px dashed ${colors.border}` }}>
                  Precio de compra en EUR (fondo EUR real, sin conversión)
                </td>
                <td style={{ padding: "3px 0", textAlign: "right", borderTop: `1px dashed ${colors.border}` }}>
                  <strong>€{Number(tradeAudit.entryPriceEur).toFixed(2)}</strong>
                </td>
              </tr>
              <tr>
                <td style={{ padding: "3px 0", color: colors.textMuted }}>
                  Precio de {tradeAudit.open ? "hoy" : "venta"} en EUR (fondo EUR real, sin conversión)
                </td>
                <td style={{ padding: "3px 0", textAlign: "right" }}>
                  <strong>
                    €{Number(tradeAudit.open ? tradeAudit.asOfPriceEur : tradeAudit.exitPriceEur).toFixed(2)}
                  </strong>
                </td>
              </tr>
              <tr>
                <td style={{ padding: "3px 0", color: colors.textMuted, borderTop: `1px dashed ${colors.border}` }}>
                  Retorno del tramo — USD
                </td>
                <td style={{ padding: "3px 0", textAlign: "right", borderTop: `1px dashed ${colors.border}` }}>
                  <strong>{pct(tradeAudit.tradeReturnUsd, 2)}</strong>
                </td>
              </tr>
              <tr>
                <td style={{ padding: "3px 0", color: colors.textMuted }}>Retorno del tramo — EUR</td>
                <td style={{ padding: "3px 0", textAlign: "right" }}>
                  <strong>{pct(tradeAudit.tradeReturnEur, 2)}</strong>
                </td>
              </tr>
            </tbody>
          </table>
          <p style={{ ...ui.muted, marginTop: 10, paddingTop: 10, borderTop: `1px dashed ${colors.border}` }}>
            El retorno en EUR es la performance real del fondo EUR nativo — no hay conversión cambiaria ni cobertura
            de por medio, es simplemente cuánto rindió ese fondo en su propia divisa durante este tramo.
          </p>
          <button style={{ ...ui.button("secondary"), marginTop: 10 }} onClick={() => setTradeAudit(null)}>
            Cerrar
          </button>
        </div>
      )}
    </>
  );
}
