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

// The backend only gives cumulative wealth per year (cumulativeStrategy/cumulativeSp500), not each
// year's own return — derived here the same way compounding works: this year's return is this
// year's cumulative wealth divided by last year's, so "did this beat the market THIS year" can be
// asked year by year instead of only as one end-to-end total.
function yearlyReturnsFromCumulative(cumulative) {
  let prevStrategy = 0;
  let prevSp500 = 0;
  const rows = [];
  for (const c of cumulative) {
    const strategyReturn = (1 + c.cumulativeStrategy) / (1 + prevStrategy) - 1;
    const sp500Return = (1 + c.cumulativeSp500) / (1 + prevSp500) - 1;
    rows.push({ year: c.year, strategyReturn, sp500Return, diff: strategyReturn - sp500Return });
    prevStrategy = c.cumulativeStrategy;
    prevSp500 = c.cumulativeSp500;
  }
  return rows;
}

export default function VixTimingTab({ setStatus }) {
  const [yearFrom, setYearFrom] = useState(DEFAULT_YEAR_FROM);
  const [yearTo, setYearTo] = useState(DEFAULT_YEAR_TO);
  const [currency, setCurrency] = useState("USD");
  const [hedged, setHedged] = useState(false);
  const [enterVix, setEnterVix] = useState(VIX_PRESETS[0].enter);
  const [exitVix, setExitVix] = useState(VIX_PRESETS[0].exit);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  async function run() {
    setLoading(true);
    try {
      const body = { yearFrom, yearTo, currency, hedged: currency === "EUR" && hedged, enterVix, exitVix };
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
          {currency === "EUR" && (
            <label style={ui.label}>
              Invertir en
              <select style={ui.input} value={hedged ? "hedged" : "plain"} onChange={(e) => setHedged(e.target.value === "hedged")}>
                <option value="plain">S&P 500 sin cobertura (expuesto a USD/EUR)</option>
                <option value="hedged">S&P 500 EUR hedged (sintético)</option>
              </select>
            </label>
          )}
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
  const [tradeAudit, setTradeAudit] = useState(null);

  const sp500Label = meta.hedged ? "S&P 500 EUR hedged (sintético)" : "S&P 500 buy & hold";
  const series = [
    { key: "cumulativeStrategy", label: `VIX timing${meta.hedged ? " (hedged)" : ""}`, color: colors.success },
    { key: "cumulativeSp500", label: sp500Label, color: colors.primary },
    ...(msciWorldAvailable ? [{ key: "cumulativeMsciWorld", label: "MSCI World buy & hold", color: colors.warning }] : []),
  ];

  const yearlyRows = yearlyReturnsFromCumulative(cumulative);
  const winYears = yearlyRows.filter((r) => r.diff > 0);
  const lossYears = yearlyRows.filter((r) => r.diff <= 0);
  const avgWin = winYears.length ? winYears.reduce((a, r) => a + r.diff, 0) / winYears.length : null;
  const avgLoss = lossYears.length ? lossYears.reduce((a, r) => a + r.diff, 0) / lossYears.length : null;
  const winLossRatio = avgWin !== null && avgLoss ? Math.abs(avgWin / avgLoss) : null;
  // "Feels calmer day to day" (lower annualized vol, from smaller daily swings while sitting in
  // cash) is a different claim from "hurts less at the worst moment" (max drawdown, driven by
  // WHEN the strategy happens to be positioned) — worth calling out because they can disagree.
  const volLower = stats.strategy.volatility < stats.sp500.volatility;
  const drawdownWorse = stats.strategy.maxDrawdown < stats.sp500.maxDrawdown;
  const strategyTotalMultiple = 1 + stats.strategy.totalReturn;
  const sp500TotalMultiple = 1 + stats.sp500.totalReturn;
  const totalAlpha = stats.strategy.totalReturn - stats.sp500.totalReturn;
  const firstYear = yearlyRows.length ? yearlyRows[0].year : meta.yearFrom;
  const lastYear = yearlyRows.length ? yearlyRows[yearlyRows.length - 1].year : meta.yearTo;

  return (
    <>
      <div style={ui.card}>
        <h3 style={ui.cardTitle}>Resultados {meta.yearFrom}–{meta.yearTo}</h3>
        <p style={ui.cardSubtitle}>
          Monetario en {meta.currency} ({meta.cashSeriesName}, FRED {meta.cashSeriesId}) · entra en{" "}
          {meta.hedged ? "S&P 500 EUR hedged (sintético)" : "S&P 500"} con VIX ≥ {meta.enterVix} · sale con VIX ≤{" "}
          {meta.exitVix}
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
                <td style={ui.td}>{sp500Label}</td>
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
        {meta.hedged && (
          <p style={ui.muted}>
            "EUR hedged (sintético)" no es un producto cotizado — no existe una serie gratuita de S&amp;P 500 EUR
            hedged hasta 2000 — sino el retorno en USD ajustado por el diferencial de tasas Euríbor/T-Bill (paridad
            de tasas cubierta), la misma metodología que usan los ETFs hedged reales. Tanto la estrategia VIX timing
            como el benchmark de arriba invierten en esta versión mientras están en S&amp;P 500.
          </p>
        )}
        {!msciWorldAvailable && (
          <p style={ui.muted}>MSCI World no cubre todo el rango elegido, así que se omite de la comparación.</p>
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
        <h3 style={ui.cardTitle}>Rendimiento por año vs. {sp500Label}</h3>
        <p style={ui.cardSubtitle}>
          El mismo año calendario, comparado retorno contra retorno — no la curva acumulada de arriba, sino año por
          año, para ver en qué años concretos esta regla de VIX realmente pone o quita dinero frente a simplemente
          comprar y mantener.
        </p>

        <div
          style={{
            background: totalAlpha >= 0 ? colors.successSoft : colors.warningSoft,
            border: `1px solid ${colors.border}`,
            borderRadius: 10,
            padding: 16,
            marginBottom: 16,
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: 0.4,
              color: totalAlpha >= 0 ? colors.success : colors.warning,
            }}
          >
            En dinero ({firstYear}–{lastYear})
          </div>
          <p style={{ margin: "6px 0 8px 0", fontSize: 14 }}>
            $1 invertido en {firstYear} termina en <strong>${strategyTotalMultiple.toFixed(2)}</strong> con esta
            regla de VIX timing, frente a <strong>${sp500TotalMultiple.toFixed(2)}</strong> comprando y manteniendo{" "}
            {sp500Label}
            {" "}(
            <strong style={{ color: totalAlpha >= 0 ? colors.success : colors.danger }}>
              {totalAlpha >= 0 ? "+" : ""}
              {pct(totalAlpha)}
            </strong>{" "}
            de diferencia acumulada).
          </p>
          <p style={{ margin: 0, fontSize: 14 }}>
            Le ganó al benchmark en <strong>{winYears.length}</strong> de <strong>{yearlyRows.length}</strong> años (
            <strong>{pct(yearlyRows.length ? winYears.length / yearlyRows.length : null, 0)}</strong>). En los años
            que ganó, lo hizo por{" "}
            <strong style={{ color: colors.success }}>{avgWin !== null ? `+${pct(avgWin)}` : "—"}</strong> en
            promedio; en los que perdió, por{" "}
            <strong style={{ color: colors.danger }}>{avgLoss !== null ? pct(avgLoss) : "—"}</strong>. Perder menos
            años de los que gana no garantiza terminar arriba en dinero si esos años perdidos pesan más — esto es lo
            que realmente decide el resultado.
          </p>
          {winLossRatio !== null && (
            <p style={{ margin: "8px 0 0 0", fontSize: 14 }}>
              {avgLoss < 0 && avgWin >= 0 && Math.abs(avgLoss) > avgWin ? (
                <>
                  Acá la asimetría va al revés que en el filtro macro: cuando esta regla gana, gana por{" "}
                  {pct(avgWin)}; cuando pierde, pierde por {pct(Math.abs(avgLoss))} —{" "}
                  <strong>{(1 / winLossRatio).toFixed(1)}x</strong> más grande. Gana la mayoría de los años pero
                  pierde más en los años que pierde, y esa es la razón concreta por la que termina abajo en dinero.
                </>
              ) : (
                <>
                  Acá la asimetría favorece a la estrategia, igual que en el filtro macro: gana{" "}
                  <strong>{winLossRatio.toFixed(1)}x</strong> más de lo que pierde en promedio.
                </>
              )}
            </p>
          )}
          <p style={{ margin: "8px 0 0 0", fontSize: 14 }}>
            La sensación de "más tranquilo" tampoco es la misma cosa que "duele menos": la volatilidad anualizada de
            esta regla ({pct(stats.strategy.volatility)}) es {volLower ? "menor" : "mayor"} que la de {sp500Label} (
            {pct(stats.sp500.volatility)}) — se siente {volLower ? "más tranquila" : "más agitada"} día a día,
            sentada en monetario buena parte del tiempo — pero su máximo drawdown ({pct(stats.strategy.maxDrawdown)})
            es en realidad {drawdownWorse ? "peor" : "mejor"} que el de {sp500Label} (
            {pct(stats.sp500.maxDrawdown)}). {drawdownWorse
              ? "La calma cotidiana no se tradujo en menos dolor en el peor momento — entrar recién cuando el VIX ya está en pánico puede comprar justo antes de la última pierna de baja."
              : "Aquí sí se tradujo en menos dolor en el peor momento, no solo en menos ruido día a día."}
          </p>
        </div>

        <div style={ui.tableScroll}>
          <table style={ui.table}>
            <thead>
              <tr>
                <th style={ui.th}>Año</th>
                <th style={ui.th}>VIX timing</th>
                <th style={ui.th}>{sp500Label}</th>
                <th style={ui.th}>Diferencial</th>
              </tr>
            </thead>
            <tbody>
              {yearlyRows.map((r) => (
                <tr key={r.year}>
                  <td style={ui.td}>{r.year}</td>
                  <td style={ui.td}>{pct(r.strategyReturn)}</td>
                  <td style={ui.td}>{pct(r.sp500Return)}</td>
                  <td style={{ ...ui.td, color: r.diff >= 0 ? colors.success : colors.danger, fontWeight: 700 }}>
                    {r.diff >= 0 ? "+" : ""}
                    {pct(r.diff)}
                  </td>
                </tr>
              ))}
              <tr>
                <td
                  colSpan={4}
                  style={{
                    ...ui.td,
                    borderTop: `2px solid ${colors.border}`,
                    borderBottom: "none",
                    whiteSpace: "normal",
                  }}
                >
                  <div style={{ fontWeight: 700, color: colors.text }}>
                    {winYears.length}/{yearlyRows.length} years con diferencial positivo (
                    {yearlyRows.length ? Math.round((winYears.length / yearlyRows.length) * 100) : 0}%)
                  </div>
                  <div style={{ marginTop: 4, fontWeight: 700, color: totalAlpha >= 0 ? colors.success : colors.danger }}>
                    Alfa total generado: {totalAlpha >= 0 ? "+" : ""}
                    {pct(totalAlpha)}{" "}
                    <span style={{ fontWeight: 400, color: colors.textMuted }}>
                      (retorno acumulado en todo el período: VIX timing menos {sp500Label})
                    </span>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
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
                      {t.type === "EQUITY" ? (t.hedged ? "S&P 500 hedged" : "S&P 500") : `Monetario ${meta.currency}`}
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
  const isHedged = !!t.hedged;
  const exitLabel = t.open ? "Precio actual (operación abierta)" : "Fecha / precio de venta";
  const exitDate = t.open ? t.asOfDate : t.exitDate;
  const exitPrice = t.open ? t.asOfPrice : t.exitPrice;
  const fxExit = t.open ? t.fxAsOf : t.fxAtExit;

  return (
    <Drawer
      kicker="Auditoría del tramo"
      title={isHedged ? "S&P 500 EUR hedged (sintético)" : "Precios de compra y venta (SPY)"}
      subtitle={`VIX ${t.vixAtEntry?.toFixed(1)} en la entrada${t.open ? "" : ` · VIX ${t.vixAtExit?.toFixed(1)} en la salida`}`}
      onClose={onClose}
    >
      <table style={{ width: "100%", fontSize: 12.5, borderCollapse: "collapse" }}>
        <tbody>
          <tr>
            <td style={{ padding: "3px 0", color: colors.textMuted, width: "45%" }}>Fecha / precio de compra (SPY)</td>
            <td style={{ padding: "3px 0", textAlign: "right" }}>
              {formatDate(t.entryDate)} · <strong>{formatPrice(t.entryPrice)}</strong>
            </td>
          </tr>
          <tr>
            <td style={{ padding: "3px 0", color: colors.textMuted }}>{exitLabel} (SPY)</td>
            <td style={{ padding: "3px 0", textAlign: "right" }}>
              {formatDate(exitDate)} · <strong>{formatPrice(exitPrice)}</strong>
            </td>
          </tr>
          {isEur && !isHedged && (
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
      {isHedged ? (
        <p style={{ ...ui.muted, marginTop: 10, paddingTop: 10, borderTop: `1px dashed ${colors.border}` }}>
          El retorno del tramo ({pct(t.tradeReturn, 2)}) es el movimiento de SPY en USD más el diferencial de tasas
          Euríbor 3M / T-Bill 3M, capitalizado día a día (paridad de tasas cubierta) — no una fórmula de un solo
          paso, porque el diferencial varió a lo largo del tramo. Reemplaza el movimiento real de USD/EUR por el
          costo de cobertura implícito en esas tasas.
        </p>
      ) : (
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
      )}
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
