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
    name: "Small Caps",
    badge: "primary",
    text:
      "Estrategia basada en el paper «Small Caps vs. Large Caps: The Cycle That's About to Turn» (CFA Institute). Tres señales que puedes mover: ciclo (spread de retorno a 10 años del Russell 2000 contra el S&P 500), valor relativo (z-score de esa relación) y tasas (fed funds). Con suficientes señales encendidas compra small caps (Russell 2000 o internacionales); si no, compra un bono AAA con yield mínimo que elijas y lo mantiene hasta el vencimiento o lo vende cuando el yield cae mucho. Incluye Monte Carlo sobre los parámetros y bootstrap de los retornos para ver cuánto del resultado es robusto y cuánto es azar.",
  },
  {
    name: "Ilíquidos",
    badge: "success",
    text:
      "Una cartera de inmobiliario, crédito privado, infraestructura y capital privado con los pesos que elijas y rebalanceo anual. Como estos activos no cotizan a diario (se valúan por tasación trimestral, que alisa las caídas), cada uno se representa con un proxy cotizado con precio diario real, sin rendimientos inventados. Muestra además cómo se vería la misma cartera en un reporte trimestral, para medir cuánto riesgo esconde la tasación.",
  },
  {
    name: "Calculadora",
    badge: "neutral",
    text:
      "Combina los resultados YA corridos en las pestañas anteriores con el % que le asignes a cada una, con rebalanceo anual. Siempre muestra USD y EUR por separado (convierte por tipo de cambio la que corrió en una sola moneda), grafica cierres semanales en un solo gráfico con selector USD | EUR, superpone siempre S&P 500 y MSCI World (con su propio endpoint, no dependen de qué estrategias corriste), y calcula Sharpe, correlación e Information Ratio contra ambos. Volatilidad, drawdown y esas métricas se miden sobre cierres semanales (viernes), no sobre retornos anuales. Las métricas giran en torno a la cartera combinada: tarjetas con lo principal, una tabla contra los benchmarks (mejor y peor año y semana, peor caída con fechas y recuperación, VaR/CVaR, Sortino, Calmar, beta, tracking error y capturas alcista/bajista; con opción de mostrar cada estrategia), el retorno año por año con el exceso sobre el S&P 500 y la correlación entre las estrategias para ver cuánto diversifica la mezcla.",
  },
];

const STACK = [
  { layer: "Backend", tech: "Java 17, Spring Boot 3, Maven" },
  { layer: "Frontend", tech: "React 18 + Vite — gráficos SVG hechos a mano (sin librería de charting), servidos como recursos estáticos del mismo jar de Spring Boot (un solo proceso, mismo origen, sin CORS). Diseño responsive: se usa también en celular (objetivos táctiles de 44px, gráficos que se adaptan al ancho). Tipografías Manrope + IBM Plex Mono" },
  { layer: "Persistencia", tech: "Las pestañas no guardan nada: se recalculan en cada corrida a partir de las fuentes de datos. La base (PostgreSQL en RDS) solo la usa código heredado de una versión anterior" },
  { layer: "Cómputo", tech: "Una instancia EC2, desplegada vía S3 + SSM Run Command (sin SSH, sin puerto 22 abierto)" },
];

const DATA_SOURCES = [
  { source: "Yahoo Finance", use: "Precios diarios de ETFs y fondos USD (ajustados por dividendos donde aplica) — sectores/países de Seasonality, S&P 500 y los proxies de Ilíquidos (VGSIX, FFRHX, XLU, VISVX, PSP, CSUAX), y IWM / DFISX / ^RUT / ^GSPC para Small Caps" },
  { source: "FRED", use: "Series macro: VIX, T10Y2Y, DGS10, BAA10Y, CPIAUCSL, INDPRO, DTB3, DFF (fed funds), DAAA (yield Aaa de Moody's), DEXUSEU (tipo de cambio EUR/USD) — vía FredClient, con caché propio" },
  { source: "EODHD", use: "Dataset EUFUND — NAV real de fondos mutuos europeos con histórico profundo (Candriam/DPAM para el lado EUR de Credit Rotation, hoy oculta), algo que Yahoo Finance no expone más allá de ~3-4 años para fondos europeos" },
];

const BACKEND_TREE = `src/main/java/com/martin/fullreval/
├── controller/
│   ├── SeasonalityController.java      /api/seasonality/*
│   ├── VixTimingController.java        /api/vix-timing/*
│   ├── SmallCapsController.java        /api/small-caps/*  (backtest, Monte Carlo, bootstrap)
│   ├── BenchmarksController.java       /api/benchmarks  (S&P 500 y MSCI World para la Calculadora)
│   ├── IlliquidsController.java        /api/illiquids/*
│   ├── CreditRotationController.java   /api/credit-rotation/*  (pestaña oculta)
│   └── FxController.java               /api/fx/*  (tipo de cambio para la Calculadora)
├── service/
│   ├── SeasonalityService.java     motor de la estrategia de estacionalidad
│   ├── VixTimingService.java       motor de rotación S&P 500 / cash
│   ├── SmallCapsService.java       señales del paper, bono AAA, Monte Carlo y bootstrap
│   ├── BenchmarksService.java      S&P 500 (rendimiento total) y MSCI World (índice de precio)
│   ├── IlliquidsService.java       cartera de ilíquidos con proxies cotizados
│   ├── CreditRotationService.java  motor de rotación HY / IG (oculto)
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
    ├── SmallCapsTab.jsx
    ├── IlliquidsTab.jsx
    ├── CreditRotationTab.jsx          (oculta)
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
          Tres estrategias sistemáticas — estacionalidad, market timing con VIX y rotación small caps / bonos AAA —,
          una cartera de ilíquidos y una calculadora que las combina. Hoy la app muestra las pestañas de abajo.
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
            <strong>Small Caps:</strong> pestaña nueva con una estrategia armada a partir del paper del CFA Institute: tú
            mueves los umbrales de las señales, el yield mínimo del bono AAA, el vencimiento y la regla de venta, y ves
            el resultado contra comprar y mantener. Trae un Monte Carlo (¿y si los parámetros fueran otros?) y un
            bootstrap (¿es suerte?). Limitaciones: no modela P/B ni ROA (sin datos gratis), el bono es una
            aproximación con el índice Aaa de Moody's y no hay costos de transacción.
          </li>
          <li>
            <strong>Calculadora:</strong> un solo gráfico con selector USD | EUR y cierres semanales, S&amp;P 500 y MSCI
            World superpuestos, y métricas contra ambos (Sharpe, correlación, Information Ratio).
          </li>
          <li>
            <strong>Ilíquidos:</strong> pestaña nueva que reemplaza a Credit Rotation en el menú (su código sigue en el repo):
            cartera de inmobiliario, crédito, infraestructura y capital privado con proxies cotizados y la comparación
            contra un reporte trimestral. Ya se puede sumar en la Calculadora.
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
        <p style={ui.cardSubtitle}>
          Automático: cada push a <code>master</code> despliega solo (GitHub Actions). Sin SSH y sin llaves guardadas.
        </p>
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13.5, color: colors.text, lineHeight: 1.8 }}>
          <li>
            Actions compila el frontend (<code>npm run build</code>) y lo mete en el jar con{" "}
            <code>mvn package</code>
          </li>
          <li>
            Pide a AWS credenciales temporales por <strong>OIDC</strong> para un rol que solo puede subir ese jar y
            lanzar un comando SSM, y solo desde la rama <code>master</code>
          </li>
          <li>El jar se sube a un bucket S3 privado</li>
          <li>
            Un <strong>SSM Run Command</strong> le dice a la instancia EC2 que pare el servicio <code>fullreval</code>,
            baje el jar nuevo y reinicie; el último paso verifica que la app responda
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
