// Shared design tokens + reusable style objects, used across the whole app
// so all tabs (and the shell) look like one cohesive product instead
// of separate forms glued together.

export const colors = {
  bg: "#14151A",
  surface: "#1B1D24",
  surfaceAlt: "#22242C",
  border: "#2A2D38",
  text: "#F1F2F6",
  textMuted: "#8A8FA3",
  primary: "#5B8DEF",
  primaryDark: "#8FB1F5",
  primarySoft: "rgba(91,141,239,0.16)",
  danger: "#FF6B6B",
  dangerSoft: "rgba(255,107,107,0.14)",
  success: "#3DDC84",
  successSoft: "rgba(61,220,132,0.14)",
  warning: "#FFB454",
  warningSoft: "rgba(255,180,84,0.14)",
  accent: "#FFB454",
};

// Manrope for text, IBM Plex Mono for anything numeric or label-like (loaded in index.html).
export const fonts = {
  sans: "'Manrope', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
};

export const shell = {
  app: {
    minHeight: "100vh",
    backgroundColor: colors.bg,
    backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.05) 1px, transparent 1px)",
    backgroundSize: "24px 24px",
    color: colors.text,
    fontFamily: fonts.sans,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 12,
    padding: "12px clamp(12px, 3vw, 24px)",
    background: colors.surface,
    borderBottom: `1px solid ${colors.border}`,
    position: "sticky",
    top: 0,
    zIndex: 10,
  },
  brand: { display: "flex", alignItems: "center", gap: 12 },
  brandTitle: { fontSize: 16, fontWeight: 700, letterSpacing: "-0.01em", margin: 0 },
  brandSubtitle: { fontSize: 12, color: colors.textMuted, margin: 0 },
  tabBar: {
    display: "flex",
    gap: 4,
    padding: "0 clamp(8px, 3vw, 24px)",
    background: colors.surface,
    borderBottom: `1px solid ${colors.border}`,
    overflowX: "auto",
  },
  tabButton: (active) => ({
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "14px clamp(12px, 2.5vw, 18px)",
    fontSize: 14,
    fontFamily: "inherit",
    fontWeight: active ? 700 : 600,
    color: active ? colors.text : colors.textMuted,
    background: "transparent",
    border: "none",
    borderBottom: active ? `2px solid ${colors.accent}` : "2px solid transparent",
    cursor: "pointer",
    whiteSpace: "nowrap",
  }),
  main: { maxWidth: 1240, margin: "0 auto", padding: "clamp(12px, 3vw, 24px)" },
};

export const ui = {
  card: {
    background: colors.surface,
    border: `1px solid ${colors.border}`,
    borderRadius: 14,
    padding: "clamp(14px, 4vw, 24px)",
    marginBottom: 20,
  },
  cardTitle: { margin: "0 0 4px 0", fontSize: 17, fontWeight: 700, letterSpacing: "-0.01em" },
  cardSubtitle: { margin: "0 0 16px 0", fontSize: 13, color: colors.textMuted, lineHeight: 1.55 },
  eyebrow: {
    fontFamily: fonts.mono,
    fontSize: 11.5,
    letterSpacing: "0.16em",
    textTransform: "uppercase",
    color: colors.accent,
  },
  form: { display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" },
  row: { display: "flex", flexWrap: "wrap", gap: 12 },
  label: { display: "flex", flexDirection: "column", fontSize: 13, color: colors.textMuted, minWidth: 140, gap: 4 },
  input: {
    padding: "8px 10px",
    border: `1px solid ${colors.border}`,
    borderRadius: 10,
    fontSize: 14,
    fontFamily: "inherit",
    background: colors.surfaceAlt,
    color: colors.text,
  },
  button: (variant = "primary") => {
    const base = {
      padding: "9px 16px",
      borderRadius: 10,
      cursor: "pointer",
      fontSize: 14,
      fontFamily: "inherit",
      fontWeight: 700,
      border: "1px solid transparent",
      height: 38,
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
    };
    // Dark text on the blue fill: white on #5B8DEF is only ~3.3:1, this is ~6:1.
    if (variant === "primary") return { ...base, background: colors.primary, color: "#0B0C10" };
    if (variant === "secondary")
      return { ...base, background: colors.surfaceAlt, color: colors.text, border: `1px solid ${colors.border}` };
    if (variant === "danger") return { ...base, background: colors.dangerSoft, color: colors.danger };
    if (variant === "ghost") return { ...base, background: "transparent", color: colors.textMuted, border: "none" };
    return base;
  },
  table: { width: "100%", borderCollapse: "collapse" },
  th: {
    textAlign: "left",
    borderBottom: "1px solid #565C6C",
    padding: "8px 10px",
    fontFamily: fonts.mono,
    fontWeight: 500,
    fontSize: 11.5,
    color: colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: "0.1em",
    whiteSpace: "nowrap",
  },
  td: {
    borderBottom: `1px solid ${colors.border}`,
    padding: "9px 10px",
    fontSize: 13.5,
    whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums",
  },
  tableScroll: { overflowX: "auto" },
  muted: { color: colors.textMuted, fontSize: 13 },
  badge: (tone = "neutral") => {
    const tones = {
      neutral: { bg: colors.surfaceAlt, fg: colors.textMuted },
      primary: { bg: colors.primarySoft, fg: colors.primaryDark },
      success: { bg: colors.successSoft, fg: colors.success },
      danger: { bg: colors.dangerSoft, fg: colors.danger },
      warning: { bg: colors.warningSoft, fg: colors.warning },
    };
    const t = tones[tone] || tones.neutral;
    return {
      display: "inline-block",
      padding: "2px 8px",
      borderRadius: 999,
      fontFamily: fonts.mono,
      fontSize: 11,
      fontWeight: 600,
      background: t.bg,
      color: t.fg,
      textTransform: "uppercase",
      letterSpacing: "0.06em",
    };
  },
  bannerError: {
    background: colors.dangerSoft,
    color: colors.danger,
    border: "1px solid #7a4640",
    borderRadius: 10,
    padding: "10px 14px",
    marginBottom: 16,
    fontSize: 14,
  },
  bannerSuccess: {
    background: colors.successSoft,
    color: colors.success,
    border: "1px solid #3d6b50",
    borderRadius: 10,
    padding: "10px 14px",
    marginBottom: 16,
    fontSize: 14,
  },
  emptyState: {
    textAlign: "center",
    padding: "32px 16px",
    color: colors.textMuted,
    fontSize: 14,
  },
  statGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 },
  statCard: {
    background: colors.surfaceAlt,
    border: `1px solid ${colors.border}`,
    borderRadius: 12,
    padding: 16,
  },
  statLabel: {
    fontFamily: fonts.mono,
    fontSize: 11.5,
    color: colors.textMuted,
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: "0.12em",
  },
  statValue: { fontFamily: fonts.mono, fontSize: 24, fontWeight: 500, fontVariantNumeric: "tabular-nums" },
};
