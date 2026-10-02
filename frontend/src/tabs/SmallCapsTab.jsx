import { useState } from "react";
import { api } from "../api.js";
import { ui, colors, fonts } from "../theme.js";
import LineChart from "../LineChart.jsx";

const CURRENT_YEAR = new Date().getFullYear();

const ASSETS = [
  { key: "RUSSELL_2000", label: "Russell 2000 (IWM)" },
  { key: "INTL_SMALL", label: "Small caps internacionales (DFISX)" },
  { key: "GLOBAL_SMALL", label: "Small caps globales (50% Russell 2000 + 50% internacionales)" },
];

const DEFAULTS = {
  yearFrom: 2000,
  yearTo: CURRENT_YEAR - 1,
  asset: "RUSSELL_2000",
  spreadMax: -2,
  zMax: -0.5,
  rateMin: 3,
  enterAt: 2,
  exitAt: 1,
  confirmDays: 21,
  minBondYield: 4,
  bondMaturityYears: 10,
  holdToMaturity: false,
  sellOnSignal: false,
  yieldDropPp: 1.5,
};

const PARAM_LABELS = {
  spreadMax: "Umbral de ciclo (spread 10 años)",
  zMax: "Umbral de valor relativo (z-score)",
  rateMin: "Tasa mínima (fed funds)",
  enterAt: "Señales para entrar",
  exitAt: "Señales para salir",
  minBondYield: "Yield mínimo del bono",
  bondMaturity: "Vencimiento del bono",
  yieldDropPp: "Caída de yield para vender",
  holdToMaturity: "Mantener hasta el vencimiento",
  sellOnSignal: "Vender el bono si vuelve la señal",
  confirmDays: "Días de confirmación",
};

function pct(v, digits = 1) {
  return v === null || v === undefined || Number.isNaN(v) ? "—" : `${(v * 100).toFixed(digits)}%`;
}
function num(v, digits = 2) {
  return v === null || v === undefined || Number.isNaN(v) ? "—" : Number(v).toFixed(digits);
}
function tone(v) {
  return v === null || v === undefined ? colors.textMuted : v >= 0 ? colors.success : colors.danger;
}

function Field({ label, hint, children }) {
  return (
    <label style={{ ...ui.label, minWidth: 150, flex: "1 1 170px" }}>
      {label}
      {children}
      {hint && <span style={{ fontSize: 11.5, color: colors.textMuted }}>{hint}</span>}
    </label>
  );
}

function Histogram({ bins, markers = [], format = pct }) {
  const width = 640, height = 170, pad = { top: 12, bottom: 28, left: 8, right: 8 };
  const max = Math.max(...bins.map((b) => b.count), 1);
  const lo = bins[0].from, hi = bins[bins.length - 1].to;
  const x = (v) => pad.left + ((v - lo) / (hi - lo || 1)) * (width - pad.left - pad.right);
  const bw = (width - pad.left - pad.right) / bins.length;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: "auto", display: "block" }}>
      {bins.map((b, i) => {
        const h = (b.count / max) * (height - pad.top - pad.bottom);
        return (
          <rect key={i} x={pad.left + i * bw + 1} y={height - pad.bottom - h} width={Math.max(bw - 2, 1)} height={h} fill={colors.primary} opacity={0.75}>
            <title>{`${format(b.from)} a ${format(b.to)}: ${b.count}`}</title>
          </rect>
        );
      })}
      <line x1={pad.left} x2={width - pad.right} y1={height - pad.bottom} y2={height - pad.bottom} stroke={colors.text} />
      {markers
        .filter((m) => m.value >= lo && m.value <= hi)
        .map((m, i) => (
          <g key={i}>
            <line x1={x(m.value)} x2={x(m.value)} y1={pad.top} y2={height - pad.bottom} stroke={m.color} strokeWidth={2} strokeDasharray="4 3" />
            <text x={x(m.value)} y={pad.top + 9 + i * 12} fontSize="10.5" fill={m.color} textAnchor={x(m.value) > width / 2 ? "end" : "start"} dx={x(m.value) > width / 2 ? -4 : 4}>
              {m.label}
            </text>
          </g>
        ))}
      <text x={pad.left} y={height - 8} fontSize="11" fill={colors.textMuted}>{format(lo)}</text>
      <text x={width - pad.right} y={height - 8} fontSize="11" fill={colors.textMuted} textAnchor="end">{format(hi)}</text>
    </svg>
  );
}

export default function SmallCapsTab({ setStatus, onResult }) {
  const [form, setForm] = useState(DEFAULTS);
  const [result, setResult] = useState(null);
  const [mc, setMc] = useState(null);
  const [bs, setBs] = useState(null);
  const [loading, setLoading] = useState("");
  const [runs, setRuns] = useState(300);
  const [paths, setPaths] = useState(2000);
  const [block, setBlock] = useState(12);
  const [seed, setSeed] = useState(42);

  const set = (k) => (e) => {
    const t = e.target;
    setForm({ ...form, [k]: t.type === "checkbox" ? t.checked : t.type === "number" ? Number(t.value) : t.value });
  };

  async function call(kind, fn, setter) {
    setLoading(kind);
    setStatus(null);
    try {
      const res = await fn({ ...form, n: kind === "mc" ? runs : paths, seed, blockMonths: block });
      setter(res);
      return res;
    } catch (e) {
      setStatus({ type: "error", text: `${kind === "run" ? "El backtest" : kind === "mc" ? "El Monte Carlo" : "El bootstrap"} falló: ${e.message}` });
      return null;
    } finally {
      setLoading("");
    }
  }

  async function run() {
    setMc(null);
    setBs(null);
    const res = await call("run", api.runSmallCapsBacktest, setResult);
    if (res) onResult?.(res);
  }

  return (
    <div>
      <div style={ui.card}>
        <div style={ui.eyebrow}>Small caps · ciclo, tasas y valor</div>
        <h2 style={{ ...ui.cardTitle, fontSize: "clamp(20px, 5.5vw, 26px)", fontWeight: 800, letterSpacing: "-0.02em", margin: "10px 0 12px" }}>
          Small caps cuando el ciclo, las tasas y el valor acompañan; bonos AAA cuando no
        </h2>
        <p style={ui.cardSubtitle}>
          Basada en «Small Caps vs. Large Caps: The Cycle That's About to Turn» (Daniel Fang, CFA — CFA Institute,
          Enterprising Investor, abril 2025). El paper defiende small caps con tres argumentos y cada uno es una señal
          acá: <strong>(1) todos los ciclos terminan</strong> (las small caps rinden peor que las large durante ~9 años
          y luego se revierte) → spread de retorno a 10 años del Russell 2000 contra el S&amp;P 500, más un z-score de
          valor relativo; <strong>(2) las tasas altas favorecen</strong> a las small caps (el paper habla de tasas por
          encima de ~3%) → fed funds; <strong>(3) valor y calidad</strong> (P/B y ROA) — no hay datos históricos
          gratuitos de fundamentales, así que el z-score es el sustituto más cercano de «barata», y la calidad no se
          modela.
        </p>
        <p style={ui.cardSubtitle}>
          Cuando suficientes señales están encendidas se mantiene el activo small cap. Cuando se apagan, compra un bono
          AAA (yield de Moody's Aaa) si rinde al menos el mínimo que elijas, o se queda en letras del Tesoro si no. El
          bono se mantiene hasta el vencimiento o se vende antes si el yield cayó mucho (el precio subió). Cada decisión
          usa el cierre del día y rige desde el siguiente.
        </p>

        <div style={{ ...ui.form, alignItems: "flex-start" }}>
          <Field label="Activo small cap">
            <select style={ui.input} value={form.asset} onChange={set("asset")}>
              {ASSETS.map((a) => (
                <option key={a.key} value={a.key}>{a.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Año desde">
            <input style={ui.input} type="number" value={form.yearFrom} onChange={set("yearFrom")} />
          </Field>
          <Field label="Año hasta">
            <input style={ui.input} type="number" value={form.yearTo} onChange={set("yearTo")} />
          </Field>
        </div>

        <div style={{ ...ui.eyebrow, margin: "18px 0 8px" }}>Señales de entrada</div>
        <div style={{ ...ui.form, alignItems: "flex-start" }}>
          <Field label="Ciclo: spread 10 años ≤ (pp/año)" hint="Russell 2000 − S&P 500, anualizado. Más negativo = exige que las small caps hayan perdido más.">
            <input style={ui.input} type="number" step="0.5" value={form.spreadMax} onChange={set("spreadMax")} />
          </Field>
          <Field label="Valor relativo: z-score ≤" hint="Qué tan baratas están contra su propia historia de 10 años.">
            <input style={ui.input} type="number" step="0.1" value={form.zMax} onChange={set("zMax")} />
          </Field>
          <Field label="Tasas: fed funds ≥ (%)" hint="El paper: por encima de ~3% favorece.">
            <input style={ui.input} type="number" step="0.25" value={form.rateMin} onChange={set("rateMin")} />
          </Field>
          <Field label="Entrar con ≥ señales (de 3)">
            <select style={ui.input} value={form.enterAt} onChange={set("enterAt")}>
              {[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </Field>
          <Field label="Salir con ≤ señales" hint="Menor que 'entrar' deja una banda para no entrar y salir seguido.">
            <select style={ui.input} value={form.exitAt} onChange={set("exitAt")}>
              {[0, 1, 2].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </Field>
          <Field label="Confirmar cambio (días hábiles)" hint="Un cambio de señal debe sostenerse tantos días.">
            <input style={ui.input} type="number" min="1" value={form.confirmDays} onChange={set("confirmDays")} />
          </Field>
        </div>

        <div style={{ ...ui.eyebrow, margin: "18px 0 8px" }}>Renta fija (cuando se sale de small caps)</div>
        <div style={{ ...ui.form, alignItems: "flex-start" }}>
          <Field label="Yield AAA mínimo para comprar (%)" hint="Por debajo se queda en letras del Tesoro.">
            <input style={ui.input} type="number" step="0.25" value={form.minBondYield} onChange={set("minBondYield")} />
          </Field>
          <Field label="Vencimiento del bono (años)">
            <input style={ui.input} type="number" min="1" max="30" value={form.bondMaturityYears} onChange={set("bondMaturityYears")} />
          </Field>
          <Field label="Vender si el yield cae (pts)" hint="0 = nunca. Se vende con ganancia de precio.">
            <input style={ui.input} type="number" step="0.25" min="0" value={form.yieldDropPp} onChange={set("yieldDropPp")} disabled={form.holdToMaturity} />
          </Field>
          <label style={{ ...ui.label, flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44 }}>
            <input type="checkbox" checked={form.holdToMaturity} onChange={set("holdToMaturity")} />
            Mantener hasta el vencimiento
          </label>
          <label style={{ ...ui.label, flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44 }}>
            <input type="checkbox" checked={form.sellOnSignal} onChange={set("sellOnSignal")} disabled={form.holdToMaturity} />
            Vender el bono si vuelve la señal
          </label>
        </div>

        <div style={{ marginTop: 16 }}>
          <button style={ui.button("primary")} onClick={run} disabled={!!loading}>
            {loading === "run" ? "Calculando…" : "Correr backtest"}
          </button>
        </div>
      </div>

      {result && (
        <>
          <ResultView result={result} />

          <div style={ui.card}>
            <div style={ui.eyebrow}>Monte Carlo · robustez de los parámetros</div>
            <h3 style={{ ...ui.cardTitle, margin: "6px 0 8px" }}>¿Qué pasa si los parámetros fueran otros?</h3>
            <p style={ui.cardSubtitle}>
              Sortea configuraciones al azar (umbrales, cantidad de señales, vencimiento, reglas de venta) y corre el
              backtest completo con cada una. Sirve para ver si el resultado depende de haber elegido justo estos
              números, y cuáles variables importan de verdad.
            </p>
            <div style={ui.form}>
              <Field label="Configuraciones"><input style={ui.input} type="number" min="50" max="1000" value={runs} onChange={(e) => setRuns(Number(e.target.value))} /></Field>
              <Field label="Semilla"><input style={ui.input} type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} /></Field>
              <button style={ui.button("secondary")} onClick={() => call("mc", api.runSmallCapsMonteCarlo, setMc)} disabled={!!loading}>
                {loading === "mc" ? "Simulando…" : "Correr Monte Carlo"}
              </button>
            </div>
            {mc && <MonteCarloView mc={mc} />}
          </div>

          <div style={ui.card}>
            <div style={ui.eyebrow}>Bootstrap · ¿es suerte?</div>
            <h3 style={{ ...ui.cardTitle, margin: "6px 0 8px" }}>Remuestreo de los retornos mensuales</h3>
            <p style={ui.cardSubtitle}>
              Toma los retornos mensuales reales de la estrategia y del activo, los remuestrea en bloques (para conservar
              la persistencia de los mercados) y arma miles de historias alternativas del mismo largo. Para cada una mide
              si la estrategia le gana al activo. Dice cuánto del resultado histórico es robusto y cuánto puede ser suerte
              del camino. Los parámetros se mantienen: el bootstrap mide el azar de los datos, no del diseño.
            </p>
            <div style={ui.form}>
              <Field label="Trayectorias"><input style={ui.input} type="number" min="200" max="20000" value={paths} onChange={(e) => setPaths(Number(e.target.value))} /></Field>
              <Field label="Bloque (meses)"><input style={ui.input} type="number" min="1" max="36" value={block} onChange={(e) => setBlock(Number(e.target.value))} /></Field>
              <Field label="Semilla"><input style={ui.input} type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} /></Field>
              <button style={ui.button("secondary")} onClick={() => call("bs", api.runSmallCapsBootstrap, setBs)} disabled={!!loading}>
                {loading === "bs" ? "Remuestreando…" : "Correr bootstrap"}
              </button>
            </div>
            {bs && <BootstrapView bs={bs} />}
          </div>
        </>
      )}
    </div>
  );
}

function Pill({ on, children }) {
  return <span style={ui.badge(on ? "success" : "neutral")}>{children}</span>;
}

function ResultView({ result }) {
  const { meta, stats, cumulative, weekly, timeInState, segments, currentRead: r } = result;
  const series = [
    { key: "cumulativeStrategy", label: "Estrategia", color: colors.success, width: 3 },
    { key: "cumulativeAsset", label: `${meta.assetLabel} (comprar y mantener)`, color: colors.primary, width: 1.8 },
    { key: "cumulativeSp500", label: "S&P 500 (referencia)", color: colors.warning, width: 1.8, dash: "5 4" },
  ];
  const useWeekly = weekly && weekly.length > 0;
  const tiles = [
    { label: "Retorno total · USD", v: pct(stats.strategy.totalReturn), vs: pct(stats.asset.totalReturn), tone: tone(stats.strategy.totalReturn) },
    { label: "CAGR", v: pct(stats.strategy.cagr), vs: pct(stats.asset.cagr), tone: colors.text },
    { label: "Volatilidad anualizada", v: pct(stats.strategy.volatility), vs: pct(stats.asset.volatility), tone: colors.text },
    { label: "Máx. drawdown", v: pct(stats.strategy.maxDrawdown), vs: pct(stats.asset.maxDrawdown), tone: colors.danger },
  ];
  const posLabel = { EQUITY: "En small caps", BOND: "En bono AAA", CASH: "En letras del Tesoro" }[r.position];

  return (
    <>
      <div style={ui.card}>
        <div style={ui.eyebrow}>Lectura de hoy · {r.date}</div>
        <h3 style={{ ...ui.cardTitle, margin: "6px 0 12px" }}>
          {r.signalOn ? "Señal encendida" : "Señal apagada"} — {posLabel}
        </h3>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          {[
            { name: "Ciclo", value: r.spread10y === null ? "—" : `${num(r.spread10y)} pp/año`, on: r.spreadOn, note: "spread 10 años" },
            { name: "Valor relativo", value: num(r.zScore), on: r.zOn, note: "z-score" },
            { name: "Tasas", value: r.fedFunds === null ? "—" : `${num(r.fedFunds)}%`, on: r.rateOn, note: "fed funds" },
          ].map((c) => (
            <div key={c.name} style={{ ...ui.statCard, flex: "1 1 190px", padding: "14px 16px" }}>
              <div style={ui.statLabel}>{c.name} · {c.note}</div>
              <div style={{ ...ui.statValue, fontSize: 22 }}>{c.value}</div>
              <div style={{ marginTop: 8 }}><Pill on={c.on}>{c.on ? "Encendida" : "Apagada"}</Pill></div>
            </div>
          ))}
          <div style={{ ...ui.statCard, flex: "1 1 190px", padding: "14px 16px" }}>
            <div style={ui.statLabel}>Yield Aaa hoy</div>
            <div style={{ ...ui.statValue, fontSize: 22 }}>{r.aaaYield === null ? "—" : `${num(r.aaaYield)}%`}</div>
            <div style={{ ...ui.muted, marginTop: 8 }}>{r.score} de 3 señales</div>
          </div>
        </div>
      </div>

      <div style={ui.card}>
        <h3 style={ui.cardTitle}>Resultados {meta.effectiveYearFrom}–{meta.yearTo}</h3>
        <p style={ui.cardSubtitle}>
          {meta.assetLabel} · datos diarios reales de {meta.firstDay} a {meta.lastDay}, en USD
          {meta.effectiveYearFrom > meta.yearFrom && ` — arranca en ${meta.effectiveYearFrom} porque ${meta.assetTickers} empieza a mitad de ${meta.effectiveYearFrom - 1}`}.
          Debajo de cada cifra, la del activo comprado y mantenido.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          {tiles.map((t) => (
            <div key={t.label} style={{ ...ui.statCard, flex: "1 1 200px", padding: "18px 20px" }}>
              <div style={ui.statLabel}>{t.label}</div>
              <div style={{ ...ui.statValue, fontSize: 30, color: t.tone }}>{t.v}</div>
              <div style={{ fontFamily: fonts.mono, fontSize: 12.5, color: colors.textMuted, marginTop: 8 }}>Activo: {t.vs}</div>
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
        <h3 style={{ ...ui.cardTitle, margin: "6px 0 12px" }}>Estrategia contra comprar y mantener</h3>
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
                ["Estrategia", stats.strategy],
                [meta.assetLabel, stats.asset],
                ["S&P 500", stats.sp500],
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
        <div style={{ display: "flex", height: 10, borderRadius: 999, overflow: "hidden", gap: 2, marginTop: 16 }} role="img" aria-label="Tiempo en cada posición">
          <div style={{ flex: timeInState.equity, background: colors.success }} />
          <div style={{ flex: timeInState.bond, background: colors.primary }} />
          <div style={{ flex: timeInState.cash, background: colors.textMuted }} />
        </div>
        <p style={{ ...ui.muted, marginTop: 8 }}>
          Tiempo en small caps {pct(timeInState.equity, 0)} · bono AAA {pct(timeInState.bond, 0)} · letras del Tesoro{" "}
          {pct(timeInState.cash, 0)} · {meta.bondsBought} bono(s) comprado(s). El bono se valúa a mercado todos los días
          con el yield Aaa de Moody's (un índice de vencimiento largo) aplicado al vencimiento que elijas: es una
          aproximación, y si lo mantienes hasta el vencimiento cobra exactamente el yield con que lo compraste.
        </p>
      </div>

      <div style={ui.card}>
        <div style={ui.eyebrow}>Tabla 02</div>
        <h3 style={{ ...ui.cardTitle, margin: "6px 0 12px" }}>Posiciones tomadas</h3>
        <div style={ui.tableScroll}>
          <table style={ui.table}>
            <thead>
              <tr>
                <th style={ui.th}>Posición</th>
                <th style={ui.th}>Entrada</th>
                <th style={ui.th}>Salida</th>
                <th style={ui.th}>Motivo de salida</th>
                <th style={{ ...ui.th, textAlign: "right" }}>Retorno</th>
              </tr>
            </thead>
            <tbody>
              {segments.map((s, i) => (
                <tr key={i}>
                  <td style={ui.td}>
                    <span style={ui.badge(s.type === "EQUITY" ? "success" : s.type === "BOND" ? "primary" : "neutral")}>
                      {s.type === "EQUITY" ? "Small caps" : s.type === "BOND" ? "Bono AAA" : "Letras"}
                    </span>
                    {s.note && <span style={{ ...ui.muted, marginLeft: 8 }}>{s.note}</span>}
                  </td>
                  <td style={ui.td}>{s.entryDate}</td>
                  <td style={ui.td}>{s.exitDate ?? "abierta"}</td>
                  <td style={{ ...ui.td, whiteSpace: "normal", minWidth: 200 }}>{s.exitReason}</td>
                  <td style={{ ...ui.td, textAlign: "right", color: tone(s.return), fontWeight: 700 }}>{pct(s.return)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function MonteCarloView({ mc }) {
  const rows = [
    ["CAGR", mc.cagr, pct],
    ["Volatilidad", mc.volatility, pct],
    ["Máx. drawdown", mc.drawdown, pct],
    ["CAGR ÷ volatilidad", mc.sharpe, (v) => num(v)],
    ["Tiempo en small caps", mc.equityShare, (v) => pct(v, 0)],
  ];
  const sens = [...mc.sensitivity].sort((a, b) => Math.abs(b.corrSharpe) - Math.abs(a.corrSharpe));
  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {[
          { label: "Superan al activo en CAGR", v: pct(mc.shareBeatCagr, 0) },
          { label: "Tienen menor drawdown", v: pct(mc.shareBetterDrawdown, 0) },
          { label: "Ambas cosas", v: pct(mc.shareBeatBoth, 0) },
          { label: "Tu configuración, por CAGR ÷ vol.", v: `percentil ${Math.round(mc.baseSharpePercentile * 100)}` },
        ].map((t) => (
          <div key={t.label} style={{ ...ui.statCard, flex: "1 1 200px", padding: "16px 18px" }}>
            <div style={ui.statLabel}>{t.label}</div>
            <div style={{ ...ui.statValue, fontSize: 26 }}>{t.v}</div>
          </div>
        ))}
      </div>
      <p style={{ ...ui.muted, marginTop: 10 }}>
        De {mc.meta.runs} configuraciones al azar. Comprar y mantener el activo: CAGR {pct(mc.assetCagr)}, drawdown{" "}
        {pct(mc.assetDrawdown)}. Muchas configuraciones aleatorias casi nunca compran small caps (umbrales exigentes):
        por eso la mayoría rinde menos en CAGR pero con mucho menos riesgo.
      </p>

      <div style={{ ...ui.eyebrow, margin: "18px 0 8px" }}>Distribución del CAGR</div>
      <Histogram
        bins={mc.cagrHistogram}
        markers={[
          { value: mc.assetCagr, label: "activo", color: colors.warning },
          { value: mc.baseCagr, label: "tu config.", color: colors.success },
        ]}
      />

      <div style={{ ...ui.tableScroll, marginTop: 16 }}>
        <table className="num-right" style={ui.table}>
          <thead>
            <tr>
              <th style={ui.th}>Métrica</th>
              {["5%", "25%", "mediana", "75%", "95%"].map((h) => <th key={h} style={ui.th}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, d, f]) => (
              <tr key={label}>
                <td style={ui.td}>{label}</td>
                {[d.p5, d.p25, d.p50, d.p75, d.p95].map((v, i) => <td key={i} style={ui.td}>{f(v)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ ...ui.eyebrow, margin: "22px 0 8px" }}>Qué variables importan</div>
      <div style={ui.tableScroll}>
        <table className="num-right" style={ui.table}>
          <thead>
            <tr>
              <th style={ui.th}>Variable</th>
              <th style={ui.th}>Corr. con CAGR</th>
              <th style={ui.th}>Corr. con CAGR ÷ vol.</th>
              <th style={ui.th}>Corr. con drawdown</th>
            </tr>
          </thead>
          <tbody>
            {sens.map((s) => (
              <tr key={s.param}>
                <td style={ui.td}>{PARAM_LABELS[s.param] ?? s.param}</td>
                <td style={{ ...ui.td, color: tone(s.corrCagr) }}>{num(s.corrCagr)}</td>
                <td style={{ ...ui.td, color: tone(s.corrSharpe) }}>{num(s.corrSharpe)}</td>
                <td style={{ ...ui.td, color: tone(s.corrDrawdown) }}>{num(s.corrDrawdown)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ ...ui.muted, marginTop: 8 }}>
        Correlación de rangos (Spearman) entre el valor de la variable y el resultado, sobre todas las configuraciones
        sorteadas. Cerca de 0: esa variable casi no mueve el resultado; cerca de ±1: lo mueve mucho. Un drawdown menos
        negativo es «mejor», por eso una correlación positiva con drawdown es buena.
      </p>

      <div style={{ ...ui.eyebrow, margin: "22px 0 8px" }}>Las 10 mejores (por CAGR ÷ vol.)</div>
      <div style={ui.tableScroll}>
        <table className="num-right" style={ui.table}>
          <thead>
            <tr>
              <th style={ui.th}>#</th>
              <th style={ui.th}>Ciclo ≤</th>
              <th style={ui.th}>z ≤</th>
              <th style={ui.th}>Tasa ≥</th>
              <th style={ui.th}>Entra/Sale</th>
              <th style={ui.th}>Bono mín.</th>
              <th style={ui.th}>Venc.</th>
              <th style={ui.th}>% small caps</th>
              <th style={ui.th}>CAGR</th>
              <th style={ui.th}>Vol.</th>
              <th style={ui.th}>Drawdown</th>
            </tr>
          </thead>
          <tbody>
            {mc.top.map((t, i) => (
              <tr key={i}>
                <td style={ui.td}>{i + 1}</td>
                <td style={ui.td}>{num(t.spreadMax, 1)}</td>
                <td style={ui.td}>{num(t.zMax, 1)}</td>
                <td style={ui.td}>{num(t.rateMin, 1)}</td>
                <td style={ui.td}>{t.enterAt}/{t.exitAt}</td>
                <td style={ui.td}>{num(t.minBondYield, 1)}%</td>
                <td style={ui.td}>{t.bondMaturity}a</td>
                <td style={ui.td}>{pct(t.equityShare, 0)}</td>
                <td style={{ ...ui.td, color: tone(t.cagr) }}>{pct(t.cagr)}</td>
                <td style={ui.td}>{pct(t.volatility)}</td>
                <td style={{ ...ui.td, color: colors.danger }}>{pct(t.maxDrawdown)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ ...ui.muted, marginTop: 8 }}>
        Solo se ranquean las configuraciones que pasan al menos {pct(mc.meta.minEquityShare, 0)} del tiempo en small
        caps ({mc.meta.eligibleForRanking} de {mc.meta.runs}); una que casi no compra acciones es un fondo de bonos con
        una razón CAGR ÷ vol. engañosa. Las mejores de un sorteo son, por construcción, las más afortunadas: sirven
        para ver qué zona de parámetros funciona, no para tomarlas como la config. «óptima».
      </p>
    </div>
  );
}

function BootstrapView({ bs }) {
  const rows = [
    ["CAGR · estrategia", bs.cagrStrategy, pct],
    ["CAGR · activo", bs.cagrAsset, pct],
    ["CAGR · diferencia", bs.cagrDifference, pct],
    ["Máx. drawdown · estrategia", bs.drawdownStrategy, pct],
    ["Máx. drawdown · activo", bs.drawdownAsset, pct],
    ["Volatilidad · estrategia", bs.volatilityStrategy, pct],
    ["Volatilidad · activo", bs.volatilityAsset, pct],
  ];
  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {[
          { label: "Prob. de superar al activo (CAGR)", v: pct(bs.probBeatCagr, 0) },
          { label: "Prob. de menor drawdown", v: pct(bs.probBetterDrawdown, 0) },
          { label: "Prob. de ambas", v: pct(bs.probBeatBoth, 0) },
          { label: "Prob. de terminar en pérdida", v: pct(bs.probLoss, 0) },
        ].map((t) => (
          <div key={t.label} style={{ ...ui.statCard, flex: "1 1 200px", padding: "16px 18px" }}>
            <div style={ui.statLabel}>{t.label}</div>
            <div style={{ ...ui.statValue, fontSize: 26 }}>{t.v}</div>
          </div>
        ))}
      </div>
      <p style={{ ...ui.muted, marginTop: 10 }}>
        {bs.meta.paths} trayectorias de {bs.meta.months} meses, en bloques de {bs.meta.blockMonths} meses.
      </p>

      <div style={{ ...ui.eyebrow, margin: "18px 0 8px" }}>Diferencia de CAGR (estrategia − activo)</div>
      <Histogram bins={bs.differenceHistogram} markers={[{ value: 0, label: "empate", color: colors.warning }]} />

      <div style={{ ...ui.tableScroll, marginTop: 16 }}>
        <table className="num-right" style={ui.table}>
          <thead>
            <tr>
              <th style={ui.th}>Métrica</th>
              {["5%", "25%", "mediana", "75%", "95%"].map((h) => <th key={h} style={ui.th}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, d, f]) => (
              <tr key={label}>
                <td style={ui.td}>{label}</td>
                {[d.p5, d.p25, d.p50, d.p75, d.p95].map((v, i) => <td key={i} style={ui.td}>{f(v)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ ...ui.muted, marginTop: 8 }}>
        Si «superar al activo» queda cerca de 50%, el exceso de rendimiento histórico no se distingue del azar del
        camino; lo que sí suele mantenerse es la reducción del drawdown. Los remuestreos usan los mismos meses para la
        estrategia y para el activo, así que conservan cómo se mueven juntos.
      </p>
    </div>
  );
}
