import { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { ui, colors, fonts } from "../theme.js";
import LineChart from "../LineChart.jsx";

const CURRENT_YEAR = new Date().getFullYear();
// The four core sleeves start ticked; the two listed variants (shorter history) are opt-in.
const DEFAULT_ON = new Set(["REAL_ESTATE", "PRIVATE_CREDIT", "INFRASTRUCTURE", "PRIVATE_EQUITY"]);

function pct(v, digits = 1) {
  return v === null || v === undefined || Number.isNaN(v) ? "—" : `${(v * 100).toFixed(digits)}%`;
}

// The backend only exposes year-END cumulative curves; each year's own return is the ratio of two
// consecutive points (same technique the other tabs use for their year-by-year tables).
function yearlyReturns(cumulative, keys) {
  const prev = Object.fromEntries(keys.map((k) => [k, 0]));
  return cumulative.map((c) => {
    const row = { year: c.year };
    for (const k of keys) {
      const cur = c[k];
      row[k] = cur === undefined || cur === null ? null : (1 + cur) / (1 + prev[k]) - 1;
      if (cur !== undefined && cur !== null) prev[k] = cur;
    }
    return row;
  });
}

function tone(v) {
  return v === null || v === undefined ? colors.textMuted : v >= 0 ? colors.success : colors.danger;
}

export default function IlliquidsTab({ setStatus, onResult }) {
  const [sleeves, setSleeves] = useState([]);
  const [on, setOn] = useState(DEFAULT_ON);
  const [weights, setWeights] = useState({});
  const [yearFrom, setYearFrom] = useState(2000);
  const [yearTo, setYearTo] = useState(CURRENT_YEAR - 1);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const list = await api.getIlliquidSleeves();
        setSleeves(list);
        setWeights(Object.fromEntries(list.map((s) => [s.key, 25])));
      } catch (e) {
        setStatus({ type: "error", text: `No se pudo cargar la lista de ilíquidos: ${e.message}` });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalWeight = useMemo(
    () => sleeves.filter((s) => on.has(s.key)).reduce((a, s) => a + (Number(weights[s.key]) || 0), 0),
    [sleeves, on, weights]
  );

  function toggle(key) {
    const next = new Set(on);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setOn(next);
  }

  async function run() {
    const chosen = sleeves.filter((s) => on.has(s.key) && Number(weights[s.key]) > 0);
    if (chosen.length === 0) {
      setStatus({ type: "error", text: "Elegí al menos un activo ilíquido con un peso mayor a 0." });
      return;
    }
    setLoading(true);
    setStatus(null);
    try {
      const res = await api.runIlliquidsPortfolio({
        yearFrom,
        yearTo,
        sleeves: chosen.map((s) => ({ key: s.key, weight: Number(weights[s.key]) })),
      });
      setResult(res);
      onResult?.(res);
    } catch (e) {
      setStatus({ type: "error", text: `No se pudo armar la cartera: ${e.message}` });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div style={ui.card}>
        <div style={ui.eyebrow}>Ilíquidos · proxies cotizados</div>
        <h2 style={{ ...ui.cardTitle, fontSize: "clamp(20px, 5.5vw, 26px)", fontWeight: 800, letterSpacing: "-0.02em", margin: "10px 0 12px" }}>
          Una cartera de activos ilíquidos, con precios reales
        </h2>
        <p style={ui.cardSubtitle}>
          Inmobiliario, crédito privado, infraestructura y capital privado no cotizan a diario: se valúan por tasación
          trimestral, y eso alisa las caídas. Por eso acá no se les asigna un rendimiento anual inventado: cada tipo
          de activo se representa con un <strong>proxy cotizado con precio diario real</strong> (el equivalente que sí
          cotiza), con rebalanceo cada enero. Además se calcula cómo se vería esa misma cartera en un reporte
          trimestral, para ver cuánto riesgo esconde la tasación.
        </p>

        <div style={ui.tableScroll}>
          <table style={ui.table}>
            <thead>
              <tr>
                <th style={ui.th}></th>
                <th style={ui.th}>Activo</th>
                <th style={ui.th}>Proxy cotizado</th>
                <th style={ui.th}>Peso (%)</th>
              </tr>
            </thead>
            <tbody>
              {sleeves.map((s) => (
                <tr key={s.key}>
                  <td style={ui.td}>
                    <input
                      type="checkbox"
                      checked={on.has(s.key)}
                      onChange={() => toggle(s.key)}
                      aria-label={`Incluir ${s.label}`}
                    />
                  </td>
                  <td style={{ ...ui.td, fontWeight: 700 }}>{s.label}</td>
                  <td style={{ ...ui.td, whiteSpace: "normal", minWidth: 260 }}>
                    <span style={{ fontFamily: fonts.mono, color: colors.primaryDark }}>{s.ticker}</span>
                    <div style={ui.muted}>{s.note}</div>
                  </td>
                  <td style={ui.td}>
                    <input
                      style={{ ...ui.input, width: 80 }}
                      type="number"
                      min={0}
                      value={weights[s.key] ?? 0}
                      disabled={!on.has(s.key)}
                      onChange={(e) => setWeights({ ...weights, [s.key]: e.target.value })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ ...ui.muted, marginTop: 8 }}>
          Suma de pesos: {totalWeight}% — no hace falta que sumen 100, se normalizan entre los marcados.
        </p>

        <div style={{ ...ui.form, marginTop: 12 }}>
          <label style={ui.label}>
            Año desde
            <input style={ui.input} type="number" value={yearFrom} onChange={(e) => setYearFrom(Number(e.target.value))} />
          </label>
          <label style={ui.label}>
            Año hasta
            <input style={ui.input} type="number" value={yearTo} onChange={(e) => setYearTo(Number(e.target.value))} />
          </label>
          <button style={ui.button("primary")} onClick={run} disabled={loading || sleeves.length === 0}>
            {loading ? "Calculando…" : "Armar cartera"}
          </button>
        </div>
      </div>

      {result && <IlliquidsResult result={result} />}
    </div>
  );
}

function IlliquidsResult({ result }) {
  const { meta, stats, cumulative, weekly, sleeveStats } = result;
  const keys = meta.sleeves.map((s) => `cumulative_${s.key}`);
  const rows = yearlyReturns(cumulative, ["cumulativeStrategy", "cumulativeReported", "cumulativeSp500", ...keys]);

  const series = [
    { key: "cumulativeStrategy", label: "Cartera (proxies, precio real)", color: colors.success, width: 3 },
    { key: "cumulativeReported", label: "Como se vería en un reporte trimestral", color: "#B48CFF", width: 1.8 },
    { key: "cumulativeSp500", label: "S&P 500 (referencia)", color: colors.warning, width: 1.8, dash: "5 4" },
  ];
  const useWeekly = weekly && weekly.length > 0;

  const tiles = [
    { label: "Retorno total · USD", value: pct(stats.strategy.totalReturn), vs: pct(stats.sp500.totalReturn), tone: tone(stats.strategy.totalReturn) },
    { label: "CAGR", value: pct(stats.strategy.cagr), vs: pct(stats.sp500.cagr), tone: colors.text },
    { label: "Volatilidad anualizada", value: pct(stats.strategy.volatility), vs: pct(stats.sp500.volatility), tone: colors.text },
    { label: "Máx. drawdown", value: pct(stats.strategy.maxDrawdown), vs: pct(stats.sp500.maxDrawdown), tone: colors.danger },
  ];

  const hiddenRisk =
    stats.strategy.volatility > 0 ? 1 - stats.reported.volatility / stats.strategy.volatility : null;

  return (
    <>
      <div style={ui.card}>
        <h3 style={ui.cardTitle}>
          Resultados {meta.effectiveYearFrom}–{meta.yearTo}
        </h3>
        <p style={ui.cardSubtitle}>
          Datos diarios reales de {meta.firstDay} a {meta.lastDay}, en USD.
          {meta.effectiveYearFrom > meta.yearFrom &&
            ` Arranca en ${meta.effectiveYearFrom} (no ${meta.yearFrom}) porque alguno de los proxies elegidos empieza a mitad de ese año y así el primer año no queda parcial.`}
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          {tiles.map((t) => (
            <div key={t.label} style={{ ...ui.statCard, flex: "1 1 200px", padding: "18px 20px" }}>
              <div style={ui.statLabel}>{t.label}</div>
              <div style={{ ...ui.statValue, fontSize: 30, color: t.tone }}>{t.value}</div>
              <div style={{ fontFamily: fonts.mono, fontSize: 12.5, color: colors.textMuted, marginTop: 8 }}>S&amp;P 500: {t.vs}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={ui.card}>
        <div style={ui.eyebrow}>Fig. 01</div>
        <h3 style={{ ...ui.cardTitle, margin: "6px 0 12px" }}>Rentabilidad acumulada</h3>
        <LineChart points={useWeekly ? weekly : cumulative} series={series} xKey={useWeekly ? "date" : "year"} />
      </div>

      <div style={ui.card}>
        <div style={ui.eyebrow}>Tabla 01</div>
        <h3 style={{ ...ui.cardTitle, margin: "6px 0 12px" }}>Precio real vs. reporte trimestral</h3>
        <div style={ui.tableScroll}>
          <table className="num-right" style={ui.table}>
            <thead>
              <tr>
                <th style={ui.th}>Serie</th>
                <th style={ui.th}>Retorno total</th>
                <th style={ui.th}>CAGR</th>
                <th style={ui.th}>Volatilidad</th>
                <th style={ui.th}>Máx. drawdown</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["Cartera (proxies, precio real)", stats.strategy],
                ["Como se vería en un reporte trimestral", stats.reported],
                ["S&P 500 (referencia)", stats.sp500],
              ].map(([label, s]) => (
                <tr key={label}>
                  <td style={ui.td}>{label}</td>
                  <td style={{ ...ui.td, color: tone(s.totalReturn), fontWeight: 700 }}>{pct(s.totalReturn)}</td>
                  <td style={{ ...ui.td, color: tone(s.cagr) }}>{pct(s.cagr)}</td>
                  <td style={ui.td}>{pct(s.volatility)}</td>
                  <td style={{ ...ui.td, color: colors.danger }}>{pct(s.maxDrawdown)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ ...ui.muted, marginTop: 8 }}>
          El reporte trimestral simula tasaciones: el valor solo cambia a fin de trimestre y reconoce el{" "}
          {Math.round(meta.appraisalAlpha * 100)}% de la diferencia con el valor real cada vez. Con esos supuestos la
          volatilidad que se vería es {pct(stats.reported.volatility)} contra {pct(stats.strategy.volatility)} reales
          {hiddenRisk !== null && hiddenRisk > 0 && ` — el reporte esconde cerca de ${Math.round(hiddenRisk * 100)}% del riesgo`}.
          El {Math.round(meta.appraisalAlpha * 100)}% es un supuesto, no un dato medido.
        </p>
      </div>

      <div style={ui.card}>
        <div style={ui.eyebrow}>Tabla 02</div>
        <h3 style={{ ...ui.cardTitle, margin: "6px 0 12px" }}>Cada activo por separado</h3>
        <div style={ui.tableScroll}>
          <table className="num-right-4" style={ui.table}>
            <thead>
              <tr>
                <th style={ui.th}>Activo</th>
                <th style={ui.th}>Proxy</th>
                <th style={ui.th}>Datos desde</th>
                <th style={ui.th}>Peso</th>
                <th style={ui.th}>Retorno total</th>
                <th style={ui.th}>CAGR</th>
                <th style={ui.th}>Volatilidad</th>
                <th style={ui.th}>Máx. drawdown</th>
              </tr>
            </thead>
            <tbody>
              {meta.sleeves.map((s) => {
                const st = sleeveStats[s.key];
                return (
                  <tr key={s.key}>
                    <td style={{ ...ui.td, fontWeight: 700 }}>{s.label}</td>
                    <td style={{ ...ui.td, fontFamily: fonts.mono }}>{s.ticker}</td>
                    <td style={ui.td}>{s.dataStart}</td>
                    <td style={ui.td}>{pct(s.weight, 0)}</td>
                    <td style={{ ...ui.td, color: tone(st.totalReturn) }}>{pct(st.totalReturn)}</td>
                    <td style={{ ...ui.td, color: tone(st.cagr) }}>{pct(st.cagr)}</td>
                    <td style={ui.td}>{pct(st.volatility)}</td>
                    <td style={{ ...ui.td, color: colors.danger }}>{pct(st.maxDrawdown)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div style={ui.card}>
        <div style={ui.eyebrow}>Tabla 03</div>
        <h3 style={{ ...ui.cardTitle, margin: "6px 0 12px" }}>Rentabilidad año a año</h3>
        <div style={ui.tableScroll}>
          <table className="num-right" style={ui.table}>
            <thead>
              <tr>
                <th style={ui.th}>Año</th>
                <th style={ui.th}>Cartera</th>
                <th style={ui.th}>Reporte trim.</th>
                {meta.sleeves.map((s) => (
                  <th key={s.key} style={ui.th}>
                    {s.label}
                  </th>
                ))}
                <th style={ui.th}>S&amp;P 500</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.year}>
                  <td style={ui.td}>{r.year}</td>
                  <td style={{ ...ui.td, color: tone(r.cumulativeStrategy), fontWeight: 700 }}>{pct(r.cumulativeStrategy)}</td>
                  <td style={{ ...ui.td, color: tone(r.cumulativeReported) }}>{pct(r.cumulativeReported)}</td>
                  {keys.map((k) => (
                    <td key={k} style={{ ...ui.td, color: tone(r[k]) }}>
                      {pct(r[k])}
                    </td>
                  ))}
                  <td style={{ ...ui.td, color: tone(r.cumulativeSp500) }}>{pct(r.cumulativeSp500)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
