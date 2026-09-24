# Hypothesis Laboratory

A seasonality hypothesis-testing lab for sector and country ETFs: does an
asset that outperforms in an early window of the year go on to lead the
rest of the year? Pick a universe, a signal window, and a date range, and
test it against real historical data — correlation, quartile persistence,
a look-ahead-bias-avoiding backtest, and an exhaustive combinatorial
search ("Monte Carlo") over every window/universe combination.

This module is built on top of a **full revaluation** market-risk engine
(portfolio-level VaR where every instrument is repriced from scratch under
every market scenario — no delta/gamma approximation). That original
Dashboard/Portfolios/Stress-scenarios functionality is still fully
implemented and deployed, just not linked from the nav bar right now — the
live UI currently surfaces only the Seasonality Hypothesis Lab. See
[`SeasonalityService`](src/main/java/com/martin/fullreval/service/SeasonalityService.java)
for that module's engine, and the sections below for the original
full-revaluation engine it sits on.

## What the full-revaluation engine does

1. Build one or more portfolios of bonds, European options, and equities
   (each can be booked in a different currency, converted to USD via FX
   shocks).
2. Generate a set of market scenarios two ways:
   - **Real historical data** (recommended) — actual daily moves pulled from
     [FRED](https://fred.stlouisfed.org/) (10-Year Treasury yield, S&P 500,
     VIX, USD/EUR) for the shared rate/vol/FX factors, plus **real per-ticker
     equity returns from Yahoo Finance** for any equity whose name is a real
     ticker (e.g. `AAPL`) — so that position moves with its own stock, not
     a generic index proxy.
   - **Synthetic** — random Gaussian noise, as a network-independent fallback
     or quick smoke test. Clearly labeled as such in the UI; not meant to be
     trusted as a real risk number.
   - Or define a single **deterministic stress scenario** (a rate shock in
     bps, plus toggleable macro presets like an oil-price shock or a global
     recession) to answer "how much do we lose if X happens?"
3. The engine reprices every instrument under every scenario, computes P&L,
   and derives either portfolio VaR (Monte Carlo / historical simulation) or
   a per-instrument stress-test breakdown.

See [`HistoricalScenarioService`](src/main/java/com/martin/fullreval/service/HistoricalScenarioService.java)
and [`YahooFinanceService`](src/main/java/com/martin/fullreval/service/YahooFinanceService.java)
for the exact data sources and the caveats that still apply (one shared
rate/vol/FX shock per scenario across the whole portfolio; no cross-factor
correlation; stress presets are illustrative, not calibrated to a specific
historical episode).

## Stack

| Layer          | Technology                                                     |
|----------------|-----------------------------------------------------------------|
| Backend        | Java 17, Spring Boot 3, Spring Data JPA / Hibernate              |
| Database       | PostgreSQL (Amazon RDS in prod), H2 for local dev                |
| Market data    | FRED (rates/equity index/vol/FX), Yahoo Finance (per-ticker equities) |
| Frontend       | React + Vite, built and served as static resources from the same Spring Boot jar (single process, single origin — no CORS) |
| Pricing        | Discounted cashflow (bonds), Black-Scholes (options), linear (equities) |
| Compute        | AWS EC2 (single instance), deployed via S3 + SSM (no SSH needed) |

## Project layout

```
full-revaluation/
├── pom.xml
├── src/main/java/com/martin/fullreval/
│   ├── model/           # Instrument (base), Bond, EuropeanOption, Equity, MarketScenario, RevaluationResult
│   ├── repository/      # Spring Data JPA repositories
│   ├── service/
│   │   ├── RevaluationService.java         # orchestrates the full revaluation run
│   │   ├── HistoricalScenarioService.java  # real historical scenarios from FRED
│   │   ├── YahooFinanceService.java        # real per-ticker equity returns
│   │   └── pricing/BlackScholesPricer.java
│   ├── controller/       # REST API: portfolios, scenarios, revaluation runs
│   └── dto/
├── src/main/resources/application.yml   # local / demo (H2) / rds (Postgres) profiles
├── sql/schema.sql        # Oracle DDL, kept for the CloudFormation option below — not used by the live deployment (which runs on Postgres via Hibernate auto-DDL)
├── infra/                # CloudFormation templates for an Oracle-based deployment (see caveat below)
├── analysis/             # Standalone Node scripts for offline robustness checks (e.g. bootstrap/
│                         # subperiod tests) whose RESULTS get quoted as static text in the UI —
│                         # kept here so those numbers are re-derivable, not just asserted
└── frontend/
    ├── src/App.jsx           # shell: header, portfolio switcher, tab nav
    ├── src/tabs/             # Dashboard, Portfolios, Scenarios tabs
    ├── src/api.js            # all backend calls in one place
    └── src/theme.js          # shared design tokens
```

## Running locally (no AWS, no cost)

```bash
mvn spring-boot:run -Dspring-boot.run.profiles=local
```

This uses an in-memory H2 database (fresh on every restart), so you can
develop and test the whole flow without any external dependency. For the
frontend, either run it separately for hot-reload:

```bash
cd frontend && npm install && npm run dev   # http://localhost:5173, talks to :8080
```

or build it into the backend's jar so one process serves both:

```bash
cd frontend && npm run build
cp -r dist/. ../src/main/resources/static/
cd .. && mvn clean package
java -jar target/full-revaluation-0.1.0.jar --spring.profiles.active=local
```

## How the live deployment actually works

The running instance is a single EC2 box + a private RDS PostgreSQL
database — simpler than the CloudFormation/Oracle path documented below, and
what's actually behind the deployed URL:

1. `mvn clean package` produces one fat jar with the frontend already built
   into it (same steps as above).
2. The jar is uploaded to a private S3 bucket.
3. The EC2 instance (systemd service `fullreval`) downloads it and restarts,
   triggered remotely via **SSM Run Command** — no SSH, no key pair, no open
   port 22.
4. It runs with `--spring.profiles.active=rds`, reading `DB_HOST` /
   `DB_USERNAME` / `DB_PASSWORD` from environment variables that a startup
   script populates by reading `DB_PASSWORD` out of **SSM Parameter Store**
   (SecureString) — the password is never in the jar, the systemd unit file,
   or this repo.

## Alternate path: CloudFormation + Oracle (`infra/`, `sql/schema.sql`)

These files describe a different, Oracle-based deployment (RDS Oracle or
EC2 + Oracle Database Free, behind Elastic Beanstalk) that predates the
Postgres setup actually running today. They still work if you want to stand
up that path instead — the app's `application.yml` still has the Oracle
profile block for it — but they are **not** what's live.

### Option A — RDS Oracle (managed, but Oracle license is never free)
`infra/rds-oracle.yaml`. RDS Free Tier does **not** cover Oracle under any
circumstance (only MariaDB, MySQL, PostgreSQL, SQL Server Express) — the
License Included model bills roughly 0.03-0.05 USD/hour on top of the
instance cost, continuously, until you delete the stack.
```bash
aws cloudformation create-stack --stack-name fullreval-db \
  --template-body file://infra/rds-oracle.yaml \
  --parameters ParameterKey=DBMasterPassword,ParameterValue=<strong-password> \
               ParameterKey=VpcId,ParameterValue=<vpc-id> \
               ParameterKey=SubnetIds,ParameterValue=<subnet-1>\\,<subnet-2> \
               ParameterKey=AllowedIngressCidr,ParameterValue=<your-cidr>
```

### Option B — EC2 + Oracle Database Free (the cheaper option)
`infra/ec2-oracle-free.yaml`. Oracle Database Free has **no license cost**
at all; the only spend is the EC2 instance itself, which can fall under the
AWS Free Tier for new accounts (750 hrs/month of t3.micro/t4g.micro for 12
months), or a few cents/hour otherwise if you stop it when not in use.
```bash
aws cloudformation create-stack --stack-name fullreval-db \
  --template-body file://infra/ec2-oracle-free.yaml \
  --parameters ParameterKey=VpcId,ParameterValue=<vpc-id> \
               ParameterKey=SubnetId,ParameterValue=<public-subnet> \
               ParameterKey=KeyPairName,ParameterValue=<your-keypair> \
               ParameterKey=AllowedSshCidr,ParameterValue=<your-ip>/32 \
               ParameterKey=AllowedAppCidr,ParameterValue=<app-tier-cidr> \
               ParameterKey=OraclePassword,ParameterValue=<strong-password>
```
Note: Oracle's download page normally requires accepting a license in a
browser before the installer is servable, so before launching you'll need
to grab a signed download URL from https://www.oracle.com/database/free/
and paste it into the template's `UserData` section (marked with a
`REPLACE_WITH_SIGNED_ORACLE_DOWNLOAD_URL` placeholder). This is a
restriction from Oracle's own distribution terms, not an AWS limitation.
Once installed, the service name is `FREEPDB1` on port 1521.

Then run `sql/schema.sql` against whichever endpoint you chose, and deploy
the backend with `eb init` / `eb create` using `infra/eb-env.config`.

## Cost control

RDS Oracle is the expensive piece (license-included, billed even when the
instance is stopped due to storage). Recommended workflow: stand the stack
up, use it for as long as you need it, then `aws cloudformation delete-stack`
when done. Re-create it from the template whenever you need it again. (The
live Postgres deployment is far cheaper — see the RDS free-tier terms.)

## Reliability caveats — read before trusting a number this prints

- Every scenario applies **one shared** rate/vol/FX shock to the whole
  portfolio; only equities get a real per-instrument override (via Yahoo
  Finance). A bond, an option, and an equity in different markets don't
  really share one spot/vol/rate factor in real life.
- No correlation structure between rate, spot, vol, and FX factors beyond
  what's implicit in the historical data itself.
- The stress-test presets (oil shock, recession) are illustrative constants,
  not calibrated to a specific historical episode.
- No backtesting has been run to check whether the VaR is actually
  well-calibrated (e.g. a Kupiec test on exception rates).

## Possible extensions

- Per-instrument risk factors and a cross-factor correlation structure,
  instead of one shared shock per scenario.
- Backtest the VaR (compare predicted breaches vs. actual historical
  outcomes) to check calibration.
- Move the instrument x scenario pricing loop from in-process
  `CompletableFuture` parallelism to AWS Batch or Lambda for the scale a real
  overnight risk run needs.
- Add PL/SQL/PL-pgSQL stored procedures for the percentile/VaR aggregation,
  moving that computation to the database side instead of Java.
