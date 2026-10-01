import { useEffect, useRef, useState } from "react";
import { colors } from "./theme.js";

// Two cumulative-return curves (strategy vs. benchmark) over years. Plain
// SVG, no charting library — consistent with the rest of this app's charts.
// Clicking a point pins a small readout with every series' value for that
// x (year) — the native <title> hover tooltip alone doesn't work on touch
// and disappears the moment you move the mouse, so a click-to-pin readout
// lets you actually read the numbers. Clicking a LEGEND entry instead toggles
// that series off the chart (line, points, y-axis scale all recompute without
// it) — lets you isolate one or two curves out of a crowded chart without
// re-running anything; click it again to bring it back.
export default function LineChart({ points, series, xKey = "year" }) {
  // The SVG's coordinate width follows the real container width (not a fixed 640), so axis text stays
  // ~11px on a phone instead of shrinking with the viewBox. The legend is plain HTML above the SVG:
  // it wraps to as many rows as it needs instead of overflowing one row of fixed-width slots.
  const wrapRef = useRef(null);
  const [measured, setMeasured] = useState(640);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(([entry]) => setMeasured(Math.max(280, Math.round(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const width = measured;
  const height = measured < 480 ? 260 : 240;
  const padding = { top: 16, right: 16, bottom: 28, left: measured < 480 ? 46 : 56 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const [activeIndex, setActiveIndex] = useState(null);
  const [hiddenKeys, setHiddenKeys] = useState(() => new Set());

  if (!points || points.length === 0) {
    return (
      <div ref={wrapRef} style={{ color: colors.textMuted, fontSize: 13 }}>
        Sin datos suficientes.
      </div>
    );
  }

  function toggleSeries(key) {
    setHiddenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const visibleSeries = series.filter((s) => !hiddenKeys.has(s.key));

  // xKey can be a plain year number (every other chart in this app) or an ISO date string (the
  // Portfolio Calculator's weekly-resolution charts) — converted to a timestamp for the actual
  // scale math, but the raw value is still what gets shown as the axis/tooltip label.
  const toNum = (v) => (typeof v === "string" ? new Date(v).getTime() : v);
  const xs = points.map((p) => toNum(p[xKey]));
  const allYs = points.flatMap((p) => visibleSeries.map((s) => p[s.key]).filter((v) => v !== null && v !== undefined));
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...allYs, 0);
  const yMax = Math.max(...allYs, 0);
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;

  const sx = (v) => padding.left + ((toNum(v) - xMin) / xRange) * plotWidth;
  const sy = (v) => padding.top + plotHeight - ((v - yMin) / yRange) * plotHeight;
  const zeroY = yMin <= 0 && yMax >= 0 ? sy(0) : null;

  const activePoint = activeIndex !== null ? points[activeIndex] : null;

  // Dense series (weekly data: ~1,300 points) would mean thousands of <circle> nodes — draw dots only
  // when sparse, and let a click anywhere on the plot pick the nearest x instead.
  const showDots = points.length <= 120;
  function pickNearest(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const xSvg = ((e.clientX - rect.left) / rect.width) * width;
    let best = 0;
    let bestD = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(sx(p[xKey]) - xSvg);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    setActiveIndex(activeIndex === best ? null : best);
  }

  return (
    <div ref={wrapRef} style={{ width: "100%" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        {series.map((s) => {
          const isHidden = hiddenKeys.has(s.key);
          return (
            <button
              key={s.key}
              type="button"
              aria-pressed={!isHidden}
              onClick={() => toggleSeries(s.key)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                padding: "5px 11px",
                borderRadius: 999,
                border: `1px solid ${colors.border}`,
                background: isHidden ? "transparent" : colors.surfaceAlt,
                color: isHidden ? colors.textMuted : colors.text,
                textDecoration: isHidden ? "line-through" : "none",
                fontFamily: "inherit",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              <span
                style={{
                  width: 16,
                  height: 0,
                  borderTop: `${Math.min(s.width ?? 2, 3)}px ${s.dash ? "dashed" : "solid"} ${isHidden ? colors.border : s.color}`,
                }}
              />
              {s.label}
            </button>
          );
        })}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: "auto", display: "block" }}>
        {zeroY !== null && (
          <line x1={padding.left} y1={zeroY} x2={width - padding.right} y2={zeroY} stroke={colors.border} strokeDasharray="3 3" />
        )}
        <line x1={padding.left} y1={padding.top} x2={padding.left} y2={height - padding.bottom} stroke={colors.text} />
        <line x1={padding.left} y1={height - padding.bottom} x2={width - padding.right} y2={height - padding.bottom} stroke={colors.text} />
        <rect
          x={padding.left}
          y={padding.top}
          width={plotWidth}
          height={plotHeight}
          fill="transparent"
          style={{ cursor: "crosshair" }}
          onClick={pickNearest}
        />

        {visibleSeries.map((s) => {
          const path = points
            .filter((p) => p[s.key] !== null && p[s.key] !== undefined)
            .map((p, i) => `${i === 0 ? "M" : "L"} ${sx(p[xKey])} ${sy(p[s.key])}`)
            .join(" ");
          return (
            <g key={s.key} style={{ pointerEvents: "none" }}>
              <path
                d={path}
                fill="none"
                stroke={s.color}
                strokeWidth={s.width ?? 2}
                strokeDasharray={s.dash}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {showDots &&
                points.map((p, i) =>
                  p[s.key] === null || p[s.key] === undefined ? null : (
                    <circle key={i} cx={sx(p[xKey])} cy={sy(p[s.key])} r={activeIndex === i ? 4 : 2.5} fill={s.color}>
                      <title>
                        {s.label} {p[xKey]}: {(p[s.key] * 100).toFixed(1)}%
                      </title>
                    </circle>
                  )
                )}
            </g>
          );
        })}

        {/* X axis labels: first, middle, last */}
        {[points[0], points[Math.floor(points.length / 2)], points[points.length - 1]].map((p, i) => (
          <text key={i} x={sx(p[xKey])} y={height - padding.bottom + 16} fontSize="11" fill={colors.textMuted} textAnchor="middle">
            {p[xKey]}
          </text>
        ))}
        {/* Y axis labels */}
        <text x={padding.left - 6} y={padding.top + 4} fontSize="11" fill={colors.textMuted} textAnchor="end">
          {(yMax * 100).toFixed(0)}%
        </text>
        <text x={padding.left - 6} y={height - padding.bottom} fontSize="11" fill={colors.textMuted} textAnchor="end">
          {(yMin * 100).toFixed(0)}%
        </text>

        {activePoint && (
          <PointReadout
            x={sx(activePoint[xKey])}
            label={activePoint[xKey]}
            rows={visibleSeries
              .filter((s) => activePoint[s.key] !== null && activePoint[s.key] !== undefined)
              .map((s) => ({ label: s.label, color: s.color, value: activePoint[s.key] }))}
            width={width}
            padding={padding}
            onClose={() => setActiveIndex(null)}
          />
        )}
      </svg>
    </div>
  );
}

// Small pinned box (year + one line per series' % value) anchored above the
// clicked point, clamped so it never runs off either edge of the chart.
function PointReadout({ x, label, rows, width, padding, onClose }) {
  const boxWidth = 150;
  const rowHeight = 15;
  const boxHeight = 22 + rows.length * rowHeight;
  const boxX = Math.min(Math.max(x - boxWidth / 2, padding.left), width - padding.right - boxWidth);
  const boxY = padding.top + 2;

  return (
    <g style={{ cursor: "pointer" }} onClick={onClose}>
      <rect x={boxX} y={boxY} width={boxWidth} height={boxHeight} rx={6} fill={colors.surfaceAlt} stroke={colors.border} />
      <text x={boxX + 10} y={boxY + 16} fontSize="11.5" fontWeight="700" fill={colors.text}>
        {label}
      </text>
      <text x={boxX + boxWidth - 8} y={boxY + 16} fontSize="10" fill={colors.textMuted} textAnchor="end">
        ✕
      </text>
      {rows.map((r, i) => (
        <g key={r.label} transform={`translate(${boxX + 10}, ${boxY + 32 + i * rowHeight})`}>
          <rect width={8} height={8} y={-8} fill={r.color} />
          <text x={12} fontSize="10.5" fill={colors.textMuted}>
            {r.label}
          </text>
          <text x={boxWidth - 20} fontSize="10.5" fontWeight="700" fill={r.value >= 0 ? colors.success : colors.danger} textAnchor="end">
            {(r.value * 100).toFixed(1)}%
          </text>
        </g>
      ))}
    </g>
  );
}
