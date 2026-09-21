import { useState } from "react";
import { api } from "../api.js";
import { ui, colors } from "../theme.js";
import LineChart from "../LineChart.jsx";
import { Drawer } from "../AuditPanel.jsx";

const auditableCell = {
  cursor: "pointer",
  textDecoration: "underline",
  textDecorationStyle: "dotted",
  textDecorationColor: colors.border,
  textUnderlineOffset: 3,
};

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
  const [currency, setCurrency] = useState("USD");
  const [enterVix, setEnterVix] = useState(VIX_PRESETS[0].enter);
  const [exitVix, setExitVix] = useState(VIX_PRESETS[0].exit);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  async function run() {
    setLoading(true);
    try {
      const body = { yearFrom, yearTo, currency, enterVix, exitVix };
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
          Se mantiene el dinero en un monetario real (letra del Tesoro a 3 meses en USD, o depósito
          interbancario Euríbor 3M en EUR) hasta que el VIX (CBOE, vía FRED VIXCLS) cierra en {enterVix} o más —
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
            Moneda / monetario
            <select style={ui.input} value={currency} onChange={(e) => setCurrency(e.target.value)}>
              <option value="USD">USD — Letra del Tesoro 3M</option>
              <option value="EUR">EUR — Euríbor 3M interbancario</option>
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
  const {
    meta,
    stats,
    cumulative,
    msciWorldAvailable,
    sp500HedgedAvailable,
    trades,
    tradesCount,
    daysInEquity,
    daysInCash,
    pctTimeInEquity,
  } = result;
  const [tradeAudit, setTradeAudit] = useState(null);

  const series = [
    { key: "cumulativeStrategy", label: "VIX timing", color: colors.success },
    { key: "cumulativeSp500", label: "S&P 500 buy & hold", color: colors.primary },
    ...(sp500HedgedAvailable
      ? [{ key: "cumulativeSp500Hedged", label: "S&P 500 EUR hedged (sintético)", color: colors.primaryDark }]
      : []),
    ...(msciWorldAvailable ? [{ key: "cumulativeMsciWorld", label: "MSCI World buy & hold", color: colors.warning }] : []),
  ];

  return (
    <>
      <div style={ui.card}>
        <h3 style={ui.cardTitle}>Resultados {meta.yearFrom}–{meta.yearTo}</h3>
        <p style={ui.cardSubtitle}>
          Monetario en {meta.currency} ({meta.cashSeriesName}, FRED {meta.cashSeriesId}) · entra en S&amp;P 500 con
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
              {sp500HedgedAvailable && (
                <tr>
                  <td style={ui.td}>S&amp;P 500 EUR hedged (sintético)</td>
                  <td style={ui.td}>{pct(stats.sp500Hedged.totalReturn)}</td>
                  <td style={ui.td}>{pct(stats.sp500Hedged.cagr)}</td>
                  <td style={ui.td}>{pct(stats.sp500Hedged.volatility)}</td>
                  <td style={ui.td}>{pct(stats.sp500Hedged.maxDrawdown)}</td>
                </tr>
              )}
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
        {sp500HedgedAvailable && (
          <p style={ui.muted}>
            "EUR hedged (sintético)" no es un producto cotizado — no existe una serie gratuita de S&amp;P 500 EUR
            hedged hasta 2000 — sino el retorno en USD ajustado por el diferencial de tasas Euríbor/T-Bill (paridad
            de tasas cubierta), la misma metodología que usan los ETFs hedged reales.
          </p>
        )}
        {!msciWorldAvailable && (
          <p style={ui.muted}>MSCI World (URTH) no cubre todo el rango elegido, así que se omite de la comparación.</p>
        )}
        <div style={{ ...ui.statGrid, marginTop: 16 }}>
          <div style={ui.statCard}>
            <div style={ui.statLabel}>Operaciones en S&amp;P 500</div>
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
        <p style={ui.cardSubtitle}>
          Incluye los tramos en S&amp;P 500 y los tramos en el monetario ({meta.cashSeriesName}) — juntos cubren
          todo el rango elegido.
        </p>
        <div style={ui.tableScroll}>
          <table style={ui.table}>
            <thead>
              <tr>
                <th style={ui.th}>Tipo</th>
                <th style={ui.th}>Entrada</th>
                <th style={ui.th}>VIX entrada</th>
                <th style={ui.th}>Salida</th>
                <th style={ui.th}>VIX salida</th>
                <th style={ui.th}>Retorno del tramo</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t, i) => (
                <tr key={i}>
                  <td style={ui.td}>
                    <span style={ui.badge(t.type === "EQUITY" ? "primary" : "neutral")}>
                      {t.type === "EQUITY" ? "S&P 500" : `Monetario ${meta.currency}`}
                    </span>
                  </td>
                  <td style={ui.td}>{t.entryDate}</td>
                  <td style={ui.td}>{t.vixAtEntry?.toFixed(1) ?? "—"}</td>
                  <td style={ui.td}>{t.open ? "Abierta (sigue hoy)" : t.exitDate}</td>
                  <td style={ui.td}>{t.open ? "—" : t.vixAtExit?.toFixed(1) ?? "—"}</td>
                  <td style={{ ...ui.td, ...auditableCell }} onClick={() => setTradeAudit({ trade: t, currency: meta.currency })}>
                    {pct(t.tradeReturn)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {tradeAudit && <TradeAuditDrawer detail={tradeAudit} onClose={() => setTradeAudit(null)} />}
    </>
  );
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric" });
}

function formatPrice(v) {
  return v === null || v === undefined ? "—" : `$${Number(v).toFixed(2)}`;
}

function formatRate(v) {
  return v === null || v === undefined ? "—" : `${Number(v).toFixed(2)}%`;
}

function TradeAuditDrawer({ detail, onClose }) {
  const { trade: t, currency } = detail;
  if (t.type === "EQUITY") return <EquityAuditDrawer t={t} currency={currency} onClose={onClose} />;
  return <CashAuditDrawer t={t} currency={currency} onClose={onClose} />;
}

function EquityAuditDrawer({ t, currency, onClose }) {
  const isEur = currency === "EUR";
  const exitLabel = t.open ? "Precio actual (operación abierta)" : "Fecha / precio de venta";
  const exitDate = t.open ? t.asOfDate : t.exitDate;
  const exitPrice = t.open ? t.asOfPrice : t.exitPrice;
  const fxExit = t.open ? t.fxAsOf : t.fxAtExit;

  return (
    <Drawer
      kicker="Auditoría del tramo"
      title="Precios de compra y venta (SPY)"
      subtitle={`VIX ${t.vixAtEntry?.toFixed(1)} en la entrada${t.open ? "" : ` · VIX ${t.vixAtExit?.toFixed(1)} en la salida`}`}
      onClose={onClose}
    >
      <table style={{ width: "100%", fontSize: 12.5, borderCollapse: "collapse" }}>
        <tbody>
          <tr>
            <td style={{ padding: "3px 0", color: colors.textMuted, width: "45%" }}>Fecha / precio de compra</td>
            <td style={{ padding: "3px 0", textAlign: "right" }}>
              {formatDate(t.entryDate)} · <strong>{formatPrice(t.entryPrice)}</strong>
            </td>
          </tr>
          <tr>
            <td style={{ padding: "3px 0", color: colors.textMuted }}>{exitLabel}</td>
            <td style={{ padding: "3px 0", textAlign: "right" }}>
              {formatDate(exitDate)} · <strong>{formatPrice(exitPrice)}</strong>
            </td>
          </tr>
          {isEur && (
            <>
              <tr>
                <td style={{ padding: "3px 0", color: colors.textMuted }}>USD/EUR en la compra</td>
                <td style={{ padding: "3px 0", textAlign: "right" }}>{t.fxAtEntry?.toFixed(4) ?? "—"}</td>
              </tr>
              <tr>
                <td style={{ padding: "3px 0", color: colors.textMuted }}>USD/EUR {t.open ? "actual" : "en la venta"}</td>
                <td style={{ padding: "3px 0", textAlign: "right" }}>{fxExit?.toFixed(4) ?? "—"}</td>
              </tr>
            </>
          )}
        </tbody>
      </table>
      <div
        style={{
          marginTop: 10,
          paddingTop: 10,
          borderTop: `1px dashed ${colors.border}`,
          fontSize: 12.5,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          color: colors.textMuted,
        }}
      >
        {isEur
          ? `(fx compra / fx venta) × (1 + (${formatPrice(exitPrice)} − ${formatPrice(t.entryPrice)}) / ${formatPrice(
              t.entryPrice
            )}) − 1 = ${pct(t.tradeReturn, 2)}`
          : `(${formatPrice(exitPrice)} − ${formatPrice(t.entryPrice)}) / ${formatPrice(t.entryPrice)} = ${pct(
              t.tradeReturn,
              2
            )}`}
      </div>
      {t.open && (
        <p style={{ ...ui.muted, marginTop: 12 }}>
          La operación sigue abierta: el precio de venta todavía no existe, así que el retorno usa el último precio
          disponible ({formatDate(t.asOfDate)}).
        </p>
      )}
    </Drawer>
  );
}

function CashAuditDrawer({ t, currency, onClose }) {
  const exitLabel = t.open ? "Tasa actual (tramo abierto)" : "Fecha / tasa a la salida";
  const exitDate = t.open ? t.asOfDate : t.exitDate;
  const exitRate = t.open ? t.asOfRate : t.exitRate;
  const seriesName = currency === "EUR" ? "Euríbor 3M interbancario (zona euro)" : "Letra del Tesoro de EE. UU. a 3 meses";
  const seriesId = currency === "EUR" ? "IR3TIB01EZM156N" : "DTB3";

  return (
    <Drawer
      kicker="Auditoría del tramo"
      title={`Tasa del monetario en ${currency}`}
      subtitle={`${seriesName} · FRED ${seriesId}`}
      onClose={onClose}
    >
      <table style={{ width: "100%", fontSize: 12.5, borderCollapse: "collapse" }}>
        <tbody>
          <tr>
            <td style={{ padding: "3px 0", color: colors.textMuted, width: "45%" }}>Fecha / tasa anual al entrar</td>
            <td style={{ padding: "3px 0", textAlign: "right" }}>
              {formatDate(t.entryDate)} · <strong>{formatRate(t.entryRate)}</strong>
            </td>
          </tr>
          <tr>
            <td style={{ padding: "3px 0", color: colors.textMuted }}>{exitLabel}</td>
            <td style={{ padding: "3px 0", textAlign: "right" }}>
              {formatDate(exitDate)} · <strong>{formatRate(exitRate)}</strong>
            </td>
          </tr>
        </tbody>
      </table>
      <p style={{ ...ui.muted, marginTop: 10, paddingTop: 10, borderTop: `1px dashed ${colors.border}` }}>
        El retorno del tramo ({pct(t.tradeReturn, 2)}) es la capitalización día a día de la tasa real publicada cada
        jornada (nunca la de hoy mismo, siempre la del día hábil anterior) — no una fórmula de un solo paso, porque
        la tasa varió a lo largo del tramo.
      </p>
      {t.open && (
        <p style={{ ...ui.muted, marginTop: 8 }}>
          El tramo sigue abierto: usa la tasa más reciente disponible ({formatDate(t.asOfDate)}).
        </p>
      )}
    </Drawer>
  );
}
