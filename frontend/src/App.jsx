import { useEffect, useMemo, useState } from "react";
import { api } from "./api.js";
import { shell, ui } from "./theme.js";
import DashboardTab from "./tabs/DashboardTab.jsx";
import PortfoliosTab from "./tabs/PortfoliosTab.jsx";
import ScenariosTab from "./tabs/ScenariosTab.jsx";
import SeasonalityTab from "./tabs/SeasonalityTab.jsx";
import VixTimingTab from "./tabs/VixTimingTab.jsx";

const PORTFOLIOS_KEY = "fullreval.portfolios";
const CURRENT_KEY = "fullreval.currentPortfolioId";
const DEFAULT_PORTFOLIOS = [{ id: 1, name: "Main portfolio" }];

function loadPortfolios() {
  try {
    const raw = localStorage.getItem(PORTFOLIOS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_PORTFOLIOS;
  } catch {
    return DEFAULT_PORTFOLIOS;
  }
}

function loadCurrentId(portfolios) {
  try {
    const raw = localStorage.getItem(CURRENT_KEY);
    const id = raw ? Number(raw) : null;
    return id && portfolios.some((p) => p.id === id) ? id : portfolios[0].id;
  } catch {
    return portfolios[0].id;
  }
}

// Dashboard/Carteras/Escenarios hidden from the tab bar for now (still fully implemented
// below, just not linked to — flip `hidden` back off whenever they're wanted again).
const TABS = [
  { key: "dashboard", label: "Gráficos y métricas", hidden: true },
  { key: "portfolios", label: "Carteras", hidden: true },
  { key: "scenarios", label: "Escenarios de estrés", hidden: true },
  { key: "seasonality", label: "Seasonality" },
  { key: "vixTiming", label: "VIX Timing" },
];

export default function App() {
  const [portfolios, setPortfolios] = useState(loadPortfolios);
  const [currentPortfolioId, setCurrentPortfolioId] = useState(() => loadCurrentId(loadPortfolios()));
  const [activeTab, setActiveTab] = useState("seasonality");
  const [instruments, setInstruments] = useState([]);
  const [lastRunByPortfolio, setLastRunByPortfolio] = useState({});
  const [status, setStatus] = useState(null);

  useEffect(() => {
    localStorage.setItem(PORTFOLIOS_KEY, JSON.stringify(portfolios));
  }, [portfolios]);

  useEffect(() => {
    localStorage.setItem(CURRENT_KEY, String(currentPortfolioId));
  }, [currentPortfolioId]);

  async function refreshInstruments() {
    try {
      const list = await api.listInstruments(currentPortfolioId);
      setInstruments(list);
    } catch (e) {
      setStatus({ type: "error", text: `Could not load instruments: ${e.message}` });
    }
  }

  useEffect(() => {
    refreshInstruments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPortfolioId]);

  // Auto-dismiss success banners; keep errors until the next action.
  useEffect(() => {
    if (status?.type === "success") {
      const t = setTimeout(() => setStatus(null), 4000);
      return () => clearTimeout(t);
    }
  }, [status]);

  function createPortfolio(name) {
    const nextId = portfolios.reduce((max, p) => Math.max(max, p.id), 0) + 1;
    const updated = [...portfolios, { id: nextId, name }];
    setPortfolios(updated);
    setCurrentPortfolioId(nextId);
    setStatus({ type: "success", text: `Cartera "${name}" creada.` });
  }

  function deletePortfolio(id) {
    const updated = portfolios.filter((p) => p.id !== id);
    setPortfolios(updated.length > 0 ? updated : DEFAULT_PORTFOLIOS);
    if (id === currentPortfolioId) {
      setCurrentPortfolioId((updated.length > 0 ? updated : DEFAULT_PORTFOLIOS)[0].id);
    }
  }

  function onRunComplete(runResult) {
    setLastRunByPortfolio((prev) => ({ ...prev, [currentPortfolioId]: runResult }));
    setActiveTab("dashboard");
  }

  const currentPortfolio = useMemo(
    () => portfolios.find((p) => p.id === currentPortfolioId) || portfolios[0],
    [portfolios, currentPortfolioId]
  );

  return (
    <div style={shell.app}>
      <header style={shell.header}>
        <div style={shell.brand}>
          <div>
            <p style={shell.brandTitle}>Hypothesis Laboratory</p>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={ui.muted}>Active portfolio:</span>
          <select
            style={{ ...ui.input, fontWeight: 600 }}
            value={currentPortfolioId}
            onChange={(e) => setCurrentPortfolioId(Number(e.target.value))}
          >
            {portfolios.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      <nav style={shell.tabBar}>
        {TABS.filter((t) => !t.hidden).map((t) => (
          <button key={t.key} style={shell.tabButton(activeTab === t.key)} onClick={() => setActiveTab(t.key)}>
            {t.label}
          </button>
        ))}
      </nav>

      <main style={shell.main}>
        {status && (
          <div style={status.type === "error" ? ui.bannerError : ui.bannerSuccess}>{status.text}</div>
        )}

        {activeTab === "dashboard" && (
          <DashboardTab
            lastRun={lastRunByPortfolio[currentPortfolioId]}
            portfolioName={currentPortfolio.name}
            onGoToScenarios={() => setActiveTab("scenarios")}
          />
        )}

        {activeTab === "portfolios" && (
          <PortfoliosTab
            portfolios={portfolios}
            currentPortfolioId={currentPortfolioId}
            onSelectPortfolio={setCurrentPortfolioId}
            onCreatePortfolio={createPortfolio}
            onDeletePortfolio={deletePortfolio}
            instruments={instruments}
            onInstrumentsChanged={refreshInstruments}
            setStatus={setStatus}
          />
        )}

        {activeTab === "scenarios" && (
          <ScenariosTab portfolioId={currentPortfolioId} setStatus={setStatus} onRunComplete={onRunComplete} />
        )}

        {activeTab === "seasonality" && <SeasonalityTab setStatus={setStatus} />}

        {activeTab === "vixTiming" && <VixTimingTab setStatus={setStatus} />}
      </main>
    </div>
  );
}
