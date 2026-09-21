import { useState } from "react";
import { colors } from "./theme.js";

// Scatter plot of signal-window return (x) vs. a comparison-window return (y),
// one point per (ticker, year), with the pooled Spearman rho / p-value / n
// annotated in the corner. Plain SVG, no charting library. Clicking a point
// pins a small readout with its label and both % values — the native
// <title> hover tooltip alone doesn't work on touch and disappears the
// moment you move the mouse.
export default function ScatterChart({ points, rho, pValue, n, xLabel, yLabel }) {
  const width = 420;
  const height = 300;
  const padding = { top: 16, right: 16, bottom: 40, left: 48 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const [activeIndex, setActiveIndex] = useState(null);

  if (!points || points.length === 0) {
    return <div style={{ color: colors.textMuted, fontSize: 13 }}>Sin datos suficientes.</div>;
  }

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const xMin = Math.min(...xs, 0);
  const xMax = Math.max(...xs, 0);
  const yMin = Math.min(...ys, 0);
  const yMax = Math.max(...ys, 0);
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;

  const sx = (v) => padding.left + ((v - xMin) / xRange) * plotWidth;
  const sy = (v) => padding.top + plotHeight - ((v - yMin) / yRange) * plotHeight;

  const zeroX = xMin <= 0 && xMax >= 0 ? sx(0) : null;
  const zeroY = yMin <= 0 && yMax >= 0 ? sy(0) : null;

  const rhoText = rho === null || rho === undefined ? "n/d" : rho.toFixed(3);
  const pText = pValue === null || pValue === undefined ? "n/d" : pValue < 0.001 ? "<0.001" : pValue.toFixed(3);

  const activePoint = activeIndex !== null ? points[activeIndex] : null;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: "auto" }}>
      {zeroY !== null && (
        <line x1={padding.left} y1={zeroY} x2={width - padding.right} y2={zeroY} stroke={colors.border} strokeDasharray="3 3" />
      )}
      {zeroX !== null && (
        <line x1={zeroX} y1={padding.top} x2={zeroX} y2={height - padding.bottom} stroke={colors.border} strokeDasharray="3 3" />
      )}

      {points.map((p, i) => (
        <circle
          key={i}
          cx={sx(p.x)}
          cy={sy(p.y)}
          r={activeIndex === i ? 5 : 3.5}
          fill={colors.primary}
          opacity={0.65}
          style={{ cursor: "pointer" }}
          onClick={() => setActiveIndex(activeIndex === i ? null : i)}
        >
          <title>{p.label ? `${p.label}: (${(p.x * 100).toFixed(1)}%, ${(p.y * 100).toFixed(1)}%)` : ""}</title>
        </circle>
      ))}

      {/* Axes */}
      <line x1={padding.left} y1={height - padding.bottom} x2={width - padding.right} y2={height - padding.bottom} stroke={colors.text} />
      <line x1={padding.left} y1={padding.top} x2={padding.left} y2={height - padding.bottom} stroke={colors.text} />
      <text x={width / 2} y={height - 6} fontSize="11" fill={colors.textMuted} textAnchor="middle">
        {xLabel}
      </text>
      <text x={12} y={height / 2} fontSize="11" fill={colors.textMuted} textAnchor="middle" transform={`rotate(-90, 12, ${height / 2})`}>
        {yLabel}
      </text>

      {/* Annotation */}
      <rect x={width - 148} y={padding.top} width={136} height={44} fill={colors.surface} opacity={0.92} stroke={colors.border} rx={4} />
      <text x={width - 140} y={padding.top + 16} fontSize="11.5" fontWeight="700" fill={colors.text}>
        ρ = {rhoText}
      </text>
      <text x={width - 140} y={padding.top + 30} fontSize="11" fill={colors.textMuted}>
        p = {pText}, n = {n}
      </text>

      {activePoint && (
        <ScatterReadout
          point={activePoint}
          xLabel={xLabel}
          yLabel={yLabel}
          cx={sx(activePoint.x)}
          cy={sy(activePoint.y)}
          width={width}
          height={height}
          padding={padding}
          onClose={() => setActiveIndex(null)}
        />
      )}
    </svg>
  );
}

// Small pinned box (label + x%/y% values) anchored near the clicked point,
// clamped so it never runs off any edge of the chart.
function ScatterReadout({ point, xLabel, yLabel, cx, cy, width, height, padding, onClose }) {
  const boxWidth = 150;
  const boxHeight = point.label ? 58 : 40;
  const boxX = Math.min(Math.max(cx - boxWidth / 2, padding.left), width - padding.right - boxWidth);
  const boxY = Math.max(cy - boxHeight - 10, padding.top);

  return (
    <g style={{ cursor: "pointer" }} onClick={onClose}>
      <rect x={boxX} y={boxY} width={boxWidth} height={boxHeight} rx={6} fill={colors.surfaceAlt} stroke={colors.border} />
      <text x={boxX + boxWidth - 8} y={boxY + 14} fontSize="10" fill={colors.textMuted} textAnchor="end">
        ✕
      </text>
      {point.label && (
        <text x={boxX + 10} y={boxY + 16} fontSize="11" fontWeight="700" fill={colors.text}>
          {point.label}
        </text>
      )}
      <text x={boxX + 10} y={boxY + (point.label ? 32 : 16)} fontSize="10.5" fill={colors.textMuted}>
        {xLabel}: <tspan fontWeight="700" fill={colors.text}>{(point.x * 100).toFixed(1)}%</tspan>
      </text>
      <text x={boxX + 10} y={boxY + (point.label ? 46 : 30)} fontSize="10.5" fill={colors.textMuted}>
        {yLabel}: <tspan fontWeight="700" fill={colors.text}>{(point.y * 100).toFixed(1)}%</tspan>
      </text>
    </g>
  );
}
