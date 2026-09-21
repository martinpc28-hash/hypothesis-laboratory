// Central place for every backend call. In prod the frontend is served by the
// same Spring Boot process (packaged into its static resources), so relative
// paths ("") are correct. In dev (`npm run dev`), Vite serves the frontend
// alone on :5173, so we point at the backend's own port instead.
const API_BASE = import.meta.env.VITE_API_BASE ?? (import.meta.env.PROD ? "" : "http://localhost:8080");

function postJson(body) {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

async function request(path, options) {
  const res = await fetch(`${API_BASE}${path}`, options);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${text ? `: ${text}` : ""}`);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : null;
}

export const api = {
  listInstruments: (portfolioId) => request(`/api/portfolios/${portfolioId}/instruments`),
  addBond: (portfolioId, body) => request(`/api/portfolios/${portfolioId}/instruments/bonds`, postJson(body)),
  addOption: (portfolioId, body) => request(`/api/portfolios/${portfolioId}/instruments/options`, postJson(body)),
  addEquity: (portfolioId, body) => request(`/api/portfolios/${portfolioId}/instruments/equities`, postJson(body)),
  deleteInstrument: (portfolioId, instrumentId) =>
    request(`/api/portfolios/${portfolioId}/instruments/${instrumentId}`, { method: "DELETE" }),

  generateScenarios: (scenarioSetId, count) =>
    request(`/api/scenarios/generate?scenarioSetId=${encodeURIComponent(scenarioSetId)}&count=${count}`, {
      method: "POST",
    }),
  generateHistoricalScenarios: (scenarioSetId, count) =>
    request(`/api/scenarios/generate-historical?scenarioSetId=${encodeURIComponent(scenarioSetId)}&count=${count}`, {
      method: "POST",
    }),
  createCustomScenario: (body) => request(`/api/scenarios/custom`, postJson(body)),

  runRevaluation: (portfolioId, scenarioSetId) =>
    request(`/api/revaluation/run?portfolioId=${portfolioId}&scenarioSetId=${encodeURIComponent(scenarioSetId)}`, {
      method: "POST",
    }),
  getVar: (runId, confidence) => request(`/api/revaluation/${runId}/var?confidence=${confidence}`),
  getPnlDistribution: (runId) => request(`/api/revaluation/${runId}/pnl-distribution`),
  getInstrumentBreakdown: (runId) => request(`/api/revaluation/${runId}/instrument-breakdown`),

  // Seasonality Hypothesis Lab
  getSeasonalityUniverse: () => request(`/api/seasonality/universe`),
  getSeasonalitySources: () => request(`/api/seasonality/sources`),
  runSeasonalityTest: (body) => request(`/api/seasonality/test`, postJson(body)),
  runSeasonalitySweep: (body) => request(`/api/seasonality/sweep`, postJson(body)),
  runSeasonalityMonteCarlo: (body) => request(`/api/seasonality/montecarlo`, postJson(body)),
  runSeasonalityMacroInsights: (body) => request(`/api/seasonality/macro-insights`, postJson(body)),

  // VIX Timing strategy
  runVixTimingBacktest: (body) => request(`/api/vix-timing/backtest`, postJson(body)),
};
