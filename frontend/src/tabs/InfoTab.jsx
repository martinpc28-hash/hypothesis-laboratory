import { ui, colors } from "../theme.js";

const pre = {
  background: colors.surfaceAlt,
  border: `1px solid ${colors.border}`,
  borderRadius: 8,
  padding: 14,
  fontSize: 12.5,
  lineHeight: 1.5,
  overflowX: "auto",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  margin: 0,
};

const TABS = [
  {
    name: "Seasonality",
    badge: "primary",
    text:
      "¿Un activo que lidera en una ventana temprana del año (por defecto enero-febrero) sigue liderando el resto del año? Prueba momentum de estacionalidad sobre sectores o países, con un backtest que evita look-ahead bias (compra recién al cerrar la ventana de señal), un filtro macro opcional (¿qué variable económica predice cuándo confiar en la señal?) y un sweep combinatorio (\"Monte Carlo\") que prueba cada combinación de universo/ventana y destaca la óptima. Cada retorno es clickeable hasta el precio exacto que lo produjo.",
  },
  {
    name: "VIX Timing",
    badge: "warning",
    text:
      "Rotación táctica entre S&P 500 y liquidez (letra del Tesoro a 3 meses o Euríbor) según el nivel del VIX: entra en acciones con VIX alto, vuelve a cash con VIX bajo. Corre en USD o en EUR (con opción de cobertura cambiaria sintética) de forma completamente independiente, no por conversión.",
  },
  {
    name: "Credit Rotation",
    badge: "success",
    text:
      "La misma lógica de rotación táctica pero entre bonos high-yield e investment-grade, disparada por 7 variables macro candidatas (spread de crédito, VIX, curva de rendimientos, nivel/cambio de tasas, inflación, crecimiento). USD e EUR son series 100% reales e independientes — fondos Vanguard en USD y fondos UCITS europeos (vía EODHD) en EUR, sin conversión cambiaria en ningún lado. La tabla año a año es auditable: cada número abre las operaciones activas o las fechas y precios exactos de ese año.",
  },
  {
    name: "Calculadora",
    badge: "neutral",
    text:
      "Combina los resultados YA corridos en las 3 pestañas anteriores con el % que le asignes a cada una, con rebalanceo anual. Siempre muestra USD y EUR por separado (convierte por tipo de cambio la que corrió en una sola moneda), grafica cierres semanales en un solo gráfico con selector USD | EUR, superpone S&P 500 y MSCI World, y calcula Sharpe, correlación e Information Ratio contra ambos.",
  },
];

const STACK = [
  { layer: "Backend", tech: "Java 17, Spring Boot 3, Maven" },
  { layer: "Frontend", tech: "React 18 + Vite — gráficos SVG hechos a mano (sin librería de charting), servidos como recursos estáticos del mismo jar de Spring Boot (un solo proceso, mismo origen, sin CORS). Diseño responsive: se usa también en celular (objetivos táctiles de 44px, gráficos que se adaptan al ancho). Tipografías Manrope + IBM Plex Mono" },
  { layer: "Persistencia", tech: "Las pestañas no guardan nada: se recalculan en cada corrida a partir de las fuentes de datos. La base (PostgreSQL en RDS) solo la usa código heredado de una versión anterior" },
  { layer: "Cómputo", tech: "Una instancia EC2, desplegada vía S3 + SSM Run Command (sin SSH, sin puerto 22 abierto)" },
];

const DATA_SOURCES = [
  { source: "Yahoo Finance", use: "Precios diarios de ETFs y fondos USD (ajustados por dividendos donde aplica) — sectores/países de Seasonality, S&P 500, VWEHX/VWESX de Credit Rotation" },
  { source: "FRED", use: "Series macro: VIX, T10Y2Y, DGS10, BAA10Y, CPIAUCSL, INDPRO, DTB3, DEXUSEU (tipo de cambio EUR/USD) — vía FredClient, con caché propio" },
  { source: "EODHD", use: "Dataset EUFUND — NAV real de fondos mutuos europeos con histórico profundo (Candriam/DPAM para el lado EUR de Credit Rotation), algo que Yahoo Finance no expone más allá de ~3-4 años para fondos europeos" },
];

const BACKEND_TREE = `src/main/java/com/martin/fullreval/
├── controller/
│   ├── SeasonalityController.java      /api/seasonality/*
│   ├── VixTimingController.java        /api/vix-timing/*
│   ├── CreditRotationController.java   /api/credit-rotation/*
│   └── FxController.java               /api/fx/*  (tipo de cambio para la Calculadora)
├── service/
│   ├── SeasonalityService.java     motor de la estrategia de estacionalidad
│   ├── VixTimingService.java       motor de rotación S&P 500 / cash
│   ├── CreditRotationService.java  motor de rotación HY / IG (+ precios para auditar)
│   ├── FxRateService.java          tasas EUR/USD (FRED) para conversión
│   ├── YahooFinanceService.java    cliente de precios (crudo + ajustado)
│   ├── FredClient.java             cliente de series FRED
│   ├── EodhdClient.java            cliente del dataset EUFUND
│   └── MacroDataService.java       series macro compartidas
├── dto/         un request por endpoint
└── (código heredado de una versión anterior, sin uso en la UI: model/, repository/, pricing/)`;

const FRONTEND_TREE = `frontend/src/
├── App.jsx              shell: header, selector de cartera, barra de pestañas
├── api.js               TODAS las llamadas al backend, en un solo lugar
├── theme.js             tokens de diseño (colores, tipografías, ui.*)
├── LineChart.jsx        \\
├── ScatterChart.jsx      |  gráficos SVG propios, sin librería:
├── HeatmapGrid.jsx       |  leyenda clickeable (oculta/muestra series),
├── AuditPanel.jsx       /  se adaptan al ancho (celular), eje X año o fecha
└── tabs/
    ├── InfoTab.jsx               esta página
    ├── SeasonalityTab.jsx
    ├── VixTimingTab.jsx
    ├── CreditRotationTab.jsx
    └── PortfolioCalculatorTab.jsx`;

function Row({ left, right }) {
  return (
    <tr>
      <td style={{ ...ui.td, fontWeight: 600, whiteSpace: "normal", width: "20%" }}>{left}</td>
      <td style={{ ...ui.td, whiteSpace: "normal" }}>{right}</td>
    </tr>
  );
}

export default function InfoTab() {
  return (
    <div>
      <div style={ui.card}>
        <h2 style={ui.cardTitle}>Hypothesis Laboratory</h2>
        <p style={{ ...ui.cardSubtitle, fontSize: 14, marginBottom: 8 }}>
          Un laboratorio para probar hipótesis de trading sistemático contra datos históricos reales — no backtests
          de caja negra: cada número (retorno, drawdown, operación) es auditable hasta la fecha y el precio exacto
          que lo produjo.
        </p>
        <p style={ui.cardSubtitle}>
          Tres estrategias sistemáticas independientes — estacionalidad, market timing con VIX y rotación de crédito — y
          una calculadora que las combina. Hoy la app muestra las cuatro pestañas de abajo.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <span style={ui.badge("neutral")}>Java 17 · Spring Boot 3</span>
          <span style={ui.badge("neutral")}>React + Vite</span>
          <span style={ui.badge("neutral")}>AWS EC2 + S3 + SSM</span>
          <span style={ui.badge("neutral")}>Yahoo Finance · FRED · EODHD</span>
        </div>
      </div>

      <div style={ui.card}>
        <h3 style={ui.cardTitle}>Qué hace cada pestaña</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {TABS.map((t) => (
            <div key={t.name} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <span style={{ ...ui.badge(t.badge), flexShrink: 0, marginTop: 2 }}>{t.name}</span>
              <p style={{ margin: 0, fontSize: 13.5, color: colors.text, lineHeight: 1.5 }}>{t.text}</p>
            </div>
          ))}
        </div>
      </div>

      <div style={ui.card}>
        <h3 style={ui.cardTitle}>Novedades</h3>
        <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13.5, color: colors.text, lineHeight: 1.8 }}>
          <li>
            <strong>Calculadora:</strong> un solo gráfico con selector USD | EUR y cierres semanales, S&amp;P 500 y MSCI
            World superpuestos, y métricas contra ambos (Sharpe, correlación, Information Ratio).
          </li>
          <li>
            <strong>Credit Rotation auditable:</strong> la tabla año a año abre las operaciones activas o los precios
            exactos de cada número.
          </li>
          <li>
            <strong>Gráficos interactivos:</strong> clic en la leyenda para ocultar o mostrar una serie, en todas las
            pestañas.
          </li>
          <li>
            <strong>Rediseño:</strong> tema grafito con acento ámbar, cifras en tipografía monoespaciada y tablas con los
            números alineados a la derecha.
          </li>
          <li>
            <strong>Versión móvil:</strong> la misma dirección funciona en el celular.
          </li>
        </ul>
      </div>

      <div style={ui.card}>
        <h3 style={ui.cardTitle}>Arquitectura</h3>
        <div style={ui.tableScroll}>
          <table style={ui.table}>
            <tbody>
              {STACK.map((s) => (
                <Row key={s.layer} left={s.layer} right={s.tech} />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div style={ui.card}>
        <h3 style={ui.cardTitle}>Fuentes de datos externas</h3>
        <div style={ui.tableScroll}>
          <table style={ui.table}>
            <tbody>
              {DATA_SOURCES.map((d) => (
                <Row key={d.source} left={d.source} right={d.use} />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div style={ui.card}>
        <h3 style={ui.cardTitle}>Estructura del proyecto — backend</h3>
        <pre style={pre}>{BACKEND_TREE}</pre>
      </div>

      <div style={ui.card}>
        <h3 style={ui.cardTitle}>Estructura del proyecto — frontend</h3>
        <pre style={pre}>{FRONTEND_TREE}</pre>
      </div>

      <div style={ui.card}>
        <h3 style={ui.cardTitle}>Cómo se despliega</h3>
        <p style={ui.cardSubtitle}>Sin SSH, sin llaves — todo remoto vía la API de AWS:</p>
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13.5, color: colors.text, lineHeight: 1.8 }}>
          <li>
            <code>npm run build</code> en <code>frontend/</code>, el resultado se copia a{" "}
            <code>src/main/resources/static/</code>
          </li>
          <li>
            <code>mvn clean package</code> produce un jar único con el frontend ya adentro
          </li>
          <li>El jar se sube a un bucket S3 privado (URL pre-firmada)</li>
          <li>
            Un comando <strong>SSM Run Command</strong> (no SSH) le dice a la instancia EC2 que pare el servicio{" "}
            <code>systemd</code> <code>fullreval</code>, baje el jar nuevo de S3, y reinicie
          </li>
          <li>
            Los secretos (password de la base, API key de EODHD) viven en <strong>SSM Parameter Store</strong>{" "}
            (SecureString) — nunca en el jar, el repo, ni el archivo del servicio
          </li>
        </ol>
      </div>

      <div style={ui.card}>
        <h3 style={ui.cardTitle}>Repositorio</h3>
        <p style={{ ...ui.muted, margin: 0 }}>
          github.com/martinpc28-hash/hypothesis-laboratory — rama <code>master</code>
        </p>
      </div>
    </div>
  );
}
