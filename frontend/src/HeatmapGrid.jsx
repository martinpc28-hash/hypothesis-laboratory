import { colors } from "./theme.js";

// Generic heatmap/grid: row labels x column labels, one colored+labeled cell
// per pair. Used for the coverage strip, the year x asset ranking heatmap,
// and the window-sweep matrix — each just supplies differently-colored cells.
// Plain HTML table (not SVG): text-heavy grids with many small cells are
// simpler this way, and it scrolls horizontally for free inside ui.tableScroll.
export default function HeatmapGrid({ rowLabels, colLabels, cells, rowLabelWidth = 110, cellWidth = 46, cellHeight = 26 }) {
  return (
    <table style={{ borderCollapse: "collapse", fontSize: 11.5 }}>
      <thead>
        <tr>
          <th style={{ width: rowLabelWidth, minWidth: rowLabelWidth }} />
          {colLabels.map((c, i) => (
            <th
              key={i}
              style={{
                width: cellWidth,
                minWidth: cellWidth,
                padding: "2px 4px",
                fontWeight: 600,
                color: colors.textMuted,
                whiteSpace: "nowrap",
              }}
            >
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rowLabels.map((row, rIdx) => (
          <tr key={rIdx}>
            <td
              style={{
                width: rowLabelWidth,
                minWidth: rowLabelWidth,
                padding: "2px 6px",
                fontWeight: 600,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {row}
            </td>
            {colLabels.map((_, cIdx) => {
              const cell = cells[rIdx]?.[cIdx] ?? { label: "", color: colors.surfaceAlt };
              return (
                <td
                  key={cIdx}
                  title={cell.title || ""}
                  onClick={cell.onClick}
                  style={{
                    width: cellWidth,
                    height: cellHeight,
                    minWidth: cellWidth,
                    textAlign: "center",
                    background: cell.color,
                    color: cell.textColor || colors.text,
                    border: `1px solid ${colors.bg}`,
                    fontVariantNumeric: "tabular-nums",
                    cursor: cell.onClick ? "pointer" : "default",
                  }}
                >
                  {cell.label}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Diverging dark-neutral -> green/red scale for values roughly in [-1, 1] (e.g. Spearman rho,
 * returns as fractions) — interpolates from the app's dark surface tone (68,74,87) at t=0 up to
 * a legible green/red at the extremes, instead of a light-mode white-to-color scale. */
export function divergingColor(value, maxAbs = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return colors.surfaceAlt;
  const t = Math.max(-1, Math.min(1, value / maxAbs));
  const base = [34, 36, 44]; // matches theme.js colors.surfaceAlt
  if (t >= 0) {
    const target = [22, 120, 74]; // success green
    const mix = base.map((b, i) => Math.round(b + t * (target[i] - b)));
    return `rgb(${mix[0]},${mix[1]},${mix[2]})`;
  }
  const s = -t;
  const target = [130, 45, 40]; // danger red
  const mix = base.map((b, i) => Math.round(b + s * (target[i] - b)));
  return `rgb(${mix[0]},${mix[1]},${mix[2]})`;
}
