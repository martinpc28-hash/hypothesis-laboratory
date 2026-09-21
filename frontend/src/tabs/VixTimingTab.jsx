import { useState } from "react";
import { api } from "../api.js";
import { ui, colors } from "../theme.js";
import LineChart from "../LineChart.jsx";

const CURRENT_YEAR = new Date().getFullYear();
const DEFAULT_YEAR_FROM = 2000;
const DEFAULT_YEAR_TO = CURRENT_YEAR;

// Combinaciones encontradas al barrer el grid entrada/salida sobre 2000-2026 (ver análisis en
// chat): las primeras 4 le ganan al buy & hold en CAGR; 30/15 es el punto de partida original.
const VIX_PRESETS = [
  { enter: 30, exit: 15, label: "30 / 15", note: "Original" },
  { enter: 35, exit: 10, label: "35 / 10", note: "Mejor CAGR y vol" },
  { enter: 40, exit: 10, label: "40 / 10", note: "Mejor drawdown" },
  { enter: 35, exit: 12, label: "35 / 12", note: "Balanceado" },
  { enter: 35, exit: 13, label: "35 / 13", note: "" },
  { enter: 32, exit: 20, label: "32 / 20", note: "Menos tiempo invertido" },
];

function pct(v, digits = 1) {
  return v === null || v === undefined || Number.isNaN(v) ? "—" : `${(v * 100).toFixed(digits)}%`;
}

export default function VixTimingTab({ setStatus }) {
  const [yearFrom, setYearFrom] = useState(DEFAULT_YEAR_FROM);
  const [yearTo, setYearTo] = useState(DEFAULT_YEAR_TO);
  const [cashRatePct, setCashRatePct] = useState(3);
  const [currency, setCurrency] = useState("USD");
  const [enterVix, setEnterVix] = useState(VIX_PRESETS[0].enter);
  const [exitVix, setExitVix] = useState(VIX_PRESETS[0].exit);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  async function run() {
    setLoading(true);
    try {
      const body = { yearFrom, yearTo, cashAnnualRate: cashRatePct / 100, currency, enterVix, exitVix };
      const res = await api.runVixTimingBacktest(body);
      setResult(res);
    } catch (e) {
      setStatus({ type: "error", text: `VIX timing backtest failed: ${e.message}` });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div style={ui.card}>
        <h2 style={ui.cardTitle}>VIX Timing</h2>
        <p style={ui.cardSubtitle}>
          Se mantiene el dinero en un monetario hasta que el VIX (CBOE, vía FRED VIXCLS) cierra en {enterVix} o más —
          ahí se pasa 100% a S&amp;P 500 — y se vuelve al monetario cuando el VIX cierra en {exitVix} o menos. La
          decisión de cada día usa el cierre del día anterior, nunca el del mismo día.
        </p>

        <div style={{ marginBottom: 16 }}>
          <div style={{ ...ui.label, marginBottom: 8 }}>Entrada / salida del VIX</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {VIX_PRESETS.map((p) => {
              const active = p.enter === enterVix && p.exit === exitVix;
              return (
                <button
                  key={`${p.enter}-${p.exit}`}
                  style={ui.button(active ? "primary" : "secondary")}
                  onClick={() => {
                    setEnterVix(p.enter);
                    setExitVix(p.exit);
                  }}
                  title={p.note || undefined}
                >
                  {p.label}
                  {p.note && <span style={{ opacity: 0.75, fontWeight: 400 }}>&nbsp;· {p.note}</span>}
                </button>
              );
            })}
          </div>
        </div>

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
            Tasa del monetario (anual %)
            <input
              style={ui.input}
              type="number"
              step="0.1"
              value={cashRatePct}
              onChange={(e) => setCashRatePct(Number(e.target.value))}
            />
          </label>
          <label style={ui.label}>
            Moneda
            <select style={ui.input} value={currency} onChange={(e) => setCurrency(e.target.value)}>
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
            </select>
          </label>
          <button style={ui.button("primary")} onClick={run} disabled={loading}>
            {loading ? "Calculando…" : "Correr backtest"}
          </button>
        </div>
      </div>

      {result && <VixTimingResult result={result} />}
    </div>
  );
}

function VixTimingResult({ result }) {
  const { meta, stats, cumulative, msciWorldAvailable, trades, tradesCount, daysInEquity, daysInCash, pctTimeInEquity } =
    result;

  const series = [
    { key: "cumulativeStrategy", label: "VIX timing", color: colors.success },
    { key: "cumulativeSp500", label: "S&P 500 buy & hold", color: colors.primary },
    ...(msciWorldAvailable ? [{ key: "cumulativeMsciWorld", label: "MSCI World buy & hold", color: colors.warning }] : []),
  ];

  return (
    <>
      <div style={ui.card}>
        <h3 style={ui.cardTitle}>Resultados {meta.yearFrom}–{meta.yearTo}</h3>
        <p style={ui.cardSubtitle}>
          Monetario al {(meta.cashAnnualRate * 100).toFixed(1)}% anual en {meta.currency} · entra en S&amp;P 500 con
          VIX ≥ {meta.enterVix} · sale con VIX ≤ {meta.exitVix}
        </p>
        <div style={ui.tableScroll}>
          <table style={ui.table}>
            <thead>
              <tr>
                <th style={ui.th}>Estrategia</th>
                <th style={ui.th}>Retorno total</th>
                <th style={ui.th}>CAGR</th>
                <th style={ui.th}>Volatilidad anualizada</th>
                <th style={ui.th}>Máximo drawdown</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={ui.td}>VIX timing</td>
                <td style={ui.td}>{pct(stats.strategy.totalReturn)}</td>
                <td style={ui.td}>{pct(stats.strategy.cagr)}</td>
                <td style={ui.td}>{pct(stats.strategy.volatility)}</td>
                <td style={ui.td}>{pct(stats.strategy.maxDrawdown)}</td>
              </tr>
              <tr>
                <td style={ui.td}>S&amp;P 500 buy &amp; hold</td>
                <td style={ui.td}>{pct(stats.sp500.totalReturn)}</td>
                <td style={ui.td}>{pct(stats.sp500.cagr)}</td>
                <td style={ui.td}>{pct(stats.sp500.volatility)}</td>
                <td style={ui.td}>{pct(stats.sp500.maxDrawdown)}</td>
              </tr>
              {msciWorldAvailable && (
                <tr>
                  <td style={ui.td}>MSCI World buy &amp; hold</td>
                  <td style={ui.td}>{pct(stats.msciWorld.totalReturn)}</td>
                  <td style={ui.td}>{pct(stats.msciWorld.cagr)}</td>
                  <td style={ui.td}>{pct(stats.msciWorld.volatility)}</td>
                  <td style={ui.td}>{pct(stats.msciWorld.maxDrawdown)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {!msciWorldAvailable && (
          <p style={ui.muted}>MSCI World (URTH) no cubre todo el rango elegido, así que se omite de la comparación.</p>
        )}
        <div style={{ ...ui.statGrid, marginTop: 16 }}>
          <div style={ui.statCard}>
            <div style={ui.statLabel}>Operaciones (entradas)</div>
            <div style={ui.statValue}>{tradesCount}</div>
          </div>
          <div style={ui.statCard}>
            <div style={ui.statLabel}>% del tiempo invertido</div>
            <div style={ui.statValue}>{pct(pctTimeInEquity, 1)}</div>
          </div>
          <div style={ui.statCard}>
            <div style={ui.statLabel}>Días en S&amp;P 500 / en monetario</div>
            <div style={ui.statValue}>
              {daysInEquity} / {daysInCash}
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
        {trades.length === 0 ? (
          <div style={ui.emptyState}>El VIX nunca llegó a {meta.enterVix} en este rango — nunca entró al mercado.</div>
        ) : (
          <div style={ui.tableScroll}>
            <table style={ui.table}>
              <thead>
                <tr>
                  <th style={ui.th}>Entrada</th>
                  <th style={ui.th}>VIX entrada</th>
                  <th style={ui.th}>Salida</th>
                  <th style={ui.th}>VIX salida</th>
                  <th style={ui.th}>Retorno de la operación</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t, i) => (
                  <tr key={i}>
                    <td style={ui.td}>{t.entryDate}</td>
                    <td style={ui.td}>{t.vixAtEntry?.toFixed(1)}</td>
                    <td style={ui.td}>{t.open ? "Abierta (aún en S&P 500)" : t.exitDate}</td>
                    <td style={ui.td}>{t.open ? "—" : t.vixAtExit?.toFixed(1)}</td>
                    <td style={ui.td}>{pct(t.tradeReturn)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
