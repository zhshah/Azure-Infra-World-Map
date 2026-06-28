# Azure Infra World Map

### See your entire Azure estate — cost, security, health, governance and reliability — on one living world map.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)
[![deck.gl](https://img.shields.io/badge/deck.gl-9.3-1a1a1a)](https://deck.gl/)
[![Node](https://img.shields.io/badge/Node-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Azure](https://img.shields.io/badge/Azure-read--only-0078D4?logo=microsoftazure&logoColor=white)](https://azure.microsoft.com/)
[![Status](https://img.shields.io/badge/status-active-success)](#roadmap)

**Azure Infra World Map** is a real-time, single-pane command center for your Azure
estate. It pulls **100% live data** straight from Azure — Cost Management, Resource
Graph, Microsoft Defender for Cloud, Azure Advisor, Azure Monitor and Service Health —
and renders it on a cinematic **3D globe and world map**. Every region, every dollar,
every risk and every recommendation, visible at a glance.

It's the view an **executive** wants and the depth an **engineer** needs — running
entirely on your own machine, **read-only**, with **no secrets stored** and nothing
ever fabricated.

> **Created by [Zahir Hussain Shah](https://www.zahir.cloud)** — Senior Solution Engineer,
> Cloud &amp; AI / Infrastructure, **Microsoft Qatar**. See [About the Author](#about-the-author).

---

## Table of contents

- [Why Azure Infra World Map](#why-azure-infra-world-map)
- [Feature highlights](#feature-highlights)
- [Screenshots](#screenshots)
- [How it works](#how-it-works)
- [Tech stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [API reference](#api-reference)
- [Security &amp; privacy](#security--privacy)
- [Deploy to Azure](#deploy-to-azure)
- [Roadmap](#roadmap)
- [About the Author](#about-the-author)
- [License](#license)
- [Disclaimer](#disclaimer)

---

## Why Azure Infra World Map

The Azure portal is powerful, but the signal is **scattered**: cost lives in Cost
Management, posture in Defender for Cloud, recommendations in Advisor, incidents in
Service Health, and inventory in Resource Graph. Getting one coherent picture of "how
is my cloud doing — financially, operationally, and from a risk standpoint" means
hopping between a dozen blades and exporting spreadsheets.

**Azure Infra World Map unifies all of it into one living map.** Spin a 3D globe, watch
spend pulse across regions, flip on Danger Zones to see where risk concentrates, drill
into any resource for its cost, metrics, Defender findings and Advisor tips — then
export the whole story to Excel or PDF for your stakeholders.

- **One pane, many domains** — FinOps, security, reliability, governance and operations
  in a single, fast UI.
- **Real data only** — every number comes from a live Azure API call under your own
  identity. Nothing is mocked, sampled, or invented.
- **Read-only and private** — it reuses your `az login` session, runs locally, and never
  writes to your Azure environment or persists credentials.
- **Beautiful enough to demo, deep enough to operate** — built for executive readouts and
  day-to-day engineering alike.

## Feature highlights

### Live world map &amp; 3D globe
- **3D globe and flat world-map** projections of your Azure footprint.
- Regions weighted by **real spend** — neon cost bubbles, glow, and per-region detail.
- **Map modes:** Standard (cost-weighted bubbles), **Heatmap** (deck.gl spend density),
  and **Danger Zones** (risk halos and pulsing rings ranked by cost share).
- **Toggleable layers:** cost bubbles, heatmap, danger zones, **linkage arcs**
  (cross-region dependencies), **availability-zone markers**, labels and graticule.
- Click a region to open its **availability-zone topology** — Zone 1 / 2 / 3 plus a
  regional/non-zonal bucket, with zone-redundant resources flagged.

### Lenses (mission presets)
Switch the entire dashboard to a workflow with one click:
**Overview · Cost · Trends · Waste · Posture · Ops · Risk · WAF.** Each lens retunes the
map mode and the panel wall to the job at hand.

### FinOps &amp; cost intelligence
- **Spend KPIs** — total spend, change vs. the previous period, burn rate and a
  month-end **forecast**.
- **Cost Explorer** — group by service, resource group, location or resource type;
  **daily stacked** and **accumulated** views; **custom date ranges**; click-through drill-down.
- **Anomaly detection** on daily spend.
- **Cost concentration (Pareto / 80-20)** to find the few resources driving most cost.
- **Cost by service / by type / top resources.**
- **Waste &amp; optimization** — orphaned and idle resource detection with estimated savings.
- **Budgets** and spend tracking.

### Security, governance &amp; reliability
- **Microsoft Defender for Cloud** assessments, per resource.
- **Azure Advisor** recommendations.
- **Well-Architected (WAF) scoring** lens.
- **Tag governance / showback** — tag coverage and gaps for chargeback.
- **Service Health** and active alerts.
- **Backup posture** and **inventory composition** by type and region.

### Resource detail dock
Click any resource to slide in a detail panel with **Overview · Cost · Monitoring
(Azure Monitor metrics) · Security (Defender) · Advisor** tabs, plus change history and
Activity Log.

### Stay current
A **What's New** tab surfaces real **Microsoft Build / Microsoft Developer** videos so
your team keeps up with the platform.

### Make it yours &amp; share it
- **Custom views** — build and save your own panel layouts.
- **Export** the live picture to **Excel, PDF and CSV** for reports and stakeholders.

### Engineered for real estates
- **Throttle-resilient** cost pipeline — Cost Management 429 retry/backoff, serialized
  requests, memory + disk caching.
- **Optional Azure SQL cost cache** for long, throttle-proof history.

## Screenshots

> Drop your own screenshots into a `docs/screenshots/` folder and uncomment the lines
> below. (Screens are intentionally not bundled so the repo stays free of any real
> tenant data.)

<!--
![Overview — 3D globe with cost bubbles](docs/screenshots/overview.png)
![Cost Explorer — daily stacked spend](docs/screenshots/cost-explorer.png)
![Danger Zones — risk concentration](docs/screenshots/danger-zones.png)
![Resource detail dock — Defender & Advisor](docs/screenshots/resource-detail.png)
-->

What you'll see when you run it locally:

- A dark, full-bleed **command-center** shell: header (logo, lenses, subscription &amp;
  period picker, live clock) → map section → a wall of live panels → footer.
- A rotating **3D globe** with cost-weighted region bubbles and cross-region linkage arcs.
- A **panel wall** that re-flows per lens: KPIs, Cost Explorer, forecast, anomalies,
  Pareto, waste, tag governance, posture, service health and more.

## How it works

```mermaid
flowchart LR
  subgraph Browser["Browser — Vite + deck.gl SPA"]
    UI["wm.ts — shell, lenses, panels"]
    MAP["wmmap.ts — 3D globe / world map"]
    APIC["api.ts — typed fetch"]
  end
  subgraph Server["Node.js — Express API (server/index.mjs)"]
    AZ["azure.mjs — DefaultAzureCredential (read-only)"]
    CACHE[("memory + disk cache (.cache/)")]
    SQL[("optional Azure SQL cost cache")]
  end
  subgraph Azure["Azure — read-only APIs"]
    RG["Resource Graph"]
    CM["Cost Management"]
    DEF["Defender for Cloud"]
    ADV["Advisor"]
    MON["Azure Monitor"]
    SH["Service Health"]
  end

  UI --> APIC
  MAP --> APIC
  APIC -->|/api| AZ
  AZ --> RG
  AZ --> CM
  AZ --> DEF
  AZ --> ADV
  AZ --> MON
  AZ --> SH
  AZ --> CACHE
  AZ --> SQL
```

- The **frontend** (Vite + TypeScript + deck.gl) renders the globe/map and panels and
  talks only to the local API.
- The **backend** (Node.js + Express) authenticates with **`DefaultAzureCredential`** —
  your `az login` session locally, a **Managed Identity** when hosted in Azure — performs
  **read-only** Azure calls, and caches responses to be gentle on rate limits.
- In production the backend also serves the built SPA, so the UI and API share one origin.
- The Vite dev server runs on **`:8084`** and proxies `/api` to the Express server on
  **`:8085`**.

## Tech stack

| Layer | Technology |
| --- | --- |
| Frontend | TypeScript, Vite, [deck.gl](https://deck.gl/) (Map/Heatmap/Arc/Path layers), hand-rolled HTML/CSS (no UI framework) |
| Backend | Node.js, Express, `@azure/identity`, `@azure/arm-resourcegraph`, `@azure/arm-costmanagement`, `@azure/arm-resources`, `@azure/monitor-query`, `@azure/arm-managementgroups` |
| Auth | `DefaultAzureCredential` (Microsoft Entra) — `az` session locally, Managed Identity in Azure; read-only, multi-tenant |
| Optional cache | Azure SQL via `mssql` (Entra-only auth) |
| Data sources | Resource Graph, Cost Management, Defender for Cloud, Advisor, Azure Monitor, Service Health, Activity Log, Resource Health |

## Prerequisites

- **Node.js 20+**
- **Azure CLI** — signed in with `az login`
- Azure RBAC on the subscription(s) you want to inspect:
  - **Reader** — inventory, configuration, health, Advisor, metrics
  - **Cost Management Reader** — cost &amp; spend data
  - **Security Reader** *(recommended)* — full Microsoft Defender for Cloud findings

Everything the app does is **read-only**; none of these roles can change your environment.

## Quick start

```bash
# 1. Clone
git clone https://github.com/zhshah/Azure-Infra-World-Map.git
cd Azure-Infra-World-Map

# 2. Install dependencies
npm ci
# On Windows/ARM, if native build steps fail, use:
# npm ci --ignore-scripts

# 3. Sign in to Azure (read-only; reuses your CLI session)
az login

# 4. Start the API (:8085) and web (:8084) together
npm run dev
```

Then open **http://localhost:8084**, pick a subscription and a period, and explore.

Prefer to run the two processes separately?

```bash
npm run api      # Express API on :8085
npm run dev:web  # Vite dev server on :8084 (proxies /api -> :8085)
```

Build a production bundle of the frontend:

```bash
npm run build    # outputs to dist/
npm run preview  # serve the built bundle
```

## Configuration

All configuration is **optional** — the app works out of the box in read-only mode using
your `az` session. To customize, copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

| Variable | Purpose |
| --- | --- |
| `PORT` | API server port (default `8085`; in Azure App Service this is set for you) |
| `AZURE_SUBSCRIPTION_ID` | Subscription to load on startup (defaults to your `az` default, or seeds the picker when hosted) |
| `AZURE_TENANT_ID` | *(cloud/optional)* Scope the subscription picker to one tenant when running under a Managed Identity |
| `SQL_SERVER` / `SQL_DATABASE` | Optional Azure SQL cost cache (Entra auth, no password) for throttle-proof history |

> When hosted in Azure, the app uses its **Managed Identity** and the ARM Subscriptions
> API to enumerate subscriptions — no Azure CLI is required on the host. The optional
> Azure SQL cache authenticates with an Entra token (no SQL password). Schemas are created
> on first run.

## API reference

The backend exposes a read-only JSON API consumed by the SPA. Highlights:

| Route | Purpose |
| --- | --- |
| `GET /api/context` | Subscriptions, default subscription, cache status |
| `GET /api/summary?sub=&range=` | KPI bar: spend, Δ vs previous period, burn, forecast, counts, top service |
| `GET /api/regions?sub=&range=` | Per-region resource counts + cost (Cost Management `ResourceLocation`) |
| `GET /api/inventory?sub=` | Resource Graph inventory (+ linkage references) |
| `GET /api/cost?sub=&range=&groupBy=&granularity=` | Raw Cost Management query (service, RG, location, type) |
| `GET /api/optimize?sub=&range=` | Orphaned/idle waste findings + tag governance + estimated savings |
| `GET /api/region-zones?sub=&region=` | Availability-zone topology for a region |
| `GET /api/resource?id=&range=` | Properties + Azure Monitor metrics + daily cost + health |
| `GET /api/resource-security?id=` | Microsoft Defender for Cloud assessments for a resource |
| `GET /api/resource-recommendations?id=` | Azure Advisor recommendations for a resource |
| `GET /api/service-health?sub=` | Service Health events |
| `GET /api/portfolio` · `GET /api/portfolio-cost` | Multi-subscription rollups |

…plus management-group hierarchy, linkage, change history, Activity Log, resource facets
and more (see `server/index.mjs`).

## Security &amp; privacy

Security and privacy are first-class design goals:

- **Read-only.** The app never creates, updates or deletes Azure resources.
- **No stored credentials.** Authentication uses `DefaultAzureCredential` — your local
  Azure CLI session in dev, or a **Managed Identity** in Azure. No tokens, keys or
  passwords are written to disk by the app.
- **Your data stays local.** Live responses are cached only on your machine (under
  `.cache/`, which is **git-ignored**) and optionally in an Azure SQL database **you**
  own. Nothing is sent to any third party.
- **No secrets in the repo.** `.env`, `.cache/`, build output and local state are
  git-ignored. `.env.example` ships placeholders only.

> If you fork this project, keep your `.cache/` and `.env` out of source control — they
> can contain real subscription IDs, resource names and cost figures.

## Deploy to Azure

The app runs **either locally or in Azure with no code changes**. The Node server serves
both the API and the built SPA from a single origin, and authentication uses
`DefaultAzureCredential` — so it transparently uses your `az login` session locally and a
**Managed Identity** when hosted in Azure. (Verified: `npm run build` → the server serves
`dist/` and `/api/*` on one port.)

### Option A — Azure App Service (recommended)

A single Linux **Web App** hosts the whole tool (API + UI).

**1. Create the Web App** (Node 20 LTS):

```bash
RG=rg-infra-worldmap
PLAN=plan-infra-worldmap
APP=infra-worldmap-<unique>      # must be globally unique
LOCATION=westeurope

az group create -n $RG -l $LOCATION
az appservice plan create -g $RG -n $PLAN --is-linux --sku B1
az webapp create -g $RG -p $PLAN -n $APP --runtime "NODE:20-lts"
```

**2. Enable a system-assigned Managed Identity** and capture its principal ID:

```bash
az webapp identity assign -g $RG -n $APP
PRINCIPAL=$(az webapp identity show -g $RG -n $APP --query principalId -o tsv)
```

**3. Grant the identity read-only access** to the subscription(s) you want to inspect:

```bash
SUB=<subscription-id>
az role assignment create --assignee $PRINCIPAL --role "Reader" \
  --scope /subscriptions/$SUB
az role assignment create --assignee $PRINCIPAL --role "Cost Management Reader" \
  --scope /subscriptions/$SUB
# Optional — full Defender for Cloud findings:
az role assignment create --assignee $PRINCIPAL --role "Security Reader" \
  --scope /subscriptions/$SUB
```

> To cover a whole management group, scope to
> `/providers/Microsoft.Management/managementGroups/<mg-id>` instead.

**4. Configure build + app settings:**

```bash
az webapp config appsettings set -g $RG -n $APP --settings \
  SCM_DO_BUILD_DURING_DEPLOYMENT=true \
  AZURE_SUBSCRIPTION_ID=$SUB
# AZURE_TENANT_ID=<tenant-id>   # optional: scope the picker to one tenant
```

`SCM_DO_BUILD_DURING_DEPLOYMENT=true` lets Oryx run `npm install` + `npm run build` at
deploy time; the app then starts via `npm start` (`node server/index.mjs`), which serves
the freshly built `dist/`.

**5. Deploy the code** from the repo root:

```bash
az webapp up -g $RG -n $APP --runtime "NODE:20-lts"
# or zip-deploy a prebuilt bundle:
# npm run build && az webapp deploy -g $RG -n $APP --src-path . --type zip
```

**6. Protect it.** The tool surfaces cost and security data, so put identity in front of
it — enable **App Service Authentication (Easy Auth)** with Microsoft Entra ID:

```bash
az webapp auth update -g $RG -n $APP --enabled true \
  --action RedirectToLoginPage --redirect-provider azureactivedirectory
```

Browse to `https://<APP>.azurewebsites.net`.

### Option B — Azure Container Apps / containers

The same single-process model runs in any container host. A minimal `Dockerfile`:

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV PORT=8080
EXPOSE 8080
CMD ["npm", "start"]
```

Deploy to Azure Container Apps with a system- or user-assigned Managed Identity that holds
the same **Reader** + **Cost Management Reader** roles, then set `AZURE_SUBSCRIPTION_ID`
(and optionally `AZURE_TENANT_ID`) as environment variables.

### Notes

- **Authentication** uses `DefaultAzureCredential`: Managed Identity in Azure, your `az`
  session locally — no secrets stored.
- The **Activity Log** tab on the resource dock uses the Azure CLI and is unavailable on a
  pure cloud host; it degrades gracefully — every other feature works through the SDKs.
- For long, throttle-proof cost history, attach the optional **Azure SQL** cache and grant
  the Managed Identity access (Entra-only auth, no password).

## Roadmap

- LLM-backed analyst (the insights engine is rule-based today; an Azure OpenAI key can
  upgrade it to generative answers — the context object is already assembled).
- Budgets &amp; alerting (email/Teams).
- Azure Policy tag remediation and chargeback/showback exports.
- Multi-subscription management-group tree navigator.
- Scheduled Azure SQL / Storage sync jobs.
- Entra ID SSO + RBAC-scoped views for hosted deployments.

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## About the Author

<div align="center">

### Zahir Hussain Shah
**Senior Solution Engineer — Cloud &amp; AI / Infrastructure · Microsoft Qatar**

</div>

Zahir is a cloud and AI infrastructure specialist who helps enterprises **design,
secure, and optimize** their Azure estates. His day-to-day spans Azure infrastructure,
**FinOps**, **security &amp; governance**, reliability, and applied **AI** — translating
complex cloud telemetry into decisions leaders can act on.

**Azure Infra World Map** is the distillation of that field experience: the tool he
wished existed when walking customers through their cloud — one place that makes cost,
risk, health and governance instantly legible, beautiful enough to present and deep
enough to operate.

If this project is useful to you, a ⭐ on the repo means a lot — and I'd love to hear how
you're using it.

| | |
| --- | --- |
| **Email** | [zahir@zahir.cloud](mailto:zahir@zahir.cloud) |
| **Website** | [www.zahir.cloud](https://www.zahir.cloud) |
| **Focus** | Azure Infrastructure · Cloud &amp; AI · FinOps · Security · Reliability |

## License

Released under the **MIT License** — see [LICENSE](LICENSE). You are free to use, copy,
modify, and distribute it, including in your own environment.

## Disclaimer

This is a **personal, community project** and is **not an official Microsoft product**.
It is not endorsed by, affiliated with, or supported by Microsoft. All product names,
logos and brands are the property of their respective owners. The software is provided
"as is", without warranty of any kind, under the terms of the MIT License. Always review
what it queries and ensure you are authorized to access the Azure subscriptions you point
it at.

---

<div align="center">

**Built with care by [Zahir Hussain Shah](https://www.zahir.cloud) · Microsoft Qatar**

</div>
