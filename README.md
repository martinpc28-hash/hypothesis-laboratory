# Hypothesis Laboratory

Un laboratorio para probar hipótesis de trading sistemático contra datos históricos reales. No son
backtests de caja negra: cada número (retorno, drawdown, operación) se puede auditar hasta la fecha y el
precio exacto que lo produjo.

**App en vivo:** http://3.227.208.53:8080/ (funciona también en el celular)

## Qué hace cada pestaña

| Pestaña | Pregunta que responde |
|---|---|
| **Info** | Explica el proyecto, la arquitectura y las novedades (es la primera ventana). |
| **Seasonality** | ¿Un activo que lidera en una ventana temprana del año (por defecto enero-febrero) sigue liderando el resto? Momentum de estacionalidad sobre sectores o países, con backtest sin look-ahead bias, filtro macro opcional y búsqueda combinatoria («Monte Carlo») que prueba cada combinación de universo y ventana y destaca la óptima. Cada retorno es clickeable hasta el precio exacto. |
| **VIX Timing** | Rotación entre S&P 500 y liquidez (letra del Tesoro a 3 meses o Euríbor) según el nivel del VIX: entra en acciones con VIX alto, vuelve a cash con VIX bajo. En USD o EUR corridos de forma independiente, con opción de cobertura cambiaria sintética. |
| **Small Caps** | Estrategia armada a partir del paper del CFA Institute «Small Caps vs. Large Caps: The Cycle That's About to Turn». Tres señales con umbrales que se pueden mover: **ciclo** (spread de retorno a 10 años Russell 2000 − S&P 500), **valor relativo** (z-score de esa relación) y **tasas** (fed funds). Con suficientes señales encendidas mantiene small caps (Russell 2000, internacionales o global); si no, compra un **bono AAA** si su yield supera un mínimo (por defecto 4%) y lo mantiene hasta el vencimiento o lo vende cuando el yield cae lo suficiente; si el yield es bajo, se queda en letras del Tesoro. Incluye un **Monte Carlo** sobre los parámetros (¿depende el resultado de haber elegido justo estos números?) y un **bootstrap** en bloques de los retornos mensuales (¿cuánto es suerte del camino?). No modela P/B ni ROA del paper (sin datos históricos gratuitos), el bono usa el índice Aaa de Moody's como aproximación y no hay costos de transacción. |
| **Ilíquidos** | Una cartera de inmobiliario, crédito privado, infraestructura y capital privado con los pesos que elijas y rebalanceo anual. Como no cotizan a diario (se valúan por tasación trimestral, que alisa las caídas), cada uno se representa con un **proxy cotizado con precio diario real** (VGSIX, FFRHX, XLU, VISVX; opcionales PSP y CSUAX), sin rendimientos inventados. Muestra también cómo se vería la misma cartera en un reporte trimestral, para medir cuánto riesgo esconde la tasación. |
| **Calculadora** | Combina lo ya corrido en las pestañas anteriores con el % que asignes, con rebalanceo anual. Muestra siempre USD y EUR, un gráfico con cierres semanales y selector USD \| EUR, S&P 500 y MSCI World siempre superpuestos (S&P 500 con dividendos reinvertidos; el MSCI World de Yahoo es el índice de precio, sin dividendos, así que rinde cerca de 2 puntos por año menos que su versión total), y Sharpe, correlación e Information Ratio contra ambos, con volatilidad y drawdown medidos sobre cierres semanales. Las métricas giran en torno a la cartera combinada: tarjetas con lo principal, una tabla contra los benchmarks (mejor y peor año y semana, peor caída con fechas y recuperación, VaR/CVaR 95%, Sortino, Calmar, beta, tracking error y capturas alcista/bajista; con opción de mostrar cada estrategia), el retorno año por año con el exceso sobre el S&P 500 y la correlación entre las estrategias. |

Todos los gráficos tienen leyenda clickeable (oculta o muestra una serie) y las tablas numéricas alinean las
cifras a la derecha.

### Cómo leer los números

- **Volatilidad y drawdown** de cada estrategia salen de retornos diarios. La **Calculadora** mezcla
  calendarios distintos, así que mide volatilidad, drawdown, Sharpe, correlación e Information Ratio sobre
  **cierres semanales** (viernes); retorno total y CAGR salen de la mezcla anual. En EUR el movimiento semanal
  es el del activo y solo el cierre de año usa el tipo de cambio real: es una aproximación.
- En la Calculadora, **Seasonality y VIX Timing solo corren en una moneda a la vez**; la otra se estima con el
  tipo de cambio EUR/USD de fin de año. **Ilíquidos** y **Small Caps** también corren solo en USD.
- **Sharpe** acá es CAGR ÷ volatilidad, sin restar tasa libre de riesgo.
- Un backtest histórico no garantiza que el resultado se repita.

## Stack

| Capa | Tecnología |
|---|---|
| Backend | Java 17, Spring Boot 3, Maven |
| Frontend | React 18 + Vite. Gráficos SVG propios (sin librería de charting), servidos desde el mismo jar de Spring Boot: un solo proceso, un solo origen, sin CORS. Diseño responsive. Tipografías Manrope + IBM Plex Mono |
| Persistencia | Las pestañas no guardan nada: recalculan en cada corrida desde las fuentes de datos. La base (PostgreSQL en RDS) solo la usa código heredado |
| Cómputo | Una instancia EC2, desplegada con S3 + SSM Run Command (sin SSH) |

### Fuentes de datos

| Fuente | Uso |
|---|---|
| Yahoo Finance | Precios diarios de ETFs y fondos en USD (ajustados por dividendos donde aplica): sectores y países de Seasonality, S&P 500, los proxies de Ilíquidos y IWM / DFISX / ^RUT / ^GSPC para Small Caps |
| FRED | Series macro (VIX, T10Y2Y, DGS10, BAA10Y, CPIAUCSL, INDPRO, DTB3, DFF, DAAA) y tipo de cambio EUR/USD (DEXUSEU) |
| EODHD | Dataset EUFUND: NAV real de fondos europeos con historia profunda (el lado EUR de Credit Rotation, hoy oculta). Yahoo no expone más de ~3-4 años de esos fondos |

## Estructura del proyecto

```
.
├── pom.xml
├── src/main/java/com/martin/fullreval/
│   ├── controller/   Seasonality, VixTiming, SmallCaps, Illiquids, Benchmarks, CreditRotation (oculta), Fx (tipo de cambio de la Calculadora)
│   ├── service/
│   │   ├── SeasonalityService      estrategia de estacionalidad, filtro macro y Monte Carlo
│   │   ├── VixTimingService        rotación S&P 500 / cash
│   │   ├── SmallCapsService        señales del paper, bono AAA, Monte Carlo y bootstrap
│   │   ├── BenchmarksService       S&P 500 y MSCI World para la Calculadora
│   │   ├── IlliquidsService        cartera de ilíquidos con proxies cotizados
│   │   ├── CreditRotationService   rotación HY / IG (pestaña oculta)
│   │   ├── FxRateService           tasas EUR/USD (FRED)
│   │   ├── YahooFinanceService     precios crudos y ajustados
│   │   ├── FredClient, EodhdClient clientes de datos externos
│   │   └── MacroDataService        series macro compartidas
│   ├── dto/          un request por endpoint
│   └── (código heredado de una versión anterior, sin uso en la UI: model/, repository/, pricing/)
├── src/main/resources/application.yml   perfiles local (H2) y rds (Postgres)
├── analysis/    scripts de Node para chequeos de robustez fuera de línea (bootstrap, subperíodos)
│                cuyos resultados se citan en la UI: están acá para poder re-derivarlos
└── frontend/
    ├── index.html            fuentes y reglas globales (táctil, alineación de tablas)
    └── src/
        ├── App.jsx           shell: encabezado y barra de pestañas
        ├── api.js            todas las llamadas al backend
        ├── theme.js          tokens de diseño (colores, tipografías, estilos)
        ├── LineChart.jsx, ScatterChart.jsx, HeatmapGrid.jsx, AuditPanel.jsx ...
        └── tabs/             Info, Seasonality, VixTiming, SmallCaps, Illiquids, PortfolioCalculator (+ CreditRotation, oculta)
```

## Correrlo en local

```bash
mvn spring-boot:run -Dspring-boot.run.profiles=local        # H2 en memoria, sin nada externo
cd frontend && npm install && npm run dev                   # http://localhost:5173, habla con :8080
```

Para un solo proceso que sirve todo: `cd frontend && npm run build`, copiar `dist/` a
`src/main/resources/static/`, y `mvn clean package`.

Variables de entorno opcionales: `EODHD_API_KEY` (solo la usa Credit Rotation, hoy oculta).

## Cómo se despliega

Es automático: **cada push a `master` despliega** (workflow `.github/workflows/deploy.yml`, también se puede
lanzar a mano desde la pestaña Actions).

1. GitHub Actions compila el frontend (`npm run build`) y lo copia a `src/main/resources/static/`.
2. `mvn package` produce un jar único con el frontend adentro.
3. Sin llaves guardadas: GitHub pide a AWS credenciales temporales por **OIDC** para el rol
   `hypothesis-lab-github-deploy`, que solo puede subir ese jar al bucket S3 y lanzar un comando SSM en esa
   instancia, y solo desde la rama `master` de este repo.
4. Un **SSM Run Command** (sin SSH, sin puerto 22) le pide a la instancia que pare el servicio `fullreval`
   (systemd), baje el jar y reinicie. El último paso verifica que la app responda 200.
5. Los secretos (contraseña de la base, API key de EODHD) viven en **SSM Parameter Store** (SecureString) y
   un script de arranque los exporta como variables de entorno: no están en el jar ni en este repo.

En el repo hay dos variables de Actions (no secretos): `AWS_ROLE_ARN` y `APP_URL`.
