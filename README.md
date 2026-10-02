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
| **Credit Rotation** | La misma lógica entre bonos high-yield e investment-grade, disparada por 7 variables macro candidatas (spread de crédito, VIX, curva, tasas, inflación, crecimiento). USD y EUR son series 100% reales e independientes (fondos Vanguard y UCITS europeos vía EODHD), sin conversión cambiaria. La tabla año a año es auditable. |
| **Calculadora** | Combina lo ya corrido en las tres pestañas con el % que asignes, con rebalanceo anual. Muestra siempre USD y EUR, un gráfico con cierres semanales y selector USD \| EUR, S&P 500 y MSCI World superpuestos, y Sharpe, correlación e Information Ratio contra ambos. |

Todos los gráficos tienen leyenda clickeable (oculta o muestra una serie) y las tablas numéricas alinean las
cifras a la derecha.

### Cómo leer los números

- **Volatilidad y drawdown** de cada estrategia salen de retornos diarios. La **Calculadora** mezcla tres
  calendarios distintos, así que su cartera combinada usa retornos **anuales**: es una estimación más ruidosa y
  está marcada como tal en la propia pantalla.
- En la Calculadora, **Seasonality y VIX Timing solo corren en una moneda a la vez**; la otra se estima con el
  tipo de cambio EUR/USD de fin de año. **Credit Rotation** tiene series reales en las dos monedas.
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
| Yahoo Finance | Precios diarios de ETFs y fondos en USD (ajustados por dividendos donde aplica): sectores y países de Seasonality, S&P 500, VWEHX/VWESX de Credit Rotation |
| FRED | Series macro (VIX, T10Y2Y, DGS10, BAA10Y, CPIAUCSL, INDPRO, DTB3) y tipo de cambio EUR/USD (DEXUSEU) |
| EODHD | Dataset EUFUND: NAV real de fondos europeos con historia profunda (el lado EUR de Credit Rotation). Yahoo no expone más de ~3-4 años de esos fondos |

## Estructura del proyecto

```
.
├── pom.xml
├── src/main/java/com/martin/fullreval/
│   ├── controller/   Seasonality, VixTiming, CreditRotation, Fx (tipo de cambio de la Calculadora)
│   ├── service/
│   │   ├── SeasonalityService      estrategia de estacionalidad, filtro macro y Monte Carlo
│   │   ├── VixTimingService        rotación S&P 500 / cash
│   │   ├── CreditRotationService   rotación HY / IG (+ precios para auditar y curva semanal)
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
        └── tabs/             Info, Seasonality, VixTiming, CreditRotation, PortfolioCalculator
```

## Correrlo en local

```bash
mvn spring-boot:run -Dspring-boot.run.profiles=local        # H2 en memoria, sin nada externo
cd frontend && npm install && npm run dev                   # http://localhost:5173, habla con :8080
```

Para un solo proceso que sirve todo: `cd frontend && npm run build`, copiar `dist/` a
`src/main/resources/static/`, y `mvn clean package`.

Variables de entorno opcionales: `EODHD_API_KEY` (sin ella, Credit Rotation no puede cargar el lado EUR).

## Cómo se despliega

1. `npm run build` en `frontend/` y copiar `dist/` a `src/main/resources/static/`.
2. `mvn clean package` produce un jar único con el frontend adentro.
3. El jar se sube a un bucket S3 privado (URL pre-firmada).
4. Un **SSM Run Command** (sin SSH, sin puerto 22) le pide a la instancia que pare el servicio `fullreval`
   (systemd), baje el jar y reinicie.
5. Los secretos (contraseña de la base, API key de EODHD) viven en **SSM Parameter Store** (SecureString) y
   un script de arranque los exporta como variables de entorno: no están en el jar ni en este repo.
