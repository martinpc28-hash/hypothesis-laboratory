import { colors } from "./theme.js";

// Left-side sliding drawer that shows exactly how one return percentage was
// calculated: which ticker(s), which price on which date at the start and
// at the end, and the resulting formula — click any "Return" number in the
// heatmaps or the strategy tables to open it. Lets you audit the numbers
// instead of trusting them blindly.
function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric" });
}

function formatPrice(v) {
  return v === null || v === undefined ? "—" : `$${Number(v).toFixed(2)}`;
}

function formatPct(v, digits = 2) {
  return v === null || v === undefined || Number.isNaN(v) ? "n/a" : `${(v * 100).toFixed(digits)}%`;
}

export function ComponentDetail({ c }) {
  const missing = c.value === null || c.value === undefined;
  return (
    <div
      style={{
        border: `1px solid ${colors.border}`,
        borderRadius: 10,
        padding: 14,
        background: colors.surfaceAlt,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>{c.ticker}</span>
        <span style={{ fontWeight: 700, fontSize: 16, color: missing ? colors.textMuted : c.value >= 0 ? colors.success : colors.danger }}>
          {formatPct(c.value)}
        </span>
      </div>
      {missing ? (
        <p style={{ ...ui_muted, margin: 0 }}>Not enough data in this window for this asset.</p>
      ) : (
        <>
          <table style={{ width: "100%", fontSize: 12.5, borderCollapse: "collapse" }}>
            <tbody>
              <tr>
                <td style={cellLabelStyle}>Requested window</td>
                <td style={cellValueStyle}>
                  {formatDate(c.windowStart)} → {formatDate(c.windowEnd)}
                </td>
              </tr>
              <tr>
                <td style={cellLabelStyle}>Start date / price</td>
                <td style={cellValueStyle}>
                  {formatDate(c.startDate)} · <strong>{formatPrice(c.startPrice)}</strong>
                </td>
              </tr>
              <tr>
                <td style={cellLabelStyle}>End date / price</td>
                <td style={cellValueStyle}>
                  {formatDate(c.endDate)} · <strong>{formatPrice(c.endPrice)}</strong>
                </td>
              </tr>
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
            ({formatPrice(c.endPrice)} − {formatPrice(c.startPrice)}) / {formatPrice(c.startPrice)} = {formatPct(c.value)}
          </div>
        </>
      )}
    </div>
  );
}

const ui_muted = { color: colors.textMuted, fontSize: 13 };
const cellLabelStyle = { padding: "3px 0", color: colors.textMuted, whiteSpace: "nowrap", width: "42%" };
const cellValueStyle = { padding: "3px 0", textAlign: "right" };

// Generic left-side sliding drawer shell (backdrop + header with kicker/title/subtitle +
// close button + scrollable body) — reused by AuditPanel and by anything else that wants
// the same "click something, get a detail panel on the left" interaction.
export function Drawer({ kicker, title, subtitle, onClose, children }) {
  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(15,18,28,0.35)",
          zIndex: 40,
        }}
      />
      <div
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          bottom: 0,
          width: "min(420px, 92vw)",
          background: colors.surface,
          borderRight: `1px solid ${colors.border}`,
          boxShadow: "2px 0 24px rgba(15,18,28,0.18)",
          zIndex: 41,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 8,
            padding: "16px 18px",
            borderBottom: `1px solid ${colors.border}`,
          }}
        >
          <div>
            {kicker && (
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: colors.primary }}>
                {kicker}
              </div>
            )}
            <h3 style={{ margin: "4px 0 0 0", fontSize: 16 }}>{title}</h3>
            {subtitle && <p style={{ margin: "4px 0 0 0", fontSize: 12.5, color: colors.textMuted }}>{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            style={{
              border: "none",
              background: "transparent",
              fontSize: 18,
              cursor: "pointer",
              color: colors.textMuted,
              lineHeight: 1,
              padding: 4,
            }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div style={{ padding: 18, overflowY: "auto", flex: 1 }}>{children}</div>
      </div>
    </>
  );
}

export default function AuditPanel({ audit, onClose }) {
  if (!audit) return null;
  const components = audit.components || [];
  const isAverage = components.length > 1;
  const validValues = components.map((c) => c.value).filter((v) => v !== null && v !== undefined);
  const average = validValues.length ? validValues.reduce((a, b) => a + b, 0) / validValues.length : null;

  return (
    <Drawer kicker="Return audit" title={audit.title} subtitle={audit.subtitle} onClose={onClose}>
      {isAverage && (
        <div
          style={{
            background: colors.primarySoft,
            border: `1px solid ${colors.border}`,
            borderRadius: 10,
            padding: 14,
            marginBottom: 16,
          }}
        >
          <p style={{ margin: 0, fontSize: 13 }}>
            This number is the <strong>equal-weighted average</strong> of {components.length} asset
            {components.length === 1 ? "" : "s"}, each computed the same way as the cards below:
          </p>
          <div
            style={{
              marginTop: 8,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              fontSize: 12.5,
              color: colors.textMuted,
            }}
          >
            ({components.map((c) => formatPct(c.value, 1)).join(" + ")}) / {components.length} = {formatPct(average)}
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {components.map((c, i) => (
          <ComponentDetail key={`${c.ticker}-${i}`} c={c} />
        ))}
      </div>

      {components.length === 0 && <p style={ui_muted}>No data available to audit this value.</p>}
    </Drawer>
  );
}
