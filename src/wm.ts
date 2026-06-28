import './wm.css';
import { api } from './api';
import { WMMap, type RegionArc, type MapMode, type LayerState } from './wmmap';
import { money, compactMoney, shortType, resName, num } from './format';
import { donut, gauge, metricChart, sparkline, columns, compact as compactNum } from './charts';
import { downloadXlsx, type XSheet, type XCell } from './xlsx';
import { typeIcon, typeColor, healthIcon } from './icons';
import { flagImg } from './regions-meta';
import { CustomTabs } from './customtabs';
import type {
  AppState, RegionAgg, InventoryResource, SummaryResp, AnalyticsResp, OptimizeResp,
  InsightsResp, ResourceDetail, RegionZonesResp, SecurityResp, RecommendationsResp, PostureResp, OpsResp,
  ChangesResp, ActivityResp, MetricsDetailResp, WhatsNewResp, WhatsNewUpdate, BuildCatalog,
  MgTreeResp, MgNode, PortfolioResp, ResourceFacetsResp, CostResp,
  ServiceHealthResp, ServiceHealthEvent, AlertsResp, AlertItem,
} from './types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const h = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const stripTags = (s: string) => String(s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

const state: AppState = { subscriptionId: null, range: '30d', showLinkage: false, currency: 'USD', selectedResourceId: null };
let map: WMMap;
let regionData: RegionAgg[] = [];
let invById = new Map<string, InventoryResource>();
let linkageLoaded: string | null = null;
let lens = 'overview';
let view: 'dashboard' | 'portfolio' | 'custom' = 'dashboard';
let customTabs: CustomTabs | null = null;
let depsLoaded: string | null = null;
// FinOps filter (client-side drill-down over loaded resources).
const filter = { text: '', rg: '', type: '' };
let lastAnalytics: AnalyticsResp | null = null;
// Last-rendered data per panel, used by the expand/detail modal.
const panelData: Record<string, unknown> = {};

// ---- Lens presets: map mode + which panels are shown ----------------------
const LENSES: Record<string, { label: string; mode: MapMode; panels: string[] }> = {
  overview: { label: 'Overview', mode: 'standard', panels: ['kpi', 'finkpi', 'regions', 'alerts', 'service', 'explorer', 'trend', 'forecast', 'anomaly', 'topres', 'pareto', 'alloc', 'invmix', 'insights', 'dow', 'waste', 'gov', 'security', 'advisor', 'resiliency', 'health', 'backup', 'monitoring', 'changes', 'deps', 'video'] },
  finops: { label: 'Cost', mode: 'standard', panels: ['kpi', 'finkpi', 'explorer', 'service', 'alloc', 'trend', 'forecast', 'topres', 'pareto', 'invmix', 'waste', 'gov', 'regions', 'dow', 'insights'] },
  trends: { label: 'Trends', mode: 'heatmap', panels: ['trend', 'explorer', 'forecast', 'anomaly', 'service', 'dow', 'kpi', 'finkpi', 'regions', 'topres', 'video'] },
  waste: { label: 'Waste', mode: 'danger', panels: ['kpi', 'finkpi', 'waste', 'gov', 'alloc', 'pareto', 'insights', 'topres', 'advisor'] },
  posture: { label: 'Posture', mode: 'standard', panels: ['alerts', 'health', 'security', 'advisor', 'resiliency', 'gov', 'insights'] },
  ops: { label: 'Ops', mode: 'standard', panels: ['alerts', 'health', 'backup', 'monitoring', 'changes', 'deps', 'resiliency'] },
  risk: { label: 'Risk', mode: 'danger', panels: ['alerts', 'gov', 'insights', 'waste', 'security', 'resiliency', 'health', 'kpi'] },
  waf: { label: 'WAF', mode: 'standard', panels: ['waf-score', 'waf-rel', 'waf-sec', 'waf-cost', 'waf-ops', 'waf-perf'] },
};

const LAYER_DEFS: { key: keyof LayerState; ico: string; label: string }[] = [
  { key: 'bubbles', ico: '\u25c9', label: 'Cost bubbles' },
  { key: 'heatmap', ico: '\u25b2', label: 'Heatmap' },
  { key: 'danger', ico: '\u26a0', label: 'Danger zones' },
  { key: 'health', ico: '\u2695', label: 'Service health' },
  { key: 'linkage', ico: '\u2941', label: 'Linkage' },
  { key: 'zones', ico: '\u25ad', label: 'AZ zones' },
  { key: 'labels', ico: 'A', label: 'Region labels' },
  { key: 'flags', ico: '\u2691', label: 'Flags' },
  { key: 'waste', ico: '\u2298', label: 'Waste overlay' },
  { key: 'untagged', ico: '\u25cb', label: 'Untagged' },
  { key: 'countries', ico: '\u25a6', label: 'Countries' },
  { key: 'graticule', ico: '#', label: 'Grid' },
];

async function init() {
  buildShell();
  map = new WMMap($('map'));
  map.onRegionClick((r) => focusZones(r.region, r.display));
  map.onZoneClick(openZoneResources);
  buildLayerToggles();
  startClock();
  renderVideo();
  showWelcome();

  $('subPicker').addEventListener('change', (e) => selectSubscription((e.target as HTMLSelectElement).value));
  $('filSub').addEventListener('change', (e) => selectSubscription((e.target as HTMLSelectElement).value));
  document.querySelectorAll('#periodTabs .period-tab').forEach((b) => b.addEventListener('click', () => {
    state.range = (b as HTMLElement).dataset.range!;
    document.querySelectorAll('#periodTabs .period-tab').forEach((x) => x.classList.toggle('active', x === b));
    facetsKey = '';
    loadAll();
    customTabs?.refresh();
  }));
  $('editionsBtn').addEventListener('click', openEditions);
  $('aboutBtn').addEventListener('click', openAbout);
  document.getElementById('creditBanner')?.addEventListener('click', openAbout);
  document.getElementById('brandLogo')?.addEventListener('click', openAbout);
  $('exportBtn').addEventListener('click', openExportMenu);
  document.querySelectorAll('.mode-btn[data-mode]').forEach((b) =>
    b.addEventListener('click', () => setMode((b as HTMLElement).dataset.mode as MapMode)));
  document.getElementById('projToggle')?.addEventListener('click', () => {
    const next = map.getProjection() === 'globe' ? 'flat' : 'globe';
    map.setProjection(next);
    const pb = document.getElementById('projToggle');
    if (pb) { pb.textContent = next === 'globe' ? 'Flat Map' : '3D Globe'; pb.classList.toggle('active', next === 'globe'); }
    renderMapLegend();
  });
  document.querySelectorAll('.lens-btn').forEach((b) =>
    b.addEventListener('click', () => setLens((b as HTMLElement).dataset.lens!)));
  document.querySelectorAll('.view-btn').forEach((b) =>
    b.addEventListener('click', () => setView((b as HTMLElement).dataset.view as 'dashboard' | 'portfolio')));

  // FinOps filter bar.
  let filterTimer: number | undefined;
  $('filText').addEventListener('input', (e) => {
    filter.text = (e.target as HTMLInputElement).value.trim().toLowerCase();
    clearTimeout(filterTimer);
    filterTimer = window.setTimeout(applyFilter, 160);
  });
  $('filRg').addEventListener('change', (e) => { filter.rg = (e.target as HTMLSelectElement).value.toLowerCase(); applyFilter(); });
  $('filType').addEventListener('change', (e) => { filter.type = (e.target as HTMLSelectElement).value.toLowerCase(); applyFilter(); });
  $('filClear').addEventListener('click', () => {
    filter.text = ''; filter.rg = ''; filter.type = '';
    ($('filText') as HTMLInputElement).value = '';
    ($('filRg') as HTMLSelectElement).value = '';
    ($('filType') as HTMLSelectElement).value = '';
    applyFilter();
  });

  try {
    const ctx = await api.context();
    const picker = $<HTMLSelectElement>('subPicker');
    const fsub = $<HTMLSelectElement>('filSub');
    picker.innerHTML = ''; fsub.innerHTML = '';
    for (const s of ctx.subscriptions) {
      const o = document.createElement('option'); o.value = s.subscriptionId; o.textContent = s.displayName; picker.appendChild(o);
      const o2 = document.createElement('option'); o2.value = s.subscriptionId; o2.textContent = s.displayName; fsub.appendChild(o2);
    }
    allSubs = ctx.subscriptions.map((s) => ({ subscriptionId: s.subscriptionId, displayName: s.displayName }));
    state.subscriptionId = ctx.defaultSubscriptionId || ctx.subscriptions[0]?.subscriptionId || null;
    if (state.subscriptionId) { picker.value = state.subscriptionId; fsub.value = state.subscriptionId; }
    // Demo build: show a generic, shareable label instead of the signed-in UPN.
    $('userName').textContent = 'Demo Edition · Can be integrated with Entra ID';
    $('footerCtx').textContent = `Demo Edition · ${ctx.subscriptions.length} sub · live api`;
    setLens('overview');
    await loadAll();
    customTabs = new CustomTabs({
      barHost: $('customTabsBar'),
      viewHost: $('customView'),
      getResources: () => [...invById.values()],
      getFacets: () => facetsData,
      ensureFacets,
      openResource: (id) => openDock(id),
      showCustomView,
      backToDashboard: () => setView('dashboard'),
    });
    customTabs.init();
    startLiveRefresh();
    const resParam = new URLSearchParams(location.search).get('res');
    if (resParam) openDock(resParam);
  } catch (err: any) {
    showBanner(`Cannot reach Azure: ${err.message}`);
  }
}

// One-time (per browser session) welcome banner that signals this is a read-only
// demo environment. Reuses the shared modal; dismiss with the button, X, or Escape.
function showWelcome() {
  try { if (sessionStorage.getItem('wm_welcome_seen')) return; } catch { /* ignore */ }
  showWnModal(
    `<div class="wm-welcome">` +
      `<div class="wm-welcome-badge">DEMO ENVIRONMENT</div>` +
      `<h2 class="wm-welcome-title">Welcome to Azure Infra World Map</h2>` +
      `<p class="wm-welcome-lead">This is a <b>demo environment</b> with <b>read-only</b> data access.</p>` +
      `<ul class="wm-welcome-points">` +
        `<li>Shows <b>live Azure data</b> via a read-only managed identity</li>` +
        `<li><b>No write access</b> — nothing is ever created, changed or deleted</li>` +
        `<li>No secrets stored · hosted in a demo subscription</li>` +
      `</ul>` +
      `<button class="wm-welcome-btn" id="wmWelcomeBtn">Explore the demo</button>` +
    `</div>`,
    'welcome',
  );
  try { sessionStorage.setItem('wm_welcome_seen', '1'); } catch { /* ignore */ }
  document.getElementById('wmWelcomeBtn')?.addEventListener('click', closeWnModal);
}

function buildShell() {
  $('app').innerHTML = `
  <header class="header">
    <div class="header-left">
      <div class="logo" id="brandLogo" title="About Azure Infra World Map"><span class="logo-name">AZURE INFRA <b>WORLD MAP</b></span><span class="logo-sub">GLOBAL CLOUD INTELLIGENCE</span></div>
      <div class="view-nav" id="viewNav">
        <button class="view-btn active" data-view="dashboard">\u25a6 Dashboard</button>
        <button class="view-btn" data-view="portfolio">\u26ff Portfolio</button>
      </div>
      <div class="lens-switcher" id="lensSwitcher">${Object.entries(LENSES).map(([k, v]) => `<button class="lens-btn" data-lens="${k}">${v.label}</button>`).join('')}</div>
    </div>
    <div class="header-center">
      <select id="subPicker" class="hsel"></select>
      <div class="period-tabs" id="periodTabs">${['1d', '7d', '14d', '30d', '60d', '90d'].map((r) => `<button class="period-tab ${r === '30d' ? 'active' : ''}" data-range="${r}">${r.toUpperCase()}</button>`).join('')}</div>
    </div>
    <div class="header-right">
      <span class="credit-banner" id="creditBanner" title="Solution Developed by Zahir Hussain Shah · Sr. Solution Engineer — click for About"><span class="credit-l1">Solution Developed by</span><span class="credit-l2"><b>Zahir Hussain Shah</b> · Sr. Solution Engineer</span></span>
      <button id="aboutBtn" class="hbtn">About</button>
      <button id="exportBtn" class="hbtn" title="Export report — Excel, PDF or CSV">⤓ Export</button>
      <button id="editionsBtn" class="hbtn">Editions</button>
      <span id="liveClock" class="hclock"></span>
      <span id="userName" class="huser" title="Demo Edition - sign-in can be integrated with Microsoft Entra ID"></span>
    </div>
  </header>
  <div id="banner"></div>
  <div id="alertTicker" class="alert-ticker hidden"></div>
  <main class="main-content split-dash">
    <div class="tab-strip" id="tabStrip"><span class="tab-strip-label">CUSTOM VIEWS</span><div class="ctabs" id="customTabsBar"></div></div>
    <section class="map-section">
      <div class="panel-header">
        <span class="panel-title">Global Azure Map</span>
        <div class="map-modes" id="mapModes">
          <button class="mode-btn active" data-mode="standard">Standard</button>
          <button class="mode-btn" data-mode="heatmap">Heatmap</button>
          <button class="mode-btn" data-mode="danger">Danger Zones</button>
          <button class="mode-btn proj-btn active" id="projToggle" title="Switch between the interactive 3D globe and the flat map">Flat Map</button>
        </div>
        <div class="map-meta" id="mapMeta"></div>
      </div>
      <div class="map-container">
        <div id="map"></div>
        <div id="focusBar" class="focus-bar hidden"></div>
        <div class="layer-toggles" id="layerToggles"></div>
        <div id="mapLegend" class="map-legend"></div>
        <div id="mapStatus" class="map-status">LOADING\u2026</div>
        <div id="zoneView" class="zone-view hidden"></div>
      </div>
    </section>
    <div class="finops-filter" id="finopsFilter">
      <span class="ff-label">RESOURCE FILTER</span>
      <select id="filSub" class="ff-sel ff-sub" title="Subscription"></select>
      <input id="filText" class="ff-input" placeholder="search name or type\u2026" autocomplete="off" />
      <select id="filRg" class="ff-sel"><option value="">All resource groups</option></select>
      <select id="filType" class="ff-sel"><option value="">All types</option></select>
      <button id="filClear" class="ff-clear">\u2715 Clear</button>
      <span class="ff-summary" id="filSummary"></span>
    </div>
    <div class="panels-grid" id="panelsGrid"></div>
    <div class="portfolio-view hidden" id="portfolioView"></div>
    <div class="custom-view hidden" id="customView"></div>
  </main>
  <footer class="site-footer">
    <span><span class="site-footer-name">AZURE INFRA WORLD MAP</span><span class="site-footer-sub">GLOBAL CLOUD INTELLIGENCE · Developed by Zahir Hussain Shah</span></span>
    <span class="site-footer-mid">Microsoft Confidential</span>
    <span class="site-footer-copy" id="footerCtx"></span>
  </footer>
  <div id="detailDock" class="detail-dock hidden"></div>
  <div id="modalRoot" class="modal-root hidden"></div>`;

  // Build the panel skeletons once.
  const defs: { key: string; title: string; cls?: string }[] = [
    { key: 'kpi', title: 'Spend Overview', cls: 'col-2' },
    { key: 'finkpi', title: 'Cost Scorecard', cls: 'col-2' },
    { key: 'alerts', title: 'Active Alerts \u00b7 Azure Monitor', cls: 'col-2 row-2' },
    { key: 'service', title: 'Cost by Service' },
    { key: 'trend', title: 'Daily Spend Trend', cls: 'col-2' },
    { key: 'topres', title: 'Top Resources', cls: 'row-2' },
    { key: 'waste', title: 'Waste & Optimize' },
    { key: 'insights', title: 'AI Insights', cls: 'col-2' },
    { key: 'gov', title: 'Tag Governance' },
    { key: 'alloc', title: 'Cost Allocation \u00b7 Showback', cls: 'col-2' },
    { key: 'regions', title: 'Regions' },
    { key: 'security', title: 'Security \u00b7 Defender' },
    { key: 'advisor', title: 'Advisor Recommendations' },
    { key: 'resiliency', title: 'Resiliency \u00b7 Zones' },
    { key: 'health', title: 'Service Health' },
    { key: 'backup', title: 'Backup \u00b7 BCDR' },
    { key: 'monitoring', title: 'Monitoring \u00b7 VM Insights' },
    { key: 'changes', title: 'Change Tracking' },
    { key: 'deps', title: 'Dependency Map' },
    { key: 'forecast', title: 'Spend Forecast', cls: 'col-2' },
    { key: 'anomaly', title: 'Spend Anomalies', cls: 'col-2' },
    { key: 'pareto', title: 'Cost Concentration' },
    { key: 'invmix', title: 'Inventory Composition' },
    { key: 'dow', title: 'Weekly Spend Pattern' },
    { key: 'explorer', title: 'Cost Explorer \u00b7 Analysis', cls: 'col-2' },
    { key: 'waf-score', title: 'Well-Architected Score', cls: 'col-2' },
    { key: 'waf-rel', title: 'Reliability \u00b7 WAF' },
    { key: 'waf-sec', title: 'Security \u00b7 WAF' },
    { key: 'waf-cost', title: 'Cost Optimization \u00b7 WAF', cls: 'col-2' },
    { key: 'waf-ops', title: 'Operational Excellence \u00b7 WAF' },
    { key: 'waf-perf', title: 'Performance Efficiency \u00b7 WAF' },
    { key: 'video', title: "What's New \u00b7 Azure Live", cls: 'col-2 row-2' },
  ];
  $('panelsGrid').innerHTML = defs.map((d) =>
    `<div class="panel ${d.cls || ''}" data-key="${d.key}">
      <div class="panel-head"><span class="sev-dot normal" id="sev-${d.key}"></span><span class="pt">${d.title}</span>
        <span class="live-badge">LIVE</span><span class="pcount" id="cnt-${d.key}"></span>${(d.key === 'video' || d.key === 'alerts' || d.key === 'alloc' || d.key === 'finkpi' || d.key === 'forecast' || d.key === 'anomaly' || d.key === 'pareto' || d.key === 'invmix' || d.key === 'dow' || d.key === 'explorer' || d.key.startsWith('waf')) ? '' : `<button class="panel-expand" data-key="${d.key}" title="Expand \u00b7 what is this?"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/></svg></button>`}</div>
      <div class="panel-body" id="body-${d.key}"><span class="muted">\u2026</span></div>
    </div>`).join('');
  $('panelsGrid').querySelectorAll('.panel-expand').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); openPanelDetail((b as HTMLElement).dataset.key!); }));
}

function startClock() {
  const tick = () => { $('liveClock').textContent = new Date().toUTCString().slice(17, 25) + ' UTC'; };
  tick(); setInterval(tick, 1000);
}

// Re-poll active alerts + service health so resolved/closed items disappear automatically.
function startLiveRefresh() {
  setInterval(() => {
    const sub = state.subscriptionId;
    if (!sub || document.hidden) return;
    api.alerts(sub).then((d) => { if (state.subscriptionId === sub) renderAlerts(d); }).catch(() => {});
    api.serviceHealth(sub).then((d) => { if (state.subscriptionId === sub) renderServiceHealth(d); }).catch(() => {});
  }, 60000);
}

function buildLayerToggles() {
  const host = $('layerToggles');
  host.innerHTML = `<div class="layer-toggles-title">Layers</div>` + LAYER_DEFS.map((l) =>
    `<button class="layer-toggle" data-layer="${l.key}"><span class="lt-ico">${l.ico}</span>${l.label}</button>`).join('');
  host.querySelectorAll('.layer-toggle').forEach((b) => b.addEventListener('click', async () => {
    const key = (b as HTMLElement).dataset.layer as keyof LayerState;
    const on = !map.getLayers()[key];
    if (key === 'linkage' && on) await ensureLinkage();
    map.setLayer(key, on);
    syncLayerToggles();
  }));
  syncLayerToggles();
}
function syncLayerToggles() {
  const L = map.getLayers();
  $('layerToggles').querySelectorAll('.layer-toggle').forEach((b) => {
    const key = (b as HTMLElement).dataset.layer as keyof LayerState;
    b.classList.toggle('active', !!L[key]);
  });
  document.querySelectorAll('.mode-btn[data-mode]').forEach((b) =>
    b.classList.toggle('active', (b as HTMLElement).dataset.mode === map.getMode()));
}

let mapTotalCost = 0;
function renderMapLegend() {
  const el = document.getElementById('mapLegend'); if (!el) return;
  const mode = map.getMode();
  const tot = `<b>${compactMoney(mapTotalCost, state.currency)}</b> total spend`;
  if (mode === 'heatmap') {
    el.innerHTML = `${tot}<br/><span class="lg-row"><i class="lg-heat"></i>cost density \u00b7 cool \u2192 hot</span><br/><span class="small">brighter = spend concentrated here</span>`;
  } else if (mode === 'danger') {
    el.innerHTML = `RISK MAP \u00b7 ${tot}<br/><span class="lg-row"><i class="lg-dot" style="background:#ff4444"></i>issue<i class="lg-dot" style="background:#ff8800"></i>idle waste<i class="lg-dot" style="background:#ffaa00"></i>untagged<i class="lg-dot" style="background:#78be5a"></i>clean</span><br/><span class="small">click a region \u2192 drill into resources</span>`;
  } else {
    el.innerHTML = `${tot}<br/><span class="lg-row"><i class="lg-dot" style="background:#44ff88"></i>bubble size = cost weight</span><br/><span class="small">click a region \u2192 availability zones</span>`;
  }
}
function setMode(mode: MapMode) {
  map.setMode(mode);
  renderMapLegend();
  syncLayerToggles();
}
function setLens(key: string) {
  lens = key;
  const def = LENSES[key]; if (!def) return;
  document.querySelectorAll('.lens-btn').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.lens === key));
  setMode(def.mode);
  // Show only the lens panels, in order.
  document.querySelectorAll('#panelsGrid .panel').forEach((p) => {
    const k = (p as HTMLElement).dataset.key!;
    const idx = def.panels.indexOf(k);
    (p as HTMLElement).style.display = idx >= 0 ? '' : 'none';
    (p as HTMLElement).style.order = idx >= 0 ? String(idx) : '99';
  });
  if (def.panels.includes('explorer')) ensureExplorer();
}

// ---- View switching (Dashboard <-> Enterprise Portfolio) ------------------
function setView(v: 'dashboard' | 'portfolio') {
  view = v;
  customTabs?.clearActive();
  document.querySelectorAll('.view-btn').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.view === v));
  const dash = view === 'dashboard';
  document.querySelector('.map-section')?.classList.toggle('hidden', !dash);
  document.getElementById('finopsFilter')?.classList.toggle('hidden', !dash);
  $('panelsGrid').classList.toggle('hidden', !dash);
  $('lensSwitcher').classList.toggle('hidden', !dash);
  $('portfolioView').classList.toggle('hidden', v !== 'portfolio');
  $('customView').classList.add('hidden');
  if (v === 'portfolio') ensurePortfolio();
}

// ---- Custom tabs: dynamic, savable filtered resource views ----------------
// Hide the built-in surfaces and reveal the custom grid.
function showCustomView() {
  view = 'custom';
  document.querySelectorAll('.view-btn').forEach((b) => b.classList.remove('active'));
  document.querySelector('.map-section')?.classList.add('hidden');
  document.getElementById('finopsFilter')?.classList.add('hidden');
  $('panelsGrid').classList.add('hidden');
  $('lensSwitcher').classList.add('hidden');
  $('portfolioView').classList.add('hidden');
  $('customView').classList.remove('hidden');
}
let facetsData: ResourceFacetsResp | null = null;
let facetsKey = '';
function ensureFacets(then: () => void) {
  const sub = state.subscriptionId; if (!sub) { then(); return; }
  const key = `${sub}:${state.range}`;
  if (facetsKey === key && facetsData) { then(); return; }
  api.resourceFacets(sub, state.range).then((f) => { facetsData = f; facetsKey = key; then(); }).catch(() => then());
}

// ---- Enterprise portfolio (management groups + cross-subscription rollup) --
let mgTreeData: MgTreeResp | null = null;
const mgExpanded = new Set<string>();
let pfMg = ''; let pfMgDisplay = '';
let portfolioData: PortfolioResp | null = null;
let pfSort = 'resources';

function ensurePortfolio() {
  if (mgTreeData) { renderPortfolio(); return; }
  $('portfolioView').innerHTML = '<div class="pf-loading"><span class="muted">loading management-group hierarchy\u2026</span></div>';
  api.mgTree().then((t) => {
    mgTreeData = t;
    if (t.tree) { mgExpanded.add(t.tree.id); loadPortfolio(t.tree.name, t.tree.displayName); }
    else { $('portfolioView').innerHTML = `<div class="pf-loading"><span class="muted">Management groups unavailable: ${h(t.error || 'no access')}</span></div>`; }
  }).catch((e) => { $('portfolioView').innerHTML = `<div class="pf-loading"><span class="muted">${h(e.message)}</span></div>`; });
}
function loadPortfolio(mg: string, display: string) {
  pfMg = mg; pfMgDisplay = display; portfolioData = null;
  renderPortfolio();
  api.portfolio(mg).then((p) => {
    if (pfMg !== mg) return;
    portfolioData = p; renderPortfolio();
    loadPortfolioCost(mg, p);
  }).catch(() => renderPortfolio());
}
function loadPortfolioCost(mg: string, p: PortfolioResp) {
  api.portfolioCost(mg, state.range).then((c) => {
    if (pfMg !== mg || !portfolioData) return;
    if (!c.error && Object.keys(c.byId).length) {
      for (const s of portfolioData.subs) s.cost = c.byId[s.subscriptionId.toLowerCase()] ?? s.cost;
      renderPortfolio();
    } else {
      // Fallback: per-subscription cost for the top subs (capped to avoid throttling).
      (async () => {
        for (const s of p.subs.slice(0, 12)) {
          if (pfMg !== mg) return;
          try { const sum = await api.summary(s.subscriptionId, state.range); s.cost = sum.totalCost; if (portfolioData && pfMg === mg) renderPortfolio(); } catch { /* ignore */ }
        }
      })();
    }
  }).catch(() => { /* ignore */ });
}

function mgPath(root: MgNode | null | undefined, name: string): MgNode[] {
  if (!root) return [];
  const stack: MgNode[][] = [[root]];
  while (stack.length) {
    const path = stack.pop()!;
    const node = path[path.length - 1];
    if (node.type === 'mg' && node.name === name) return path;
    for (const c of node.children) if (c.type === 'mg') stack.push([...path, c]);
  }
  return [root];
}
function mgNodeHtml(n: MgNode, depth: number): string {
  const isMg = n.type === 'mg';
  const hasKids = n.children.length > 0;
  const open = mgExpanded.has(n.id);
  const sel = isMg && n.name === pfMg ? ' selected' : '';
  const tog = isMg && hasKids ? (open ? '\u25be' : '\u25b8') : '';
  const kids = (isMg && open && hasKids) ? `<div class="pf-node-kids">${n.children.map((c) => mgNodeHtml(c, depth + 1)).join('')}</div>` : '';
  return `<div class="pf-node">` +
    `<div class="pf-node-row${sel}" data-id="${h(n.id)}" data-name="${h(n.name)}" data-disp="${h(n.displayName)}" data-type="${n.type}" style="padding-left:${6 + depth * 13}px">` +
      `<span class="pf-node-tog" data-id="${h(n.id)}">${tog}</span>` +
      `<span class="pf-node-ico ${isMg ? 'mg' : 'sub'}"></span>` +
      `<span class="pf-node-name" title="${h(n.displayName)}">${h(n.displayName)}</span>` +
      (isMg ? `<span class="pf-node-badge" title="descendants">${n.descendants}</span>` : '') +
    `</div>${kids}</div>`;
}
function pfKpi(value: string, label: string, sev = ''): string {
  return `<div class="pf-kpi"><div class="pf-kpi-v ${sev}">${value}</div><div class="pf-kpi-l">${h(label)}</div></div>`;
}
function pfTable(p: PortfolioResp, cur: string): string {
  const sorters: Record<string, (a: typeof p.subs[number], b: typeof p.subs[number]) => number> = {
    resources: (a, b) => b.resources - a.resources,
    cost: (a, b) => (b.cost || 0) - (a.cost || 0),
    security: (a, b) => (b.secHigh * 3 + b.secMed) - (a.secHigh * 3 + a.secMed),
    advisor: (a, b) => b.advisor - a.advisor,
    name: (a, b) => a.displayName.localeCompare(b.displayName),
  };
  const subs = p.subs.slice().sort(sorters[pfSort] || sorters.resources);
  const rows = subs.map((s) => {
    const zp = s.resources ? Math.round((s.zonePinned / s.resources) * 100) : 0;
    return `<tr class="pf-row" data-sub="${h(s.subscriptionId)}"><td><span class="pf-sub-name">${h(s.displayName)}</span></td>` +
      `<td class="num">${num(s.resources)}</td>` +
      `<td class="num">${s.cost != null ? money(s.cost, cur) : '\u2014'}</td>` +
      `<td class="num"><span class="pf-sev ${s.secHigh ? 'crit' : 'zero'}">${s.secHigh}</span> / <span class="pf-sev ${s.secMed ? 'high' : 'zero'}">${s.secMed}</span></td>` +
      `<td class="num ${zp < 20 ? 'pf-warn' : ''}">${zp}%</td>` +
      `<td class="num">${num(s.advisor)}</td>` +
      `<td class="num"><span class="pf-open">Open \u203a</span></td></tr>`;
  }).join('');
  const th = (key: string, label: string, cls = '') => `<th class="pf-th ${cls} ${pfSort === key ? 'active' : ''}" data-sort="${key}">${label}${pfSort === key ? ' \u25be' : ''}</th>`;
  return `<table class="pf-table"><thead><tr>${th('name', 'Subscription')}${th('resources', 'Resources', 'num')}${th('cost', 'Cost', 'num')}${th('security', 'Security H / M', 'num')}<th class="num">Zone-pinned</th>${th('advisor', 'Advisor', 'num')}<th class="num"></th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="muted">no subscriptions with resources in this scope</td></tr>'}</tbody></table>`;
}
function renderPortfolio() {
  const host = $('portfolioView');
  const tree = mgTreeData?.tree;
  const counts = mgTreeData?.counts;
  const p = portfolioData;
  const cur = state.currency || 'USD';
  const crumbs = mgPath(tree, pfMg).map((n) => `<button class="pf-crumb" data-mg="${h(n.name)}" data-disp="${h(n.displayName)}">${h(n.displayName)}</button>`).join('<span class="pf-crumb-sep">\u203a</span>');
  const t = p?.totals;
  const zp = t && t.resources ? Math.round((t.zonePinned / t.resources) * 100) : 0;
  const costTotal = p ? p.subs.reduce((s, x) => s + (x.cost || 0), 0) : 0;
  const anyCost = p ? p.subs.some((x) => x.cost != null) : false;
  const kpis = t ? `<div class="pf-kpis">` +
    pfKpi(String(t.subscriptions), 'subscriptions') +
    pfKpi(num(t.resources), 'resources') +
    pfKpi(anyCost ? compactMoney(costTotal, cur) : '\u2014', 'cost / period') +
    pfKpi(num(t.secHigh), 'security \u00b7 high', t.secHigh > 0 ? 'crit' : '') +
    pfKpi(num(t.secMed), 'security \u00b7 medium', t.secMed > 0 ? 'high' : '') +
    pfKpi(zp + '%', 'zone-pinned', zp < 20 ? 'high' : '') +
    pfKpi(num(t.advisor), 'advisor recs') +
    `</div>` : '<div class="pf-kpis"><span class="muted" style="padding:10px">loading cross-subscription rollup\u2026</span></div>';
  host.innerHTML =
    `<aside class="pf-tree-panel"><div class="pf-tree-head">Management groups${counts ? `<span class="pf-tree-counts">${counts.mgs} MG \u00b7 ${counts.subscriptions} sub</span>` : ''}</div>` +
      `<div class="pf-tree" id="pfTree">${tree ? mgNodeHtml(tree, 0) : '<span class="muted">no hierarchy</span>'}</div></aside>` +
    `<section class="pf-main"><div class="pf-scope-head"><div class="pf-crumbs">${crumbs}</div>` +
      `<div class="pf-scope-title">${h(pfMgDisplay)} <span class="pf-scope-sub">portfolio rollup</span></div></div>` +
      kpis +
      (p ? pfTable(p, cur) : '') +
      (p?.errors ? `<div class="pf-note">Partial rollup (insufficient access for: ${h(Object.keys(p.errors).join(', '))}).</div>` : '') +
    `</section>`;
  wirePortfolio();
}
function wirePortfolio() {
  document.querySelectorAll('#pfTree .pf-node-tog').forEach((el) => el.addEventListener('click', (e) => {
    e.stopPropagation();
    const id = (el as HTMLElement).dataset.id!; if (!id) return;
    if (mgExpanded.has(id)) mgExpanded.delete(id); else mgExpanded.add(id);
    renderPortfolio();
  }));
  document.querySelectorAll('#pfTree .pf-node-row').forEach((el) => el.addEventListener('click', () => {
    const type = (el as HTMLElement).dataset.type; const name = (el as HTMLElement).dataset.name!; const disp = (el as HTMLElement).dataset.disp!;
    if (type === 'mg') { mgExpanded.add((el as HTMLElement).dataset.id!); loadPortfolio(name, disp); }
    else openSubscription(name, disp);
  }));
  document.querySelectorAll('#portfolioView .pf-crumb').forEach((el) => el.addEventListener('click', () => loadPortfolio((el as HTMLElement).dataset.mg!, (el as HTMLElement).dataset.disp!)));
  document.querySelectorAll('#portfolioView .pf-th[data-sort]').forEach((el) => el.addEventListener('click', () => { pfSort = (el as HTMLElement).dataset.sort!; renderPortfolio(); }));
  document.querySelectorAll('#portfolioView .pf-row').forEach((el) => el.addEventListener('click', () => {
    const sub = (el as HTMLElement).dataset.sub!;
    openSubscription(sub, portfolioData?.subs.find((s) => s.subscriptionId === sub)?.displayName || sub);
  }));
}
function openSubscription(subId: string, display: string) {
  state.subscriptionId = subId; linkageLoaded = null; depsLoaded = null; expKey = ''; expData = null;
  const picker = $<HTMLSelectElement>('subPicker');
  if (![...picker.options].some((o) => o.value === subId)) {
    const o = document.createElement('option'); o.value = subId; o.textContent = display; picker.appendChild(o);
  }
  picker.value = subId;
  setView('dashboard');
  loadAll();
}

// ---- Live critical-alerts ticker (WorldMonitor-style) ---------------------
function updateTicker() {
  const items: { sev: string; text: string }[] = [];
  const al = panelData.alertsData as AlertsResp | undefined;
  if (al && al.total) { const crit = (al.sevCounts?.Sev0 || 0) + (al.sevCounts?.Sev1 || 0); items.push({ sev: crit ? 'crit' : 'high', text: `${al.total} active Azure Monitor alert${al.total === 1 ? '' : 's'}${crit ? ` \u00b7 ${crit} critical` : ''}` }); }
  const sh = panelData.svcHealth as ServiceHealthResp | undefined;
  if (sh) for (const e of (sh.events || []).filter((x) => x.status === 'issue').slice(0, 4)) items.push({ sev: 'crit', text: `Service issue: ${e.title}` });
  const p = panelData.security as PostureResp | undefined;
  if (p) {
    const high = (p.security || []).filter((x) => x.status === 'Unhealthy' && String(x.severity).toLowerCase() === 'high').reduce((s, x) => s + x.count, 0);
    if (high) items.push({ sev: 'crit', text: `${high} high-severity security findings` });
    if (p.resiliency && p.resiliency.total && p.resiliency.zonePinned === 0) items.push({ sev: 'high', text: `0 of ${p.resiliency.total} resources zone-pinned \u00b7 single-zone risk` });
  }
  const o = panelData.backup as OpsResp | undefined;
  if (o && o.vmCount > 0 && o.backup && o.backup.protectedItems === 0) items.push({ sev: 'high', text: `${o.vmCount} VMs with no backup protection` });
  if (o && o.vmCount > 0 && o.monitoredVms === 0) items.push({ sev: 'high', text: 'No VM monitoring coverage detected' });
  const w = panelData.waste as OptimizeResp | undefined;
  if (w && w.estimatedMonthlySavings > 1) items.push({ sev: 'low', text: `${money(w.estimatedMonthlySavings, w.currency)}/mo potential savings from waste` });
  const ins = panelData.insights as InsightsResp | undefined;
  if (ins) for (const i of (ins.insights || []).filter((x) => x.severity === 'warn').slice(0, 3)) items.push({ sev: 'high', text: i.title });
  const bar = $('alertTicker');
  if (!items.length) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  bar.classList.remove('hidden');
  const ico = (s: string) => s === 'crit' ? '\u26d4' : s === 'high' ? '\u26a0' : '\u25cf';
  const seq = items.map((i) => `<span class="tk-item ${i.sev}">${ico(i.sev)} ${h(i.text)}</span>`).join('<span class="tk-sep">\u00b7</span>');
  bar.innerHTML = `<span class="tk-label">LIVE ALERTS</span><div class="tk-track"><div class="tk-marquee">${seq}<span class="tk-sep">\u00b7</span>${seq}</div></div>`;
}

let loadGen = 0;
// Subscription change from EITHER the header picker or the FinOps filter bar.
// Keeps both selects in sync and reloads every dashboard panel for the new sub.
function selectSubscription(id: string) {
  if (!id) return;
  state.subscriptionId = id;
  const p = document.getElementById('subPicker') as HTMLSelectElement | null; if (p && p.value !== id) p.value = id;
  const f = document.getElementById('filSub') as HTMLSelectElement | null; if (f && f.value !== id) f.value = id;
  linkageLoaded = null; depsLoaded = null; facetsKey = '';
  expKey = ''; expData = null;
  loadAll(); customTabs?.refresh();
}
async function loadAll() {
  if (!state.subscriptionId) return;
  const sub = state.subscriptionId;
  const gen = ++loadGen;
  closeZoneView(); closeDock();
  exitFocus();
  regionData = [];
  setStatus('LOADING\u2026');
  // Inventory (for detail enrichment) + region map.
  api.inventory(sub).then((inv) => { if (gen !== loadGen) return; invById = new Map(inv.resources.map((r) => [r.id.toLowerCase(), r])); populateFilters(); renderAlloc(); renderFinKpi(); renderInvMix(); renderPareto(); }).catch(() => {});
  loadPanels(sub, gen);
  if (LENSES[lens]?.panels.includes('explorer')) ensureExplorer();
  // Instant geography from inventory counts (skips the slow cost query); cost fills in below.
  api.regions(sub, state.range, true).then((fastR) => {
    if (gen !== loadGen || regionData.length) return;
    regionData = fastR.regions;
    map.setRegions(regionData, fastR.currency || state.currency);
    $('mapMeta').innerHTML = `${regionData.length} regions \u00b7 ${regionData.reduce((s, r) => s + r.count, 0)} resources \u00b7 <b>loading cost\u2026</b>`;
  }).catch(() => {});
  try {
    const regions = await api.regions(sub, state.range);
    if (gen !== loadGen) return;
    state.currency = regions.currency || 'USD';
    regionData = regions.regions;
    map.setRegions(regionData, state.currency);
    const total = regionData.reduce((s, r) => s + r.cost, 0) + (regions.unassignedCost || 0);
    $('mapMeta').innerHTML = `<b>${compactMoney(total, state.currency)}</b> / ${state.range} \u00b7 ${regionData.length} regions \u00b7 ${regionData.reduce((s, r) => s + r.count, 0)} resources`;
    mapTotalCost = total; renderMapLegend();
    renderRegionsPanel(regions.regions, regions.unassignedCost || 0);
    setStatus(null);
  } catch (err: any) {
    setStatus(null); showBanner(`Map load error: ${err.message}`);
  }
}

function setStatus(s: string | null) { const e = $('mapStatus'); if (!s) { e.classList.add('hidden'); } else { e.classList.remove('hidden'); e.textContent = s; } }

// ---- Panels ---------------------------------------------------------------
async function loadPanels(sub: string, gen: number) {
  api.summary(sub, state.range).then((d) => { if (loadGen === gen) { renderKpi(d); renderFinKpi(); renderForecast(); } }).catch(() => setBody('kpi', 'error'));
  api.analytics(sub, state.range).then((d) => { if (loadGen === gen) { renderService(d); renderTrend(d); renderTopRes(d); renderForecast(); renderPareto(); renderDow(); renderAnomaly(); renderAlloc(); renderFinKpi(); if (filterActive()) applyFilter(); } }).catch(() => { setBody('service', 'error'); setBody('trend', 'error'); setBody('topres', 'error'); });
  api.optimize(sub, state.range).then((d) => { if (loadGen === gen) { renderWaste(d); renderGov(d); renderFinKpi(); } }).catch(() => { setBody('waste', 'error'); setBody('gov', 'error'); });
  api.insights(sub, state.range).then((d) => { if (loadGen === gen) renderInsights(d); }).catch(() => setBody('insights', 'error'));
  api.posture(sub).then((d) => { if (loadGen === gen) renderPosture(d); }).catch(() => { setBody('security', 'error'); setBody('advisor', 'error'); setBody('resiliency', 'error'); });
  api.ops(sub).then((d) => { if (loadGen === gen) renderOps(d); }).catch(() => { setBody('backup', 'error'); setBody('monitoring', 'error'); setBody('changes', 'error'); });
  api.serviceHealth(sub).then((d) => { if (loadGen === gen) renderServiceHealth(d); }).catch(() => setBody('health', 'error'));
  api.alerts(sub).then((d) => { if (loadGen === gen) renderAlerts(d); }).catch(() => setBody('alerts', 'error'));
  loadDeps(sub);
}
function setBody(key: string, html: string) { const b = document.getElementById(`body-${key}`); if (b) b.innerHTML = html === 'error' ? '<span class="muted">unavailable</span>' : html; }
function setCount(key: string, n: number | string) { const c = document.getElementById(`cnt-${key}`); if (c) c.textContent = String(n); }
function setSev(key: string, sev: 'critical' | 'high' | 'normal' | 'low') { const d = document.getElementById(`sev-${key}`); if (d) d.className = `sev-dot ${sev}`; }

function renderKpi(s: SummaryResp) {
  panelData.kpi = s;
  renderWaf();
  const cur = s.currency;
  const active = filterActive();
  const agg = active ? filteredAgg() : null;
  const totalCost = agg ? agg.total : s.totalCost;
  const resourceCount = agg ? agg.count : s.resourceCount;
  const regionCount = agg ? agg.byLoc.size : s.regionCount;
  const dailyBurn = agg ? (s.days ? agg.total / s.days : 0) : s.dailyBurn;
  const forecast30 = agg ? dailyBurn * 30 : s.forecast30;
  const taggedPct = agg ? (resourceCount ? (agg.taggedCount / resourceCount) * 100 : 0) : s.taggedPct;
  const untaggedCount = agg ? agg.untaggedCount : s.untaggedCount;
  let topName = '', topVal = '\u2014';
  if (agg) {
    const top = [...agg.byType.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top) { topName = shortType(top[0]); topVal = compactMoney(top[1], cur); }
  } else if (s.topService) {
    topName = s.topService.name; topVal = compactMoney(s.topService.cost, cur);
  }
  const delta = active || s.deltaPct == null ? '' : `<span class="${s.deltaPct >= 0 ? 'up' : 'down'}">${s.deltaPct >= 0 ? '\u25b2' : '\u25bc'} ${Math.abs(s.deltaPct).toFixed(0)}%</span>`;
  const cards = [
    { l: active ? 'Filtered Spend' : 'Total Spend', v: compactMoney(totalCost, cur), s: `${s.days}d ${delta}`, g: true, k: 'cost' },
    { l: 'Daily Burn', v: compactMoney(dailyBurn, cur), s: 'avg / day', k: 'cost' },
    { l: 'Forecast 30d', v: compactMoney(forecast30, cur), s: 'run-rate', k: 'cost' },
    { l: 'Resources', v: String(resourceCount), s: `${regionCount} regions`, k: 'all' },
    { l: active ? 'Top Type' : 'Top Service', v: topVal, s: h(topName), k: 'service' },
    { l: 'Tag Coverage', v: `${Math.round(taggedPct)}%`, s: `${untaggedCount} untagged`, k: 'untagged' },
  ];
  setBody('kpi', `<div class="kpis">${cards.map((c) => `<button class="kpi" data-kpi="${c.k}" title="Drill into resources \u2192"><div class="kpi-l">${c.l}</div><div class="kpi-v ${c.g ? 'green' : ''}">${c.v}</div><div class="kpi-s">${c.s}</div></button>`).join('')}</div>`);
  setSev('kpi', !active && s.deltaPct != null && s.deltaPct >= 25 ? 'high' : 'normal');
  document.getElementById('body-kpi')?.querySelectorAll('.kpi').forEach((b) => b.addEventListener('click', () => {
    const k = (b as HTMLElement).dataset.kpi;
    if (k === 'untagged') openResourceDrill('Untagged resources', `${untaggedCount} of ${invById.size} resources have no tags`, invDrill(isUntagged));
    else if (k === 'service') { if (agg) { const t = [...agg.byType.entries()].sort((x, y) => y[1] - x[1])[0]; if (t) openTypeDrill(t[0]); } else if (s.topService) openServiceDrill(s.topService.name); }
    else if (k === 'all') openResourceDrill(active ? 'Filtered resources' : 'All resources', `${resourceCount} resources \u00b7 ${regionCount} regions`, agg ? agg.resources : invDrill());
    else openResourceDrill(active ? 'Filtered spend by resource' : 'Spend by resource', `${compactMoney(totalCost, cur)} \u00b7 top resources by cost`, agg ? agg.resources : invDrill());
  }));
}

function hbars(items: { name: string; cost: number }[], cur: string): string {
  if (!items.length) return '<span class="muted">no data</span>';
  const max = Math.max(...items.map((i) => i.cost), 0.0001);
  return items.slice(0, 10).map((i) =>
    `<div class="hrow"><div class="hb-top"><span class="hb-name" title="${h(i.name)}">${h(i.name)}</span><span class="hb-val">${money(i.cost, cur)}</span></div>` +
    `<div class="hb-track"><div class="hb-fill" style="width:${Math.max(2, (i.cost / max) * 100).toFixed(1)}%"></div></div></div>`).join('');
}
function renderService(d: AnalyticsResp) {
  panelData.service = d;
  const cur = d.currency;
  if (filterActive()) {
    const agg = filteredAgg();
    const arr = [...agg.byType.entries()].map(([type, cost]) => ({ type, cost })).sort((a, b) => b.cost - a.cost);
    const segs = arr.slice(0, 8).map((x) => ({ label: shortType(x.type), value: x.cost }));
    const max = Math.max(...arr.map((i) => i.cost), 0.0001);
    const bars = arr.slice(0, 10).map((i) =>
      `<button class="hrow svc-row" data-type="${h(i.type)}" title="Drill into ${h(shortType(i.type))} resources \u2192"><div class="hb-top"><span class="hb-name">${h(shortType(i.type))}</span><span class="hb-val">${money(i.cost, cur)}</span></div><div class="hb-track"><div class="hb-fill" style="width:${Math.max(2, (i.cost / max) * 100).toFixed(1)}%"></div></div></button>`).join('') || '<span class="muted">no billed cost in filtered set</span>';
    setBody('service', `<div class="svc-note">Cost by type \u00b7 filtered</div><div class="donut-host">${donut(segs, { center: compactMoney(agg.total, cur), centerSub: 'filtered', fmt: (v) => money(v, cur) })}</div><div class="svc-bars">${bars}</div>`);
    setCount('service', arr.length);
    document.querySelectorAll('#body-service .svc-row').forEach((b) => b.addEventListener('click', () => openTypeDrill((b as HTMLElement).dataset.type!)));
    return;
  }
  const total = d.byService.reduce((s, x) => s + x.cost, 0);
  const segs = d.byService.slice(0, 8).map((s) => ({ label: s.name, value: s.cost }));
  const max = Math.max(...d.byService.map((i) => i.cost), 0.0001);
  const bars = d.byService.slice(0, 10).map((i) =>
    `<button class="hrow svc-row" data-svc="${h(i.name)}" title="Drill into ${h(i.name)} resources \u2192"><div class="hb-top"><span class="hb-name">${h(i.name)}</span><span class="hb-val">${money(i.cost, cur)}</span></div><div class="hb-track"><div class="hb-fill" style="width:${Math.max(2, (i.cost / max) * 100).toFixed(1)}%"></div></div></button>`).join('') || '<span class="muted">no data</span>';
  setBody('service', `<div class="donut-host">${donut(segs, { center: compactMoney(total, cur), centerSub: 'total', fmt: (v) => money(v, cur) })}</div><div class="svc-bars">${bars}</div>`);
  setCount('service', d.byService.length);
  document.querySelectorAll('#body-service .svc-row').forEach((b) => b.addEventListener('click', () => openServiceDrill((b as HTMLElement).dataset.svc!)));
}

// Map a Cost-Management ServiceName to the inventory resource types it bills, so a
// click on the "Cost by Service" chart drills into the actual resources behind it.
const SERVICE_HINTS: [RegExp, RegExp][] = [
  [/virtual machine|vm licenses|reserved vm/i, /compute\/(virtualmachines|virtualmachinescalesets)|classiccompute/i],
  [/managed disk|premium ssd|standard ssd|standard hdd/i, /compute\/disks|compute\/snapshots/i],
  [/storage|blob|file share|data lake|azure files/i, /storage\/|compute\/disks|compute\/snapshots|fileshares|netapp/i],
  [/azure kubernetes|container service/i, /containerservice\/managedclusters/i],
  [/container registr/i, /containerregistry\/registries/i],
  [/container instance/i, /containerinstance/i],
  [/container app/i, /app\/(containerapps|managedenvironments)/i],
  [/app service|web app/i, /web\/(sites|serverfarms|staticsites)/i],
  [/functions/i, /web\/sites/i],
  [/api management/i, /apimanagement\/service/i],
  [/log analytics|azure monitor|application insights/i, /operationalinsights\/workspaces|insights\/|alertsmanagement|monitor\//i],
  [/cosmos/i, /documentdb|cosmos/i],
  [/sql database|sql managed instance|azure sql/i, /sql\/(servers|managedinstances)/i],
  [/postgre/i, /dbforpostgresql/i],
  [/mysql/i, /dbformysql/i],
  [/redis|azure cache/i, /cache\/redis/i],
  [/key vault/i, /keyvault\/vaults/i],
  [/event hub/i, /eventhub\//i],
  [/service bus/i, /servicebus\//i],
  [/event grid/i, /eventgrid\//i],
  [/load balancer/i, /network\/loadbalancers/i],
  [/application gateway/i, /network\/applicationgateways/i],
  [/firewall/i, /network\/(azurefirewalls|firewallpolicies)/i],
  [/vpn gateway|virtual network gateway/i, /network\/(virtualnetworkgateways|vpngateways)/i],
  [/expressroute/i, /network\/expressroute/i],
  [/bastion/i, /network\/bastionhosts/i],
  [/front door|content delivery|cdn/i, /cdn\/|network\/frontdoors/i],
  [/private link|private endpoint/i, /network\/(privateendpoints|privatelinkservices)/i],
  [/nat gateway/i, /network\/natgateways/i],
  [/dns/i, /network\/(dnszones|privatednszones)/i],
  [/virtual network|bandwidth|ip address|network watcher|networking/i, /network\//i],
  [/backup|recovery|site recovery/i, /recoveryservices\/vaults/i],
  [/arc[- ]enabled database|arc[- ]?sql|sql server on arc/i, /azurearcdata/i],
  [/\barc\b|hybrid compute|azure stack hci|\bhci\b/i, /hybridcompute\/|kubernetes\/connectedclusters|azurestackhci/i],
  [/data factory/i, /datafactory\//i],
  [/synapse/i, /synapse\//i],
  [/databricks/i, /databricks\//i],
  [/cognitive|openai|azure ai|machine learning|foundry|ai search/i, /cognitiveservices|machinelearningservices|search\/searchservices/i],
  [/signalr|web pubsub/i, /signalrservice/i],
  [/automation/i, /automation\//i],
  [/logic app/i, /logic\/workflows/i],
];
function serviceMatchesType(svc: string, type: string): boolean {
  const s = svc.toLowerCase(); const t = (type || '').toLowerCase();
  for (const [sre, tre] of SERVICE_HINTS) if (sre.test(s)) return tre.test(t);
  const toks = s.replace(/azure|microsoft|for\b|and\b|the\b|services?/g, ' ').split(/[^a-z0-9]+/).filter((w) => w.length > 3);
  return toks.some((w) => t.includes(w));
}
// Drill from a cost-chart service into the real resources that bill under it.
function openServiceDrill(svc: string) {
  const cur = state.currency;
  const ad = panelData.service as AnalyticsResp | undefined;
  const costById = new Map<string, number>();
  for (const r of (ad?.topResources || [])) costById.set(r.id.toLowerCase(), r.cost);
  const matches = [...invById.values()].filter((r) => serviceMatchesType(svc, r.type));
  matches.sort((a, b) => (costById.get(b.id.toLowerCase()) || 0) - (costById.get(a.id.toLowerCase()) || 0) || a.name.localeCompare(b.name));
  const svcCost = (ad?.byService || []).find((s) => s.name === svc)?.cost;
  const rows = matches.slice(0, 250).map((r) => {
    const c = costById.get(r.id.toLowerCase());
    return `<button class="drill-row" data-open-id="${h(r.id)}">${typeIcon(r.type, { tinted: true })}<span class="drill-name">${h(r.name)}</span><span class="drill-type">${h(shortType(r.type))}</span><span class="drill-rg">${h(r.resourceGroup || '')}</span><span class="drill-cost">${c != null ? money(c, cur) : ''}</span><span class="drill-go">\u203a</span></button>`;
  }).join('') || '<div class="muted" style="padding:14px">No standalone resources match this service in inventory \u2014 the cost may be usage-based (bandwidth, licensing, support).</div>';
  const sub = svcCost != null ? `${money(svcCost, cur)} \u00b7 ${matches.length} resource${matches.length === 1 ? '' : 's'}` : `${matches.length} resource${matches.length === 1 ? '' : 's'}`;
  showWnModal(`<div class="pm"><div class="pm-titlebar"><h3>${h(svc)}</h3><span class="pm-sub2">${sub}</span></div><div class="pm-detail"><div class="drill-list">${rows}</div></div></div>`, 'panel');
  document.getElementById('wnModal')?.querySelectorAll('.drill-row[data-open-id]').forEach((el) => el.addEventListener('click', () => { closeWnModal(); openDock((el as HTMLElement).dataset.openId!); }));
}
// Drill from the filtered "Cost by type" chart into the real resources of that exact type.
function openTypeDrill(fullType: string) {
  const cur = state.currency;
  const costMap = lastAnalytics?.costById || {};
  const matches = [...invById.values()].filter((r) => r.type === fullType && matchesFilter(r.name, r.type, r.resourceGroup));
  matches.sort((a, b) => (costMap[b.id.toLowerCase()] || 0) - (costMap[a.id.toLowerCase()] || 0) || a.name.localeCompare(b.name));
  const totalCost = matches.reduce((s, r) => s + (costMap[r.id.toLowerCase()] || 0), 0);
  const rows = matches.slice(0, 250).map((r) => {
    const c = costMap[r.id.toLowerCase()];
    return `<button class="drill-row" data-open-id="${h(r.id)}">${typeIcon(r.type, { tinted: true })}<span class="drill-name">${h(r.name)}</span><span class="drill-type">${h(shortType(r.type))}</span><span class="drill-rg">${h(r.resourceGroup || '')}</span><span class="drill-cost">${c != null ? money(c, cur) : ''}</span><span class="drill-go">\u203a</span></button>`;
  }).join('') || '<div class="muted" style="padding:14px">No resources match.</div>';
  const sub = `${money(totalCost, cur)} \u00b7 ${matches.length} resource${matches.length === 1 ? '' : 's'}`;
  showWnModal(`<div class="pm"><div class="pm-titlebar"><h3>${h(shortType(fullType))}</h3><span class="pm-sub2">${sub}</span></div><div class="pm-detail"><div class="drill-list">${rows}</div></div></div>`, 'panel');
  document.getElementById('wnModal')?.querySelectorAll('.drill-row[data-open-id]').forEach((el) => el.addEventListener('click', () => { closeWnModal(); openDock((el as HTMLElement).dataset.openId!); }));
}
function renderTrend(d: AnalyticsResp) { panelData.trend = d; setBody('trend', trendSvg(d.trend, d.currency)); setCount('trend', `${d.trend.length}d`); }
// ---- Universal drill-down: any chart / KPI / gauge -> the resources behind the number ----
type DrillRes = { id: string; name: string; type?: string; resourceGroup?: string | null; location?: string; cost?: number | null };
function openResourceDrill(title: string, subtitle: string, resources: DrillRes[]) {
  const cur = state.currency;
  const rows = resources.slice(0, 500).map((r) =>
    `<button class="drill-row" data-open-id="${h(r.id)}">${typeIcon(r.type || '', { tinted: true })}<span class="drill-name">${h(r.name)}</span><span class="drill-type">${h(shortType(r.type || ''))}</span><span class="drill-rg">${h(r.resourceGroup || '')}</span><span class="drill-cost">${r.cost != null ? money(r.cost, cur) : ''}</span><span class="drill-go">\u203a</span></button>`
  ).join('') || `<div class="muted" style="padding:14px">${h(subtitle) || 'No resources to show.'}</div>`;
  showWnModal(`<div class="pm"><div class="pm-titlebar"><h3>${h(title)}</h3><span class="pm-sub2">${h(subtitle)} \u00b7 ${resources.length}</span></div><div class="pm-detail"><div class="drill-list">${rows}</div></div></div>`, 'panel');
  document.getElementById('wnModal')?.querySelectorAll('.drill-row[data-open-id]').forEach((el) => el.addEventListener('click', () => { closeWnModal(); openDock((el as HTMLElement).dataset.openId!); }));
}
// Build a resource list from the live inventory (+ per-resource cost), optionally filtered.
function invDrill(filter?: (r: InventoryResource) => boolean): DrillRes[] {
  const costMap = lastAnalytics?.costById || {};
  return [...invById.values()].filter((r) => !filter || filter(r))
    .map((r) => ({ id: r.id, name: r.name, type: r.type, resourceGroup: r.resourceGroup, location: r.location, cost: costMap[r.id.toLowerCase()] ?? null }))
    .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || a.name.localeCompare(b.name));
}
const isVm = (r: InventoryResource) => r.type.toLowerCase() === 'microsoft.compute/virtualmachines';
const isUntagged = (r: InventoryResource) => !r.tags || !Object.keys(r.tags).length;
function missingTagKey(r: InventoryResource, which: string): boolean {
  const k = new Set(Object.keys(r.tags || {}).map((x) => x.toLowerCase()));
  if (which === 'owner') return !k.has('owner');
  if (which === 'costcenter') return !k.has('costcenter') && !k.has('cost-center') && !k.has('cost_center');
  if (which === 'env') return !k.has('environment') && !k.has('env');
  return false;
}
function renderTopRes(d: AnalyticsResp) {
  lastAnalytics = d;
  panelData.topres = d;
  const cur = d.currency;
  const agg = filterActive() ? filteredAgg() : null;
  const list = agg ? agg.resources.slice(0, 60) : d.topResources;
  const rows = list.map((r) => `<tr class="clk" data-id="${h(r.id)}"><td><span class="tcell">${typeIcon(r.type, { tinted: true })}<span class="tcell-name">${h(r.name)}</span></span></td><td>${h(shortType(r.type))}</td><td class="num">${money(r.cost, cur)}</td></tr>`).join('');
  setBody('topres', `<table class="wtbl"><thead><tr><th>Resource</th><th>Type</th><th class="num">Cost</th></tr></thead><tbody>${rows || '<tr><td colspan="3" class="muted">no match</td></tr>'}</tbody></table>`);
  setCount('topres', agg ? `${agg.count}` : d.topResources.length);
  document.querySelectorAll('#body-topres tr.clk').forEach((t) => t.addEventListener('click', () => openDock((t as HTMLElement).dataset.id!)));
}

// ---- FinOps filter (client-side drill-down) -------------------------------
function filterActive(): boolean { return !!(filter.text || filter.rg || filter.type); }
function matchesFilter(name: string, type: string, rg?: string | null): boolean {
  if (filter.text && !`${name} ${type}`.toLowerCase().includes(filter.text)) return false;
  if (filter.rg && (rg || '').toLowerCase() !== filter.rg) return false;
  if (filter.type && !type.toLowerCase().startsWith(filter.type)) return false;
  return true;
}
interface FilterAgg {
  total: number; count: number; taggedCount: number; untaggedCount: number;
  byLoc: Map<string, { cost: number; count: number }>;
  byType: Map<string, number>;
  resources: { id: string; name: string; type: string; location: string; resourceGroup: string | null; cost: number }[];
}
// Re-aggregate in-memory inventory + per-resource cost for the ACTIVE filter, so the
// KPIs / charts / map reflect exactly the filtered subset instead of the whole sub.
function filteredAgg(): FilterAgg {
  const costMap = lastAnalytics?.costById || {};
  let total = 0, taggedCount = 0;
  const byLoc = new Map<string, { cost: number; count: number }>();
  const byType = new Map<string, number>();
  const resources: FilterAgg['resources'] = [];
  for (const r of invById.values()) {
    if (!matchesFilter(r.name, r.type, r.resourceGroup)) continue;
    const c = costMap[r.id.toLowerCase()] || 0;
    total += c;
    if (r.tags && Object.keys(r.tags).length) taggedCount++;
    const loc = r.location || 'global';
    const lb = byLoc.get(loc) || { cost: 0, count: 0 }; lb.cost += c; lb.count++; byLoc.set(loc, lb);
    if (c > 0) byType.set(r.type, (byType.get(r.type) || 0) + c);
    resources.push({ id: r.id, name: r.name, type: r.type, location: r.location, resourceGroup: r.resourceGroup, cost: c });
  }
  resources.sort((a, b) => b.cost - a.cost);
  return { total, count: resources.length, taggedCount, untaggedCount: resources.length - taggedCount, byLoc, byType, resources };
}
function populateFilters() {
  if (!invById.size) return;
  const rgs = new Set<string>(), types = new Set<string>();
  for (const r of invById.values()) {
    if (r.resourceGroup) rgs.add(r.resourceGroup);
    if (r.type) types.add(r.type);
  }
  const rgSel = $<HTMLSelectElement>('filRg'), tySel = $<HTMLSelectElement>('filType');
  const prevRg = rgSel.value, prevTy = tySel.value;
  rgSel.innerHTML = '<option value="">All resource groups</option>' +
    [...rgs].sort((a, b) => a.localeCompare(b)).map((g) => `<option value="${h(g.toLowerCase())}">${h(g)}</option>`).join('');
  tySel.innerHTML = '<option value="">All types</option>' +
    [...types].sort((a, b) => a.localeCompare(b)).map((t) => `<option value="${h(t.toLowerCase())}">${h(shortType(t))}</option>`).join('');
  rgSel.value = prevRg; tySel.value = prevTy;
  updateFilterSummary();
  customTabs?.refresh();
}
function applyFilter() {
  if (panelData.kpi) renderKpi(panelData.kpi as SummaryResp);
  if (lastAnalytics) { renderService(lastAnalytics); renderTopRes(lastAnalytics); }
  if (regionData.length) {
    if (filterActive()) {
      applyRegionFilter();
    } else {
      const un = (panelData.regions as { unassigned?: number } | undefined)?.unassigned || 0;
      renderRegionsRows(regionData, un);
      map.setRegions(regionData, state.currency);
      const total = regionData.reduce((s, r) => s + r.cost, 0) + un;
      $('mapMeta').innerHTML = `<b>${compactMoney(total, state.currency)}</b> / ${state.range} \u00b7 ${regionData.length} regions \u00b7 ${regionData.reduce((s, r) => s + r.count, 0)} resources`;
      mapTotalCost = total; renderMapLegend();
    }
  }
  updateFilterSummary();
  renderAlloc();
  renderPareto();
  renderInvMix();
}
// Project the filtered subset onto the region map: re-cost each region bubble from the
// filtered inventory so the map + Regions panel match the active filter exactly.
function applyRegionFilter() {
  const agg = filteredAgg();
  const cur = state.currency;
  const filtered = regionData
    .map((rd) => ({ ...rd, cost: agg.byLoc.get(rd.region)?.cost || 0, count: agg.byLoc.get(rd.region)?.count || 0 }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.cost - a.cost);
  renderRegionsRows(filtered, 0);
  map.setRegions(filtered, cur);
  $('mapMeta').innerHTML = `<b>${compactMoney(agg.total, cur)}</b> filtered \u00b7 ${filtered.length} regions \u00b7 ${agg.count} resources`;
  mapTotalCost = agg.total; renderMapLegend();
}
function updateFilterSummary() {
  const el = $('filSummary');
  if (!invById.size) { el.textContent = ''; return; }
  if (!filterActive()) { el.innerHTML = `<b>${invById.size}</b> resources`; return; }
  const agg = filteredAgg();
  el.innerHTML = `<b>${agg.count}</b> of ${invById.size} \u00b7 <b>${compactMoney(agg.total, state.currency)}</b>`;
}
function renderWaste(d: OptimizeResp) {
  panelData.waste = d;
  renderWaf();
  const cur = d.currency;
  const all = [...d.findings, d.untagged].filter((f) => f.count > 0);
  const items = all.map((f, i) => `<button class="finding clk-find" data-fi="${i}" title="Show the ${f.count} resources \u2192"><span class="fdot ${f.monthlyCost > 1 ? 'sev-med' : 'sev-low'}"></span><div class="fbody"><div class="ftitle">${h(f.label)}</div><div class="fsub">${f.count} found</div></div><span class="fimp save">${money(f.monthlyCost, cur)}/mo</span></button>`).join('');
  setBody('waste', `<div class="finding"><span class="fdot sev-med"></span><div class="fbody"><div class="ftitle">Estimated monthly savings</div></div><span class="fimp save">${money(d.estimatedMonthlySavings, cur)}/mo</span></div>${items || '<span class="muted">no waste detected</span>'}`);
  setCount('waste', all.length);
  setSev('waste', d.estimatedMonthlySavings > 1 ? 'high' : 'normal');
  document.getElementById('body-waste')?.querySelectorAll('.clk-find').forEach((b) => b.addEventListener('click', () => { const f = all[Number((b as HTMLElement).dataset.fi)]; if (f) openResourceDrill(f.label, `${money(f.monthlyCost, cur)}/mo`, (f.resources || []).map((r) => ({ id: r.id, name: r.name, type: r.type, resourceGroup: r.resourceGroup, location: r.location, cost: r.monthlyCost }))); }));
  // Feed map overlays: red = idle/orphaned waste per region, amber = untagged per region.
  const wasteByLoc = new Map<string, number>();
  for (const f of d.findings) for (const r of (f.resources || [])) wasteByLoc.set(r.location, (wasteByLoc.get(r.location) || 0) + 1);
  const untaggedByLoc = new Map<string, number>();
  for (const r of (d.untagged.resources || [])) untaggedByLoc.set(r.location, (untaggedByLoc.get(r.location) || 0) + 1);
  map.setWaste(locPoints(wasteByLoc));
  map.setUntagged(locPoints(untaggedByLoc));
}
function locPoints(byLoc: Map<string, number>): { lon: number; lat: number; count: number }[] {
  const coord = new Map<string, [number, number]>();
  for (const r of regionData) if (r.lat != null && r.lon != null) coord.set(r.region, [r.lon as number, r.lat as number]);
  const out: { lon: number; lat: number; count: number }[] = [];
  for (const [loc, count] of byLoc) { const c = coord.get(loc); if (c) out.push({ lon: c[0], lat: c[1], count }); }
  return out;
}
function renderGov(d: OptimizeResp) {
  panelData.gov = d;
  const g = d.governance;
  setBody('gov', `<button class="gov-top clk-gov" data-gov="untagged" title="Show untagged resources \u2192">${gauge(g.taggedPct, { label: 'tagged', sub: `${g.tagged}/${g.total} resources`, color: g.taggedPct >= 70 ? '#44ff88' : g.taggedPct >= 40 ? '#ffaa00' : '#ff6b4a' })}</button>` +
    `<button class="hrow clk-gov" data-gov="owner" title="Drill \u2192"><div class="hb-top"><span>Missing owner</span><span class="hb-val">${g.missingOwner}</span></div></button>` +
    `<button class="hrow clk-gov" data-gov="costcenter" title="Drill \u2192"><div class="hb-top"><span>Missing cost-center</span><span class="hb-val">${g.missingCostCenter}</span></div></button>` +
    `<button class="hrow clk-gov" data-gov="env" title="Drill \u2192"><div class="hb-top"><span>Missing environment</span><span class="hb-val">${g.missingEnv}</span></div></button>`);
  setCount('gov', `${Math.round(g.taggedPct)}%`);
  setSev('gov', g.taggedPct < 50 ? 'high' : 'normal');
  document.getElementById('body-gov')?.querySelectorAll('.clk-gov').forEach((b) => b.addEventListener('click', () => {
    const w = (b as HTMLElement).dataset.gov!;
    if (w === 'untagged') openResourceDrill('Untagged resources', 'no tags assigned', invDrill(isUntagged));
    else openResourceDrill(`Missing ${w === 'costcenter' ? 'cost-center' : w} tag`, 'resources missing this tag', invDrill((r) => missingTagKey(r, w)));
  }));
}
const SEVMAP: Record<string, string> = { opportunity: 'sev-low', warn: 'sev-med', info: 'sev-low' };
function renderInsights(d: InsightsResp) {
  panelData.insights = d;
  const items = d.insights.map((i) => {
    const imp = typeof i.impact === 'number' && Math.abs(i.impact) >= 0.5 ? `<span class="fimp ${i.impact < 0 ? 'save' : 'rise'}">${i.impact < 0 ? '\u2193' : '\u2191'}${compactMoney(Math.abs(i.impact), d.currency)}</span>` : '';
    return `<div class="finding"><span class="fdot ${i.severity === 'warn' ? 'sev-med' : 'sev-low'}"></span><div class="fbody"><div class="ftitle">${h(i.title)}</div><div class="fsub">${h(i.detail)}</div></div>${imp}</div>`;
  }).join('');
  setBody('insights', items || '<span class="muted">no recommendations</span>');
  setCount('insights', d.insights.length);
  setSev('insights', d.insights.some((i) => i.severity === 'warn') ? 'high' : 'normal');
  updateTicker();
}
function renderRegionsPanel(regions: RegionAgg[], unassigned: number) {
  panelData.regions = { regions, unassigned, currency: state.currency };
  if (filterActive()) { applyRegionFilter(); return; }
  renderRegionsRows(regions, unassigned);
}
function renderRegionsRows(regions: RegionAgg[], unassigned: number) {
  const cur = state.currency;
  const max = Math.max(...regions.map((r) => r.cost), unassigned, 0.0001);
  const rows = regions.slice(0, 12).map((r) =>
    `<div class="hrow clk-reg" data-region="${h(r.region)}" data-display="${h(r.display)}" style="cursor:pointer"><div class="hb-top"><span class="hb-name">${flagImg(r.region)}${h(r.display)} \u00b7 ${r.count}</span><span class="hb-val">${money(r.cost, cur)}</span></div><div class="hb-track"><div class="hb-fill" style="width:${Math.max(2, (r.cost / max) * 100).toFixed(1)}%"></div></div></div>`).join('');
  const un = unassigned > 0.005 ? `<div class="hrow"><div class="hb-top"><span class="hb-name muted">(unassigned / shared)</span><span class="hb-val">${money(unassigned, cur)}</span></div></div>` : '';
  setBody('regions', rows + un || '<span class="muted">no regions</span>');
  setCount('regions', regions.length);
  document.querySelectorAll('#body-regions .clk-reg').forEach((el) => el.addEventListener('click', () => focusZones((el as HTMLElement).dataset.region!, (el as HTMLElement).dataset.display!)));
}

// ---- Posture panels (Defender / Advisor / Resiliency / Service Health) ----
function renderPosture(p: PostureResp) {
  panelData.security = p; panelData.advisor = p; panelData.resiliency = p; panelData.health = p;
  renderWaf();
  const sec = p.security || [];
  const uh = (sev: string) => sec.filter((x) => x.status === 'Unhealthy' && String(x.severity).toLowerCase() === sev).reduce((s, x) => s + x.count, 0);
  const high = uh('high'), med = uh('medium'), low = uh('low');
  const sc = p.secureScore;
  const scorePct = sc ? Math.round(sc.pct ?? (sc.max ? (sc.current / sc.max) * 100 : 0)) : null;
  setBody('security',
    (scorePct != null ? `<div class="gov-top">${gauge(scorePct, { label: 'secure score', sub: `${sc!.current}/${sc!.max}`, color: scorePct >= 70 ? '#44ff88' : scorePct >= 40 ? '#ffaa00' : '#ff6b4a' })}</div>` : '') +
    `<div class="hrow"><div class="hb-top"><span class="sev-tag high">HIGH</span><span class="hb-val">${high}</span></div></div>` +
    `<div class="hrow"><div class="hb-top"><span class="sev-tag med">MEDIUM</span><span class="hb-val">${med}</span></div></div>` +
    `<div class="hrow"><div class="hb-top"><span class="sev-tag low">LOW</span><span class="hb-val">${low}</span></div></div>` +
    (sec.length ? '' : '<span class="muted small">Defender for Cloud not enabled or no data</span>'));
  setCount('security', high + med + low);
  setSev('security', high > 0 ? 'critical' : med > 0 ? 'high' : 'normal');

  const adv = p.advisor || [];
  const byCat = new Map<string, number>();
  for (const a of adv) byCat.set(a.category, (byCat.get(a.category) || 0) + a.count);
  const order = ['Cost', 'Security', 'HighAvailability', 'Performance', 'OperationalExcellence'];
  const catLabel = (c: string) => c.replace('HighAvailability', 'Reliability').replace('OperationalExcellence', 'Operations');
  const catColor: Record<string, string> = { Cost: '#44ff88', Security: '#ff6b9d', HighAvailability: '#3bd6ff', Performance: '#ffaa00', OperationalExcellence: '#a78bfa' };
  const segs = order.filter((c) => byCat.has(c)).map((c) => ({ label: catLabel(c), value: byCat.get(c)!, color: catColor[c] }));
  const advTotal = adv.reduce((s, a) => s + a.count, 0);
  setBody('advisor', segs.length ? `<div class="donut-host">${donut(segs, { center: String(advTotal), centerSub: 'recs', fmt: (v) => String(v) })}</div>` : '<span class="muted">no recommendations</span>');
  setCount('advisor', adv.reduce((s, a) => s + a.count, 0));
  setSev('advisor', (byCat.get('Security') || 0) > 0 ? 'high' : 'normal');

  const r = p.resiliency;
  const pinnedPct = r.total ? Math.round((r.zonePinned / r.total) * 100) : 0;
  setBody('resiliency',
    `<button class="gov-ring clk-zone" title="Show zone-configured resources \u2192"><div class="gov-big">${pinnedPct}%</div><div class="gov-sub">zone-pinned<br/>${r.zonePinned}/${r.total} resources</div></button>` +
    `<button class="hrow clk-zone" title="Drill \u2192"><div class="hb-top"><span class="hb-name">Zone-redundant</span><span class="hb-val">${r.zoneRedundant}</span></div></button>` +
    `<div class="hrow"><div class="hb-top"><span class="hb-name">Single-zone / regional</span><span class="hb-val">${r.total - r.zonePinned}</span></div></div>` +
    (r.zonePinned === 0 ? '<div class="finding"><span class="fdot sev-med"></span><div class="fbody"><div class="fsub">No resources are zone-pinned \u2014 single-zone risk. Click a region on the map to drill into its zones.</div></div></div>' : ''));
  setCount('resiliency', `${pinnedPct}%`);
  setSev('resiliency', pinnedPct < 20 ? 'high' : 'normal');
  document.getElementById('body-resiliency')?.querySelectorAll('.clk-zone').forEach((b) => b.addEventListener('click', () => openResourceDrill('Zone-configured resources', 'resources with availability zones set', invDrill((x) => Array.isArray(x.zones) && x.zones.length > 0))));

  // The 'health' panel is owned by renderServiceHealth (richer, with regions/services);
  // fill it here only as a fallback until the dedicated Service Health load arrives.
  if (!panelData.svcHealth) {
    const sh = p.serviceHealth || [];
    setBody('health', sh.length
      ? sh.slice(0, 12).map((e) => `<div class="finding"><span class="fdot ${e.eventType === 'ServiceIssue' ? 'sev-high' : 'sev-low'}"></span><div class="fbody"><div class="ftitle">${h(e.title)}</div><div class="fsub">${h(e.eventType)}</div></div></div>`).join('')
      : '<div class="finding"><span class="fdot" style="background:var(--green)"></span><div class="fbody"><div class="ftitle">All systems operational</div><div class="fsub">No active service-health events</div></div></div>');
    setCount('health', sh.length);
    setSev('health', sh.some((e) => e.eventType === 'ServiceIssue') ? 'critical' : 'normal');
  }
  updateTicker();
}

// ---- Active Azure Monitor alerts + Service Health (estate-wide heads-up) ---
let svcHealthEvents: ServiceHealthEvent[] = [];
function alertSevMeta(sev: string): { cls: string; label: string } {
  const m = /sev(\d)/i.exec(sev || '');
  const n = m ? Number(m[1]) : 9;
  if (n <= 1) return { cls: 'crit', label: `SEV${n}` };
  if (n === 2) return { cls: 'high', label: 'SEV2' };
  if (n === 3) return { cls: 'med', label: 'SEV3' };
  return { cls: 'low', label: sev ? sev.toUpperCase() : 'SEV4' };
}
function alertTitle(a: AlertItem): string {
  return a.name || a.description || `${a.monitorService || 'Alert'} \u00b7 ${shortType(a.targetType || '')}`;
}
function renderAlerts(a: AlertsResp) {
  panelData.alertsData = a;
  const list = a.alerts || [];
  const counts = a.sevCounts || {};
  const crit = (counts.Sev0 || 0) + (counts.Sev1 || 0);
  const chips = ['Sev0', 'Sev1', 'Sev2', 'Sev3', 'Sev4'].filter((s) => counts[s]).map((s) => { const sv = alertSevMeta(s); return `<span class="al-chip ${sv.cls}">${sv.label} <b>${counts[s]}</b></span>`; }).join('');
  const rows = list.slice(0, 80).map((al) => {
    const sv = alertSevMeta(al.severity);
    const rid = al.targetResource || '';
    return `<button class="al-row" data-res="${h(rid)}" title="${h(alertTitle(al))}"><span class="al-sev ${sv.cls}">${sv.label}</span><div class="al-body"><div class="al-title">${h(alertTitle(al))}</div><div class="al-meta">${h(al.monitorService || al.signalType || '')}${rid ? ` \u00b7 ${h(resName(rid))}` : ''}<span class="al-time">${fmtAgo(al.fired)}</span></div></div><span class="al-go">\u203a</span></button>`;
  }).join('');
  setBody('alerts', list.length
    ? `<div class="al-headbar">${chips || `<span class="al-chip low">${list.length} active</span>`}<span class="al-live">auto-refreshing \u00b7 closed alerts clear automatically</span></div><div class="al-list">${rows}</div>`
    : (a.error
      ? `<div class="finding"><span class="fdot sev-low"></span><div class="fbody"><div class="ftitle">Alerts unavailable</div><div class="fsub">${h(a.error)}</div></div></div>`
      : '<div class="finding"><span class="fdot" style="background:var(--green)"></span><div class="fbody"><div class="ftitle">No active alerts</div><div class="fsub">No fired Azure Monitor alerts in this subscription</div></div></div>'));
  setCount('alerts', list.length);
  setSev('alerts', crit ? 'critical' : list.length ? 'high' : 'normal');
  document.getElementById('body-alerts')?.querySelectorAll('.al-row').forEach((b) => b.addEventListener('click', () => { const id = (b as HTMLElement).dataset.res; if (id) openDock(id); }));
  updateTicker();
}
function renderServiceHealth(s: ServiceHealthResp) {
  panelData.svcHealth = s;
  svcHealthEvents = s.events || [];
  const byRegion: Record<string, { status: string; count: number }> = {};
  for (const [code, v] of Object.entries(s.byRegion || {})) byRegion[code] = { status: v.status, count: v.count };
  map.setRegionHealth(byRegion);
  const ev = s.events || [];
  setBody('health', ev.length
    ? ev.slice(0, 16).map((e, i) => {
        const cls = e.status === 'issue' ? 'sev-high' : e.status === 'maintenance' ? 'sev-med' : 'sev-low';
        const regs = e.regions.length ? `${e.regions.slice(0, 3).map((r) => `<span class="sh-reg">${h(r)}</span>`).join('')}${e.regions.length > 3 ? `<span class="sh-reg more">+${e.regions.length - 3}</span>` : ''}` : '<span class="sh-reg">non-regional</span>';
        const svc = e.services.slice(0, 2).map((x) => h(x)).join(', ');
        return `<button class="sh-ev" data-ev="${i}"><span class="fdot ${cls}"></span><div class="fbody"><div class="ftitle">${h(e.title)}</div><div class="sh-meta">${svc ? `<span class="sh-svc">${svc}</span>` : ''}${regs}</div></div><span class="al-go">\u203a</span></button>`;
      }).join('')
    : '<div class="finding"><span class="fdot" style="background:var(--green)"></span><div class="fbody"><div class="ftitle">All systems operational</div><div class="fsub">No active Azure service-health events</div></div></div>');
  setCount('health', ev.length);
  setSev('health', ev.some((e) => e.status === 'issue') ? 'critical' : ev.length ? 'high' : 'normal');
  document.getElementById('body-health')?.querySelectorAll('.sh-ev').forEach((b) => b.addEventListener('click', () => openServiceHealthEvent(svcHealthEvents[Number((b as HTMLElement).dataset.ev)])));
  updateTicker();
}
const SVC_TYPE_HINTS: [RegExp, string[]][] = [
  [/redis|cache/i, ['cache/redis']],
  [/container apps/i, ['containerapps', 'managedenvironments']],
  [/kubernetes|aks/i, ['managedclusters']],
  [/sql managed instance/i, ['sql/managedinstances']],
  [/sql data|sql database|azure sql/i, ['sql/servers']],
  [/cosmos/i, ['documentdb', 'cosmosdb']],
  [/virtual machines/i, ['compute/virtualmachines']],
  [/storage/i, ['storage/storageaccounts']],
  [/app service|web app|functions/i, ['web/sites', 'web/serverfarms']],
  [/key vault/i, ['keyvault/vaults']],
  [/postgres/i, ['dbforpostgresql']],
  [/mysql/i, ['dbformysql']],
  [/service bus/i, ['servicebus']],
  [/event hub/i, ['eventhub']],
  [/openai|cognitive|\bai\b/i, ['cognitiveservices']],
];
function resourceMatchesService(type: string, svc: string): boolean {
  const t = (type || '').toLowerCase();
  for (const [re, types] of SVC_TYPE_HINTS) if (re.test(svc) && types.some((x) => t.includes(x))) return true;
  const kws = svc.toLowerCase().replace(/azure|microsoft|for|the|service|services/g, ' ').split(/[^a-z0-9]+/).filter((w) => w.length > 3);
  return kws.some((k) => t.includes(k));
}
function openServiceHealthEvent(e: ServiceHealthEvent | undefined) {
  if (!e) return;
  const codes = new Set(e.regionCodes || []);
  const inRegions = [...invById.values()].filter((r) => codes.has((r.location || '').toLowerCase()));
  const svcFiltered = e.services.length ? inRegions.filter((r) => e.services.some((s) => resourceMatchesService(r.type, s))) : inRegions;
  const list = (svcFiltered.length ? svcFiltered : inRegions).slice(0, 80);
  const cls = e.status === 'issue' ? 'crit' : e.status === 'maintenance' ? 'high' : 'low';
  const rows = list.map((r) => `<button class="sh-res" data-res="${h(r.id)}"><span class="sh-res-name">${h(r.name)}</span><span class="sh-res-type">${h(shortType(r.type))}</span><span class="sh-res-loc">${h(r.location)}</span></button>`).join('') || '<span class="muted small" style="padding:10px;display:block">none of your resources are in the impacted regions</span>';
  const root = $('modalRoot');
  root.innerHTML = `<div class="modal-backdrop" id="shBack"></div><div class="modal sh-modal">` +
    `<div class="sh-modal-head"><span class="sh-badge ${cls}">${h(e.eventType || e.status)}</span><h2>${h(e.title)}</h2></div>` +
    `<div class="sh-modal-sub">` +
      (e.services.length ? `<div class="sh-line"><span class="sh-k">Impacted services</span><span>${e.services.map((x) => `<span class="sh-svc">${h(x)}</span>`).join('')}</span></div>` : '') +
      `<div class="sh-line"><span class="sh-k">Impacted regions</span><span>${(e.regions || []).slice(0, 30).map((x) => `<span class="sh-reg">${h(x)}</span>`).join('') || 'non-regional'}</span></div>` +
      (e.trackingId ? `<div class="sh-line"><span class="sh-k">Tracking ID</span><span class="sh-track">${h(e.trackingId)}</span></div>` : '') +
    `</div>` +
    `<div class="sh-res-head">Your impacted resources <span class="muted">(${svcFiltered.length ? `${svcFiltered.length} matching this service` : `${inRegions.length} in impacted regions`}) \u2014 click to drill in</span></div>` +
    `<div class="sh-res-list">${rows}</div>` +
  `</div>`;
  root.classList.remove('hidden');
  $('shBack').addEventListener('click', () => { root.classList.add('hidden'); root.innerHTML = ''; });
  root.querySelectorAll('.sh-res').forEach((b) => b.addEventListener('click', () => { root.classList.add('hidden'); root.innerHTML = ''; openDock((b as HTMLElement).dataset.res!); }));
}

// ---- Ops panels (Backup/BCDR, Monitoring footprint, Change Tracking) ------
function renderOps(o: OpsResp) {
  panelData.backup = o; panelData.monitoring = o; panelData.changes = o;
  renderWaf();
  const b = o.backup || { protectedItems: 0, vaults: 0 };
  const cov = o.vmCount ? Math.round(Math.min(100, (b.protectedItems / o.vmCount) * 100)) : 0;
  setBody('backup',
    `<button class="gov-top clk-vm" title="Show the ${o.vmCount} VMs \u2192">${gauge(cov, { label: 'VM backup', sub: `${b.protectedItems} protected \u00b7 ${b.vaults} vault${b.vaults === 1 ? '' : 's'}`, color: cov >= 50 ? '#44ff88' : cov > 0 ? '#ffaa00' : '#ff6b4a' })}</button>` +
    `<div class="hrow"><div class="hb-top"><span class="hb-name">VMs in subscription</span><span class="hb-val">${o.vmCount}</span></div><div class="hb-track"><div class="hb-fill" style="width:${Math.max(2, cov)}%"></div></div></div>` +
    `<div class="hrow"><div class="hb-top"><span class="hb-name">Est. VM backup coverage</span><span class="hb-val">${cov}%</span></div></div>` +
    (b.error ? '<div class="finding"><span class="fdot sev-low"></span><div class="fbody"><div class="fsub">Recovery Services data unavailable</div></div></div>'
      : b.protectedItems === 0 && o.vmCount > 0 ? '<div class="finding"><span class="fdot sev-high"></span><div class="fbody"><div class="fsub">No backup-protected items \u2014 BCDR gap. Enable Azure Backup.</div></div></div>' : ''));
  setCount('backup', b.protectedItems);
  setSev('backup', b.protectedItems === 0 && o.vmCount > 0 ? 'high' : 'normal');
  document.getElementById('body-backup')?.querySelector('.clk-vm')?.addEventListener('click', () => openResourceDrill('Virtual machines', `${o.vmCount} VMs \u00b7 ${b.protectedItems} backup-protected`, invDrill(isVm)));

  const mon = o.vmCount ? Math.round((o.monitoredVms / o.vmCount) * 100) : 0;
  setBody('monitoring',
    `<button class="gov-top clk-vm" title="Show the ${o.vmCount} VMs \u2192">${gauge(mon, { label: 'VM Insights', sub: `${o.monitoredVms}/${o.vmCount} VMs`, color: mon >= 50 ? '#44ff88' : mon > 0 ? '#ffaa00' : '#ff6b4a' })}</button>` +
    `<div class="hrow"><div class="hb-top"><span class="hb-name">Monitored VMs</span><span class="hb-val">${o.monitoredVms}</span></div><div class="hb-track"><div class="hb-fill" style="width:${Math.max(2, mon)}%"></div></div></div>` +
    `<div class="hrow"><div class="hb-top"><span class="hb-name">Unmonitored VMs</span><span class="hb-val">${Math.max(0, o.vmCount - o.monitoredVms)}</span></div></div>` +
    (mon < 50 && o.vmCount > 0 ? '<div class="finding"><span class="fdot sev-med"></span><div class="fbody"><div class="fsub">Low coverage \u2014 deploy Azure Monitor Agent / VM Insights.</div></div></div>' : ''));
  setCount('monitoring', `${mon}%`);
  setSev('monitoring', mon < 50 && o.vmCount > 0 ? 'high' : 'normal');
  document.getElementById('body-monitoring')?.querySelector('.clk-vm')?.addEventListener('click', () => openResourceDrill('Virtual machines', `${o.vmCount} VMs \u00b7 ${o.monitoredVms} monitored`, invDrill(isVm)));

  const ch = o.changes || [];
  setBody('changes', ch.length
    ? ch.slice(0, 16).map((c) => {
      const ct = (c.changeType || '').toLowerCase();
      const cls = ct === 'create' ? 'sev-low' : ct === 'delete' ? 'sev-high' : 'sev-med';
      return `<div class="finding"><span class="fdot ${cls}"></span><div class="fbody"><div class="ftitle">${h(resName(c.target))}</div><div class="fsub">${h(c.changeType || 'Update')} \u00b7 ${fmtAgo(c.ts)}</div></div></div>`;
    }).join('')
    : `<span class="muted">${o.changesError ? 'change tracking unavailable' : 'no resource changes in ~14d'}</span>`);
  setCount('changes', ch.length);
  setSev('changes', ch.some((c) => (c.changeType || '').toLowerCase() === 'delete') ? 'high' : 'normal');
  updateTicker();
}
function fmtAgo(ts: string): string {
  const t = Date.parse(ts);
  if (isNaN(t)) return ts || '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return 'just now';
  const m = s / 60; if (m < 60) return `${Math.round(m)}m ago`;
  const hr = m / 60; if (hr < 24) return `${Math.round(hr)}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

// ---- Well-Architected Framework pillar dashboard --------------------------
function clamp100(n: number): number { return Math.max(0, Math.min(100, Math.round(n))); }
function scoreColor(s: number): string { return s >= 75 ? '#44ff88' : s >= 50 ? '#ffaa00' : '#ff6b4a'; }
interface WafPillar { key: string; label: string; score: number; metrics: { l: string; v: string; warn?: boolean }[]; }
function computeWaf(): { pillars: WafPillar[]; overall: number } | null {
  const p = panelData.security as PostureResp | undefined;
  const o = panelData.backup as OpsResp | undefined;
  const w = panelData.waste as OptimizeResp | undefined;
  const s = panelData.kpi as SummaryResp | undefined;
  if (!p && !o && !w && !s) return null;
  const pillars: WafPillar[] = [];
  // Reliability \u2014 zone-pinned %, zone-redundant, VM backup coverage.
  {
    const r = p?.resiliency;
    const pinnedPct = r && r.total ? (r.zonePinned / r.total) * 100 : 0;
    const redundantPct = r && r.total ? (r.zoneRedundant / r.total) * 100 : 0;
    const vm = o?.vmCount ?? 0;
    const backupCov = vm ? (Math.min(o!.backup.protectedItems, vm) / vm) * 100 : (o?.backup.protectedItems ? 100 : 0);
    pillars.push({ key: 'waf-rel', label: 'Reliability', score: clamp100(0.45 * pinnedPct + 0.2 * redundantPct + 0.35 * backupCov), metrics: [
      { l: 'Zone-pinned', v: r ? `${Math.round(pinnedPct)}% \u00b7 ${r.zonePinned}/${r.total}` : '\u2014', warn: pinnedPct < 30 },
      { l: 'Zone-redundant', v: r ? String(r.zoneRedundant) : '\u2014' },
      { l: 'VM backup coverage', v: vm ? `${Math.round(backupCov)}% \u00b7 ${o!.backup.protectedItems}/${vm}` : `${o?.backup.protectedItems ?? 0} items`, warn: vm > 0 && backupCov < 50 },
      { l: 'Recovery vaults', v: String(o?.backup.vaults ?? 0) },
    ] });
  }
  // Security \u2014 Defender secure score (or derived from unhealthy findings).
  {
    const sec = p?.security || [];
    const uh = (sev: string) => sec.filter((x) => x.status === 'Unhealthy' && String(x.severity).toLowerCase() === sev).reduce((a, x) => a + x.count, 0);
    const high = uh('high'), med = uh('medium'), low = uh('low');
    const sc = p?.secureScore;
    pillars.push({ key: 'waf-sec', label: 'Security', score: sc ? clamp100(sc.pct ?? (sc.max ? (sc.current / sc.max) * 100 : 0)) : clamp100(100 - (high * 8 + med * 3 + low)), metrics: [
      { l: 'Secure score', v: sc ? `${sc.current}/${sc.max}` : 'n/a' },
      { l: 'High findings', v: String(high), warn: high > 0 },
      { l: 'Medium findings', v: String(med), warn: med > 0 },
      { l: 'Low findings', v: String(low) },
    ] });
  }
  // Cost optimization \u2014 savings opportunity vs run-rate, waste, tag coverage.
  {
    const monthlySpend = s ? s.dailyBurn * 30 : 0;
    const savings = w?.estimatedMonthlySavings ?? 0;
    const ratio = monthlySpend > 0 ? (savings / monthlySpend) * 100 : (savings > 0 ? 60 : 0);
    const wasteCount = w ? w.findings.reduce((a, f) => a + f.count, 0) : 0;
    pillars.push({ key: 'waf-cost', label: 'Cost Optimization', score: clamp100(100 - Math.min(100, ratio)), metrics: [
      { l: 'Monthly run-rate', v: s ? money(monthlySpend, s.currency) : '\u2014' },
      { l: 'Savings opportunity', v: w ? `${money(savings, w.currency)}/mo` : '\u2014', warn: ratio > 15 },
      { l: 'Waste items', v: String(wasteCount), warn: wasteCount > 0 },
      { l: 'Tag coverage', v: s ? `${Math.round(s.taggedPct)}%` : '\u2014', warn: !!s && s.taggedPct < 60 },
    ] });
  }
  // Operational excellence \u2014 monitoring coverage + tag governance + change visibility.
  {
    const vm = o?.vmCount ?? 0;
    const monPct = vm ? (o!.monitoredVms / vm) * 100 : (o?.monitoredVms ? 100 : 0);
    const tagPct = s?.taggedPct ?? 0;
    pillars.push({ key: 'waf-ops', label: 'Operational Excellence', score: clamp100(0.5 * monPct + 0.5 * tagPct), metrics: [
      { l: 'VM monitoring', v: vm ? `${Math.round(monPct)}% \u00b7 ${o!.monitoredVms}/${vm}` : 'no VMs', warn: vm > 0 && monPct < 50 },
      { l: 'Tag governance', v: s ? `${Math.round(tagPct)}%` : '\u2014', warn: tagPct < 60 },
      { l: 'Recent changes (14d)', v: String(o?.changes.length ?? 0) },
    ] });
  }
  // Performance efficiency \u2014 Advisor performance recs + idle/underutilized resources.
  {
    const adv = p?.advisor || [];
    const perfRecs = adv.filter((a) => a.category === 'Performance').reduce((a2, x) => a2 + x.count, 0);
    const idle = w ? w.findings.filter((f) => /idle|underutil|stopped|orphan/i.test(f.label)).reduce((a, f) => a + f.count, 0) : 0;
    pillars.push({ key: 'waf-perf', label: 'Performance Efficiency', score: clamp100(100 - perfRecs * 6 - idle * 3), metrics: [
      { l: 'Performance advisories', v: String(perfRecs), warn: perfRecs > 0 },
      { l: 'Idle / underutilized', v: String(idle), warn: idle > 0 },
      { l: 'Resources analysed', v: s ? String(s.resourceCount) : '\u2014' },
    ] });
  }
  return { pillars, overall: clamp100(pillars.reduce((a, x) => a + x.score, 0) / pillars.length) };
}
// Each WAF pillar gauge drills into the resources that drive its score.
function wafDrill(key: string) {
  const w = panelData.waste as OptimizeResp | undefined;
  if (key === 'waf-cost') openResourceDrill('Cost Optimization \u00b7 spend by resource', 'top resources by cost', invDrill());
  else if (key === 'waf-rel') openResourceDrill('Reliability \u00b7 virtual machines', 'VMs (backup & zone resilience apply here)', invDrill(isVm));
  else if (key === 'waf-ops') openResourceDrill('Operational Excellence \u00b7 untagged resources', 'untagged resources weaken governance & ops', invDrill(isUntagged));
  else if (key === 'waf-perf') {
    const idle = w ? w.findings.filter((f) => /idle|orphan|underutil|stopped|unattached|deallocat/i.test(f.label)).flatMap((f) => (f.resources || []).map((r) => ({ id: r.id, name: r.name, type: r.type, resourceGroup: r.resourceGroup, location: r.location, cost: r.monthlyCost }))) : [];
    openResourceDrill('Performance Efficiency \u00b7 idle / underutilized', 'resources flagged idle, orphaned or stopped', idle);
  } else openResourceDrill('Security findings', 'Defender assessments are estate-wide \u2014 open any resource\u2019s Security tab for per-resource detail', []);
}
function renderWaf() {
  const waf = computeWaf();
  if (!waf) return;
  for (const pil of waf.pillars) {
    const metrics = pil.metrics.map((m) => `<div class="hrow"><div class="hb-top"><span class="hb-name">${h(m.l)}</span><span class="hb-val${m.warn ? ' warn' : ''}">${h(m.v)}</span></div></div>`).join('');
    setBody(pil.key, `<div class="waf-pill"><button class="gov-top clk-waf" data-waf="${pil.key}" title="Drill into resources \u2192">${gauge(pil.score, { label: 'score', sub: pil.label, color: scoreColor(pil.score) })}</button><div class="waf-metrics">${metrics}</div></div>`);
    setCount(pil.key, String(pil.score));
    setSev(pil.key, pil.score >= 75 ? 'normal' : pil.score >= 50 ? 'high' : 'critical');
    document.getElementById(`body-${pil.key}`)?.querySelector('.clk-waf')?.addEventListener('click', () => wafDrill(pil.key));
  }
  const bars = waf.pillars.map((p) => `<div class="waf-bar-row"><span class="waf-bar-l">${h(p.label)}</span><div class="waf-bar-track"><div class="waf-bar-fill" style="width:${p.score}%;background:${scoreColor(p.score)}"></div></div><span class="waf-bar-v" style="color:${scoreColor(p.score)}">${p.score}</span></div>`).join('');
  setBody('waf-score', `<div class="waf-score-wrap"><div class="waf-overall"><div class="waf-overall-num" style="color:${scoreColor(waf.overall)}">${waf.overall}</div><div class="waf-overall-l">WELL-ARCHITECTED<br/>SCORE</div></div><div class="waf-bars">${bars}</div></div><div class="waf-actions"><button class="waf-exp" id="wafCsv">\u2913 Excel (CSV)</button><button class="waf-exp" id="wafPdf">\u2913 PDF report</button><span class="waf-note">Live Defender, Advisor, Resource Graph &amp; Cost Management data.</span></div>`);
  setCount('waf-score', String(waf.overall));
  setSev('waf-score', waf.overall >= 75 ? 'normal' : waf.overall >= 50 ? 'high' : 'critical');
  document.getElementById('wafCsv')?.addEventListener('click', () => exportWafCsv(waf));
  document.getElementById('wafPdf')?.addEventListener('click', () => exportWafPdf(waf));
}
function exportWafCsv(waf: { pillars: WafPillar[]; overall: number }) {
  const head = ['Pillar', 'Score', 'Metric', 'Value', 'Flag'];
  const rows: (string | number)[][] = [];
  for (const p of waf.pillars) for (const m of p.metrics) rows.push([p.label, p.score, m.l, m.v, m.warn ? 'attention' : 'ok']);
  rows.push(['OVERALL', waf.overall, 'Well-Architected Score', `${waf.overall}/100`, '']);
  const subName = allSubs.find((x) => x.subscriptionId === state.subscriptionId)?.displayName || state.subscriptionId || 'subscription';
  downloadCsv(`waf-assessment-${subName}`.replace(/[^\w.-]+/g, '-').toLowerCase(), head, rows);
}
function exportWafPdf(waf: { pillars: WafPillar[]; overall: number }) {
  const subName = allSubs.find((x) => x.subscriptionId === state.subscriptionId)?.displayName || state.subscriptionId || 'subscription';
  const when = new Date().toUTCString();
  const pill = (p: WafPillar) => `<section class="p"><h2>${h(p.label)} <span class="sc" style="color:${scoreColor(p.score)}">${p.score}/100</span></h2><table>${p.metrics.map((m) => `<tr><td>${h(m.l)}</td><td class="${m.warn ? 'w' : ''}">${h(m.v)}</td></tr>`).join('')}</table></section>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>WAF Assessment \u2014 ${h(subName)}</title><style>body{font:13px 'Segoe UI',system-ui,sans-serif;color:#1b1b1b;margin:32px}h1{font-size:20px;margin:0 0 2px}.meta{color:#666;font-size:12px;margin-bottom:18px}.overall{display:flex;align-items:center;gap:14px;border:1px solid #ddd;padding:14px 18px;margin-bottom:18px}.overall .n{font-size:40px;font-weight:700}.overall .l{font-size:12px;color:#666;text-transform:uppercase;letter-spacing:1px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}section.p{border:1px solid #ddd;padding:12px 14px;break-inside:avoid}h2{font-size:14px;margin:0 0 8px;display:flex;justify-content:space-between}.sc{font-weight:700}table{width:100%;border-collapse:collapse}td{padding:4px 2px;border-bottom:1px solid #eee;font-size:12px}td.w{color:#b00020;font-weight:600}footer{margin-top:20px;color:#888;font-size:11px}@media print{body{margin:14mm}}</style></head><body><h1>Azure Well-Architected Assessment</h1><div class="meta">Subscription: <b>${h(subName)}</b> &nbsp;\u00b7&nbsp; Period: ${h(state.range)} &nbsp;\u00b7&nbsp; Generated: ${h(when)}</div><div class="overall"><div class="n" style="color:${scoreColor(waf.overall)}">${waf.overall}</div><div class="l">Overall<br/>Well-Architected Score</div></div><div class="grid">${waf.pillars.map(pill).join('')}</div><footer>Scores derived from live Microsoft Defender for Cloud, Azure Advisor, Azure Resource Graph and Cost Management data. Directional assessment \u2014 not an official Microsoft WAF review.</footer><scr${''}ipt>window.onload=function(){setTimeout(function(){window.print()},250)}</scr${''}ipt></body></html>`;
  const win = window.open('', '_blank');
  if (!win) { showBanner('Allow pop-ups to export the PDF report.'); return; }
  win.document.write(html); win.document.close();
}

// ---- Dependency Map (top-connected resources by edge degree) --------------
async function loadDeps(sub: string) {
  if (depsLoaded === sub) return;
  try {
    const [inv, link] = await Promise.all([api.inventory(sub), api.linkage(sub)]);
    if (state.subscriptionId !== sub) return;
    const byId = new Map(inv.resources.map((r) => [r.id.toLowerCase(), r]));
    const deg = new Map<string, number>();
    for (const e of link.edges) {
      deg.set(e.from.toLowerCase(), (deg.get(e.from.toLowerCase()) || 0) + 1);
      deg.set(e.to.toLowerCase(), (deg.get(e.to.toLowerCase()) || 0) + 1);
    }
    const top = [...deg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    const max = top.length ? top[0][1] : 1;
    panelData.deps = {
      count: link.count, degSize: deg.size,
      top: [...deg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([id, dg]) => {
        const r = byId.get(id);
        return { id: r?.id || id, name: r?.name || resName(id), type: r?.type || '', degree: dg };
      }),
    };
    const rows = top.map(([id, dg]) => {
      const r = byId.get(id);
      return `<div class="hrow clk-dep" data-id="${h(r?.id || id)}" style="cursor:pointer"><div class="hb-top"><span class="hb-name dep-name" title="${h(shortType(r?.type || ''))}">${typeIcon(r?.type || '', { tinted: true })}<span>${h(r?.name || resName(id))}</span></span><span class="hb-val">${dg} link${dg === 1 ? '' : 's'}</span></div><div class="hb-track"><div class="hb-fill" style="width:${Math.max(4, (dg / max) * 100).toFixed(0)}%"></div></div></div>`;
    }).join('');
    setBody('deps', `<div class="muted small" style="margin-bottom:6px">${link.count} dependencies \u00b7 ${deg.size} connected resources</div>${rows || '<span class="muted">no dependency edges detected</span>'}`);
    setCount('deps', link.count);
    document.querySelectorAll('#body-deps .clk-dep').forEach((el) => el.addEventListener('click', () => openDock((el as HTMLElement).dataset.id!)));
    depsLoaded = sub;
  } catch { setBody('deps', 'error'); }
}

// ---- What's New in Azure — live media center + resource-mapped catalog ----
// Maps an Azure resource type to a content category so the catalog can surface
// updates/videos relevant to whatever resource the user is viewing.
const TYPE_CATEGORY: [RegExp, string][] = [
  [/virtualmachines|scalesets|availabilitysets|\/disks|microsoft\.compute/, 'compute'],
  [/managedclusters|containerapps|containerinstance|registries|kubernetes|managedenvironments/, 'containers'],
  [/microsoft\.web|\/sites|serverfarms|staticsites|functions/, 'web'],
  [/microsoft\.sql|cosmos|documentdb|postgres|mysql|mariadb|\/redis|cache/, 'database'],
  [/storage|netapp|datalake|elasticsan/, 'storage'],
  [/cognitiveservices|openai|machinelearning|\/searchservices|botservice/, 'ai'],
  [/network\/|virtualnetworks|firewall|loadbalancer|frontdoor|\/dns|vpn|expressroute|bastion|natgateway|publicip|networkinterface|applicationgateway|trafficmanager|privatedns/, 'networking'],
  [/keyvault|defender|sentinel|\/security|entra|managedidentity|authorization|microsoft\.insights\/.*alert/, 'security'],
  [/synapse|datafactory|databricks|streamanalytics|eventhub|kusto|dataexplorer|purview|fabric|hdinsight/, 'analytics'],
  [/servicebus|eventgrid|\/workflows|apimanagement|relay|notificationhubs/, 'integration'],
  [/operationalinsights|insights\/components|\/monitor|grafana|devops/, 'devops'],
  [/costmanagement|advisor|resourcegraph|managementgroups|\/policy|blueprint/, 'management'],
];
function typeToCategory(type: string): string | null {
  const t = (type || '').toLowerCase();
  for (const [re, id] of TYPE_CATEGORY) if (re.test(t)) return id;
  return null;
}

let whatsNewData: WhatsNewResp | null = null;
let wnLoading = false;
let wnChannel = 'build';
let wnVideoId: string | null = null;
let wnBuildVideoId: string | null = null;
let wnCategory = 'all';
let wnVidCat = 'all';
let wnBuildTopic = 'all';
let wnBuildType = 'all';
let wnBuildLevel = 'all';

function ensureWhatsNew() {
  if (whatsNewData || wnLoading) return;
  wnLoading = true;
  api.whatsNew().then((d) => { whatsNewData = d; wnLoading = false; renderVideo(); }).catch(() => { wnLoading = false; const b = document.getElementById('body-video'); if (b) b.innerHTML = '<span class="muted">What\u2019s New feed unavailable</span>'; });
}
const wnStatusCls = (s: string) => /launch|general/i.test(s) ? 'ga' : /preview/i.test(s) ? 'prev' : /develop/i.test(s) ? 'dev' : '';

function renderVideo() {
  const body = document.getElementById('body-video');
  if (!body) return;
  const d = whatsNewData;
  if (!d) { body.innerHTML = '<div class="wn-loading"><span class="muted">loading Microsoft media\u2026</span></div>'; ensureWhatsNew(); return; }
  const catLabel = (id: string) => d.categories.find((c) => c.id === id)?.label || id;
  const onBuild = wnChannel === 'build' && !!d.build;
  const buildN = d.build?.sessions.length || 0;
  let ch = onBuild ? undefined : (d.channels.find((c) => c.id === wnChannel) || d.channels[0]);
  // Always land on a channel that actually has playable videos, so the inline player +
  // thumbnails show by default (instead of an empty media area or external-only links).
  if (!onBuild && (!ch || !ch.videos.length)) {
    const best = d.channels.filter((c) => c.videos.length).sort((a, b) => b.videos.length - a.videos.length)[0];
    if (best) ch = best;
  }
  const isEvent = !!ch?.event;
  const allVids = ch?.videos || [];
  const vidCats = [...new Set(allVids.map((v) => v.category).filter(Boolean))];
  if (!vidCats.includes(wnVidCat)) wnVidCat = 'all';
  const vids = (wnVidCat !== 'all') ? allVids.filter((v) => v.category === wnVidCat) : allVids;
  if (!onBuild && (!wnVideoId || !vids.some((v) => v.videoId === wnVideoId))) wnVideoId = vids[0]?.videoId || null;
  const buildTab = d.build ? `<button class="wn-ch ${onBuild ? 'active' : ''} evt" data-ch="build" title="${h(d.build.event)} \u00b7 ${buildN} sessions">Microsoft Build<span class="wn-ch-n">${buildN}</span></button>` : '';
  const chTabs = buildTab + d.channels.map((c) => `<button class="wn-ch ${(!onBuild && c.id === ch?.id) ? 'active' : ''} ${c.event ? 'evt' : ''}" data-ch="${h(c.id)}" title="${h(c.name)}${c.videos.length ? ` \u00b7 ${c.videos.length} videos` : ''}">${h(c.name)}${c.videos.length ? `<span class="wn-ch-n">${c.videos.length}</span>` : ''}</button>`).join('');
  let middle: string;
  if (onBuild) {
    middle = buildMediaHtml(d.build!);
  } else {
    const vidCatBar = (vidCats.length > 1)
      ? `<div class="wn-vidcats"><button class="wn-vidcat ${wnVidCat === 'all' ? 'active' : ''}" data-vc="all">All</button>${vidCats.map((c) => `<button class="wn-vidcat ${wnVidCat === c ? 'active' : ''}" data-vc="${h(c)}">${h(catLabel(c))}</button>`).join('')}</div>`
      : '';
    const watch = wnVideoId ? `<a class="wn-watch" href="https://www.youtube.com/watch?v=${encodeURIComponent(wnVideoId)}" target="_blank" rel="noopener" title="Watch on YouTube">YouTube \u2197</a>` : '';
    const curTitle = vids.find((v) => v.videoId === wnVideoId)?.title || '';
    const player = wnVideoId
      ? `<div class="wn-player"><iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(wnVideoId)}?rel=0&modestbranding=1&autoplay=1&mute=1&playsinline=1" title="${h(curTitle || ch?.name || 'Microsoft')} video" loading="lazy" frameborder="0" allow="accelerometer; autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe><button class="wn-expand" id="wnExpand" title="Expand to full screen"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/></svg></button></div>`
      : `<div class="wn-player wn-player-empty"><span class="muted">${isEvent ? `New ${h(ch?.name || '')} sessions appear here during &amp; after the event` : 'no featured video'}</span></div>`;
    const tiles = vids.slice(0, 16).map((v) => `<button class="wn-tile ${v.videoId === wnVideoId ? 'active' : ''}" data-vid="${h(v.videoId)}" title="${h(v.title)}"><img loading="lazy" src="${h(v.thumb)}" alt="" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='https://i.ytimg.com/vi/'+this.parentElement.dataset.vid+'/hqdefault.jpg'"/><span class="wn-tile-ov"><span class="wn-tile-title">${h(v.title)}</span></span><span class="wn-tile-play">\u25b6</span></button>`).join('');
    middle =
      `<div class="wn-live">` +
        `<div class="wn-live-head"><span class="wn-live-dot"></span><span class="wn-live-label">${isEvent ? 'SESSIONS' : 'NOW PLAYING'}</span><span class="wn-now" title="${h(curTitle)}">${h(curTitle || (ch ? ch.name : ''))}</span>${watch}</div>` +
        player +
        `<div class="wn-strip-head"><span class="wn-strip-lbl">${ch ? h(ch.name) : ''} \u00b7 ${vids.length} VIDEO${vids.length === 1 ? '' : 'S'} \u00b7 scroll \u2193</span>${vidCatBar}</div>` +
        `<div class="wn-grid">${tiles}</div>` +
      `</div>`;
  }
  const stale = d._stale ? '<span class="stale-badge">cached</span>' : '';
  body.innerHTML =
    `<div class="wn">` +
      `<div class="wn-catalog-bar"><span class="wn-catalog-label">CATALOG</span><div class="wn-chs">${chTabs}</div></div>` +
      (stale ? `<div class="wn-stale-row">${stale}</div>` : '') +
      middle +
      `<div class="wn-sec-head">Azure Product Updates \u00b7 <b>${d.updates.length}</b></div>` +
      `<div class="wn-cats" id="wnCats">${wnCatsHtml(d)}</div>` +
      `<div id="wnCatalog">${wnCatalogHtml(d)}</div>` +
    `</div>`;
  setCount('video', d.updates.length);
  body.querySelectorAll('.wn-ch').forEach((b) => b.addEventListener('click', () => { wnChannel = (b as HTMLElement).dataset.ch!; wnVidCat = 'all'; wnVideoId = null; renderVideo(); }));
  if (onBuild) {
    wireBuildFilters(body);
    body.querySelectorAll('.wn-grid .wn-tile').forEach((b) => b.addEventListener('click', () => { wnBuildVideoId = (b as HTMLElement).dataset.bvid!; renderVideo(); document.querySelector('#body-video .wn-player')?.scrollIntoView({ block: 'nearest' }); }));
    const bex = document.getElementById('wnBuildExpand');
    if (bex && wnBuildVideoId) bex.addEventListener('click', () => openWnModalVideo(wnBuildVideoId!, d.build?.videos.find((v) => v.videoId === wnBuildVideoId)?.title || ''));
  } else {
    body.querySelectorAll('.wn-vidcat').forEach((b) => b.addEventListener('click', () => { wnVidCat = (b as HTMLElement).dataset.vc!; wnVideoId = null; renderVideo(); }));
    body.querySelectorAll('.wn-grid .wn-tile').forEach((b) => b.addEventListener('click', () => { wnVideoId = (b as HTMLElement).dataset.vid!; renderVideo(); document.querySelector('#body-video .wn-player')?.scrollIntoView({ block: 'nearest' }); }));
    const ex = document.getElementById('wnExpand');
    if (ex && wnVideoId) ex.addEventListener('click', () => openWnModalVideo(wnVideoId!, allVids.find((v) => v.videoId === wnVideoId)?.title || ''));
  }
  wireWnCats(body);
  const catEl = body.querySelector('#wnCatalog');
  if (catEl) wireWnCatalog(catEl as HTMLElement);
}
// Microsoft Build tab — a featured video player + thumbnail strip of REAL Build session
// recordings (from the official Microsoft Developer channel) on top of the filterable
// session catalog, so the tab matches the rich media look of the other channels.
function buildMediaHtml(b: BuildCatalog): string {
  const vids = b.videos || [];
  if (vids.length && (!wnBuildVideoId || !vids.some((v) => v.videoId === wnBuildVideoId))) wnBuildVideoId = vids[0].videoId;
  const cur = vids.find((v) => v.videoId === wnBuildVideoId);
  let media = '';
  if (vids.length) {
    const watch = wnBuildVideoId ? `<a class="wn-watch" href="https://www.youtube.com/watch?v=${encodeURIComponent(wnBuildVideoId)}" target="_blank" rel="noopener" title="Watch on YouTube">YouTube \u2197</a>` : '';
    const player = `<div class="wn-player"><iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(wnBuildVideoId!)}?rel=0&modestbranding=1&autoplay=1&mute=1&playsinline=1" title="${h(cur?.title || 'Microsoft Build')} video" loading="lazy" frameborder="0" allow="accelerometer; autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe><button class="wn-expand" id="wnBuildExpand" title="Expand to full screen"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/></svg></button></div>`;
    const tiles = vids.slice(0, 16).map((v) => `<button class="wn-tile ${v.videoId === wnBuildVideoId ? 'active' : ''}" data-bvid="${h(v.videoId)}" title="${h(v.title)}"><img loading="lazy" src="${h(v.thumb)}" alt="" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='https://i.ytimg.com/vi/'+this.parentElement.dataset.bvid+'/hqdefault.jpg'"/><span class="wn-tile-ov"><span class="wn-tile-title">${h(v.title)}</span></span><span class="wn-tile-play">\u25b6</span></button>`).join('');
    media =
      `<div class="wn-live">` +
        `<div class="wn-live-head"><span class="wn-live-dot"></span><span class="wn-live-label">SESSIONS ON DEMAND</span><span class="wn-now" title="${h(cur?.title || '')}">${h(cur?.title || '')}</span>${watch}</div>` +
        player +
        `<div class="wn-strip-head"><span class="wn-strip-lbl">${h(b.event)} \u00b7 ${vids.length} VIDEO${vids.length === 1 ? '' : 'S'} \u00b7 scroll \u2193</span></div>` +
        `<div class="wn-grid">${tiles}</div>` +
      `</div>`;
  }
  return media + buildSessionsHtml(b);
}
function buildSessionsHtml(b: BuildCatalog): string {
  const typeCls = (t: string) => /keynote/i.test(t) ? 'key' : /breakout/i.test(t) ? 'brk' : /demo/i.test(t) ? 'dem' : /lab|workshop/i.test(t) ? 'lab' : 'live';
  if (wnBuildTopic !== 'all' && !b.topics.includes(wnBuildTopic)) wnBuildTopic = 'all';
  const filtered = b.sessions.filter((s) =>
    (wnBuildTopic === 'all' || s.topic === wnBuildTopic) &&
    (wnBuildType === 'all' || s.type === wnBuildType) &&
    (wnBuildLevel === 'all' || String(s.level) === wnBuildLevel));
  const opt = (cur: string, val: string, label: string) => `<option value="${h(val)}"${cur === val ? ' selected' : ''}>${h(label)}</option>`;
  const filters = `<div class="bsx-filters">` +
    `<select id="bsTopic" class="bs-sel"><option value="all">All topics</option>${b.topics.map((t) => opt(wnBuildTopic, t, t)).join('')}</select>` +
    `<select id="bsType" class="bs-sel"><option value="all">All formats</option>${b.types.map((t) => opt(wnBuildType, t, t)).join('')}</select>` +
    `<select id="bsLevel" class="bs-sel"><option value="all">All levels</option>${b.levels.map((l) => opt(wnBuildLevel, String(l), `Level ${l}`)).join('')}</select>` +
    `</div>`;
  const cards = filtered.length ? filtered.map((s) =>
    `<button class="bs-card" data-url="${h(s.url)}" data-title="${h(s.title)}" title="${h(s.title)} \u2014 ${h(s.speaker)} \u00b7 open in app"><span class="bs-code t-${typeCls(s.type)}">${h(s.code)}</span><span class="bs-main"><span class="bs-title">${h(s.title)}</span><span class="bs-meta"><span class="bs-type">${h(s.type)}</span>${s.level ? `<span class="bs-lvl">L${s.level}</span>` : ''}<span class="bs-topic">${h(s.topic)}</span>${s.speaker ? `<span class="bs-spk">${h(s.speaker)}</span>` : ''}</span></span><span class="bs-go">\u25b6</span></button>`).join('')
    : '<span class="muted small" style="padding:10px">No sessions match these filters.</span>';
  return `<div class="bsx">` +
    `<div class="bsx-head"><span class="bsx-evt"><span class="wn-live-dot"></span>${h(b.event)} \u00b7 ${filtered.length} of ${b.sessions.length} sessions</span><a class="bsx-all" href="${h(b.url)}" target="_blank" rel="noopener">Full catalog \u2197</a></div>` +
    filters +
    `<div class="bsx-list">${cards}</div>` +
    `</div>`;
}
function wireBuildFilters(scope: HTMLElement) {
  const t = scope.querySelector('#bsTopic') as HTMLSelectElement | null;
  const ty = scope.querySelector('#bsType') as HTMLSelectElement | null;
  const lv = scope.querySelector('#bsLevel') as HTMLSelectElement | null;
  if (t) t.addEventListener('change', () => { wnBuildTopic = t.value; renderVideo(); });
  if (ty) ty.addEventListener('change', () => { wnBuildType = ty.value; renderVideo(); });
  if (lv) lv.addEventListener('change', () => { wnBuildLevel = lv.value; renderVideo(); });
  scope.querySelectorAll('.bs-card').forEach((b) => b.addEventListener('click', () => openWnModalSession((b as HTMLElement).dataset.url!, (b as HTMLElement).dataset.title || '')));
}
function wnCatsHtml(d: WhatsNewResp): string {
  const counts = new Map<string, number>();
  for (const u of d.updates) counts.set(u.category, (counts.get(u.category) || 0) + 1);
  const cats = [{ id: 'all', label: 'All' }, ...d.categories];
  return cats.map((c) => {
    const n = c.id === 'all' ? d.updates.length : (counts.get(c.id) || 0);
    if (c.id !== 'all' && !n) return '';
    return `<button class="wn-cat ${c.id === wnCategory ? 'active' : ''}" data-cat="${h(c.id)}">${h(c.label)}<span class="wn-cat-n">${n}</span></button>`;
  }).join('');
}
function wnCatalogHtml(d: WhatsNewResp): string {
  const catVids = wnCategory === 'all' ? [] : d.channels.flatMap((c) => c.videos).filter((v) => v.category === wnCategory).slice(0, 4);
  const catVidHtml = catVids.length ? `<div class="wn-catvids">${catVids.map((v) => `<button class="wn-thumb sm" data-vid="${h(v.videoId)}" title="${h(v.title)}"><img loading="lazy" src="${h(v.thumb)}" alt="" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='https://i.ytimg.com/vi/'+this.parentElement.dataset.vid+'/hqdefault.jpg'"/><span class="wn-thumb-title">${h(v.title)}</span></button>`).join('')}</div>` : '';
  const ups = (wnCategory === 'all' ? d.updates : d.updates.filter((u) => u.category === wnCategory)).slice(0, 16);
  const upHtml = ups.map((u) => {
    const sc = wnStatusCls(u.status);
    return `<button class="wn-up" data-up-id="${h(u.id)}"><span class="wn-up-dot ${sc}"></span><div class="wn-up-body"><div class="wn-up-title">${h(u.title)}</div><div class="wn-up-meta">${u.status ? `<span class="wn-up-status ${sc}">${h(u.status)}</span>` : ''}${u.products.slice(0, 2).map((p) => `<span class="wn-up-prod">${h(p)}</span>`).join('')}${u.date ? `<span class="wn-up-date">${fmtAgo(u.date)}</span>` : ''}</div></div><span class="wn-up-go">\u203a</span></button>`;
  }).join('') || '<span class="muted small" style="padding:8px">no updates in this category</span>';
  return catVidHtml + `<div class="wn-ups">${upHtml}</div>`;
}
function wireWnCats(scope: HTMLElement) {
  scope.querySelectorAll('.wn-cat').forEach((b) => b.addEventListener('click', () => setWhatsNewCategory((b as HTMLElement).dataset.cat!)));
}
function wireWnCatalog(scope: HTMLElement) {
  scope.querySelectorAll('.wn-thumb').forEach((b) => b.addEventListener('click', () => openWnModalVideo((b as HTMLElement).dataset.vid!, (b as HTMLElement).getAttribute('title') || '')));
  scope.querySelectorAll('.wn-up').forEach((b) => b.addEventListener('click', () => openWnUpdateById((b as HTMLElement).dataset.upId!)));
}
// Switch catalog category WITHOUT restarting the featured player.
function setWhatsNewCategory(cat: string) {
  wnCategory = cat;
  const d = whatsNewData; if (!d) return;
  const cats = document.getElementById('wnCats');
  const catalog = document.getElementById('wnCatalog');
  if (cats) { cats.innerHTML = wnCatsHtml(d); wireWnCats(cats); }
  if (catalog) { catalog.innerHTML = wnCatalogHtml(d); wireWnCatalog(catalog); }
}
// Contextual "What's new" block for the resource dock, scoped to the resource's category.
function dockWhatsNewHtml(type: string): string {
  const cat = typeToCategory(type);
  const d = whatsNewData;
  if (!cat) return '';
  if (!d) { ensureWhatsNew(); return ''; }
  const label = d.categories.find((c) => c.id === cat)?.label || cat;
  const ups = d.updates.filter((u) => u.category === cat).slice(0, 4);
  if (!ups.length) return '';
  const rows = ups.map((u) => {
    const sc = wnStatusCls(u.status);
    return `<button class="wn-up sm" data-up-id="${h(u.id)}"><span class="wn-up-dot ${sc}"></span><div class="wn-up-body"><div class="wn-up-title">${h(u.title)}</div>${u.status ? `<div class="wn-up-meta"><span class="wn-up-status ${sc}">${h(u.status)}</span><span class="wn-up-date">${fmtAgo(u.date)}</span></div>` : ''}</div><span class="wn-up-go">\u203a</span></button>`;
  }).join('');
  return `<div class="dsec"><h4>What\u2019s new \u00b7 ${h(label)}</h4>${rows}</div>`;
}

// ---- In-tool media / update modal (nothing opens as an external hyperlink) ----
let wnModalWired = false;
function showWnModal(inner: string, cls = '') {
  let root = document.getElementById('wnModal');
  if (!root) { root = document.createElement('div'); root.id = 'wnModal'; root.className = 'wn-modal'; document.body.appendChild(root); }
  root.innerHTML = `<div class="wn-modal-back" id="wnModalBack"></div><div class="wn-modal-box ${cls}"><button class="wn-modal-x" id="wnModalX" title="Close">\u2715</button><div class="wn-modal-body">${inner}</div></div>`;
  root.classList.add('open');
  document.getElementById('wnModalBack')!.addEventListener('click', closeWnModal);
  document.getElementById('wnModalX')!.addEventListener('click', closeWnModal);
  if (!wnModalWired) { wnModalWired = true; document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeWnModal(); }); }
}
function closeWnModal() { const r = document.getElementById('wnModal'); if (r) { r.classList.remove('open'); r.innerHTML = ''; } }
function openWnModalVideo(videoId: string, title: string) {
  if (!videoId) return;
  showWnModal(`<div class="wnm-video"><iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?rel=0&modestbranding=1&autoplay=1&playsinline=1" title="${h(title)}" frameborder="0" allow="accelerometer; autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe></div>${title ? `<div class="wnm-title">${h(title)}</div>` : ''}`, 'video');
}
// Build session pages open INSIDE the app (modal iframe), not a new browser window.
// A fallback link covers the rare case the embed is blocked by the remote site.
function openWnModalSession(url: string, title: string) {
  if (!url) return;
  showWnModal(
    `<div class="wnm-session"><iframe src="${h(url)}" title="${h(title)}" frameborder="0" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="no-referrer-when-downgrade"></iframe></div>` +
    `<div class="wnm-title">${h(title)}<a class="wnm-ext" href="${h(url)}" target="_blank" rel="noopener">open on Microsoft Build \u2197</a></div>`,
    'session');
}
function openWnModalUpdate(u: WhatsNewUpdate) {
  const sc = wnStatusCls(u.status);
  const cat = whatsNewData?.categories.find((c) => c.id === u.category)?.label || u.category;
  showWnModal(
    `<div class="wnm-up-head">${u.status ? `<span class="wn-up-status ${sc}">${h(u.status)}</span>` : ''}<span class="wnm-up-cat">${h(cat)}</span>${u.date ? `<span class="wnm-up-date">${fmtAgo(u.date)}</span>` : ''}</div>` +
    `<h3 class="wnm-up-title">${h(u.title)}</h3>` +
    (u.products?.length ? `<div class="chip-row">${u.products.map((p) => `<span class="wn-up-prod">${h(p)}</span>`).join('')}</div>` : '') +
    `<div class="wnm-up-desc">${u.description ? h(u.description).replace(/\n/g, '<br/>') : '<span class="muted">No additional detail provided for this update.</span>'}</div>`,
    'update');
}
function openWnUpdateById(id: string) {
  const u = whatsNewData?.updates.find((x) => x.id === id);
  if (u) openWnModalUpdate(u);
}

// ---- Expandable panel detail ("what is this?" box) ------------------------
const PANEL_INFO: Record<string, { title: string; what: string; how?: string; why?: string }> = {
  kpi: { title: 'Spend Overview', what: 'Headline subscription spend, run-rate and tag hygiene for the selected period.', how: 'Aggregated from Azure Cost Management actual usage; 30-day forecast = average daily burn \u00d7 30.', why: 'See total spend, trend vs the previous period and where to focus at a glance.' },
  service: { title: 'Cost by Service', what: 'Spend grouped by Azure service / meter category.', how: 'Cost Management grouped by ServiceName over the period.', why: 'Identify which services drive your bill so you can target the biggest line items.' },
  trend: { title: 'Daily Spend Trend', what: 'Day-by-day spend across the selected period.', how: 'Cost Management at daily granularity.', why: 'Spot spikes, weekend patterns and growth before they compound.' },
  topres: { title: 'Top Resources', what: 'The individual resources costing the most.', how: 'Cost Management grouped by ResourceId, enriched with type / resource group / region.', why: 'Right-sizing or removing the priciest resources gives the fastest savings. Click a row to drill in.' },
  waste: { title: 'Waste & Optimize', what: 'Idle or orphaned resources and the estimated monthly savings from removing them.', how: 'Resource Graph heuristics: unattached disks, idle public IPs, empty App Service plans, stopped VMs, untagged resources.', why: 'Cutting waste reduces cost with no impact on running workloads.' },
  insights: { title: 'AI Insights', what: 'Generated cost and anomaly insights with estimated impact.', how: 'Heuristic analysis of spend level, growth rate and cost concentration.', why: 'Surfaces actionable recommendations without manual digging.' },
  gov: { title: 'Tag Governance', what: 'Tag coverage and the governance tags that are missing.', how: 'Share of resources carrying tags; counts of resources missing owner / cost-center / environment.', why: 'Tags enable chargeback, ownership and policy enforcement \u2014 untagged spend is unaccountable.' },
  regions: { title: 'Regions', what: 'Spend and resource count by Azure region.', how: 'Inventory (Resource Graph) joined with Cost Management grouped by location.', why: 'Understand your geographic footprint, data-residency and cross-region cost. Click a region to drill into its zones.' },
  security: { title: 'Security \u00b7 Defender', what: 'Microsoft Defender for Cloud posture and secure score.', how: 'securityresources assessments summarised by severity & status, plus the subscription secure score.', why: 'Lowering unhealthy findings and raising secure score reduces attack surface.' },
  advisor: { title: 'Advisor Recommendations', what: 'Azure Advisor recommendations grouped by category.', how: 'advisorresources grouped by category (Cost, Security, Reliability, Performance, Operations).', why: 'Official Microsoft guidance for optimizing cost, reliability, security and performance.' },
  resiliency: { title: 'Resiliency \u00b7 Zones', what: 'Availability-zone resilience of your resources.', how: 'Inventory zones property: zone-pinned vs zone-redundant vs regional.', why: 'Resources tied to a single zone can go down if that zone fails.' },
  health: { title: 'Service Health', what: 'Active Azure Service Health events affecting your resources.', how: 'servicehealthresources active events (issues, maintenance, advisories).', why: 'Know about outages and planned maintenance impacting your subscription.' },
  backup: { title: 'Backup \u00b7 BCDR', what: 'Backup / business-continuity coverage.', how: 'recoveryservicesresources protected items and vault count vs the number of VMs.', why: 'Unprotected VMs risk irreversible data loss in an incident.' },
  monitoring: { title: 'Monitoring \u00b7 VM Insights', what: 'VM monitoring (Azure Monitor Agent / VM Insights) coverage.', how: 'VM extensions matching Monitor / OmsAgent / MonitoringAgent counted against total VMs.', why: 'Unmonitored VMs are observability blind spots during incidents.' },
  changes: { title: 'Change Tracking', what: 'Recent resource configuration changes (~14 days).', how: 'resourcechanges from Resource Graph.', why: 'Audit configuration drift and correlate changes with incidents or cost spikes.' },
  deps: { title: 'Dependency Map', what: 'The most-connected resources by dependency edges.', how: 'Resource Graph relationships; degree = number of links to/from a resource.', why: 'High-degree resources are blast-radius hubs \u2014 changes there ripple widely.' },
};

function pmAbout(info: { what: string; how?: string; why?: string }): string {
  return `<div class="pm-about"><div class="pm-what">${h(info.what)}</div>` +
    (info.how ? `<div class="pm-meta"><span class="pm-k">How it\u2019s computed</span><span class="pm-v">${h(info.how)}</span></div>` : '') +
    (info.why ? `<div class="pm-meta"><span class="pm-k">Why it matters</span><span class="pm-v">${h(info.why)}</span></div>` : '') + `</div>`;
}
function pmStats(items: { label: string; value: string; sub?: string }[]): string {
  return `<div class="pm-stats">${items.map((i) => `<div class="pm-stat"><div class="pm-stat-v">${i.value}</div><div class="pm-stat-l">${h(i.label)}</div>${i.sub ? `<div class="pm-stat-s">${h(i.sub)}</div>` : ''}</div>`).join('')}</div>`;
}
function pmTable(headers: string[], rows: string[][]): string {
  if (!rows.length) return '<span class="muted">no data</span>';
  return `<table class="pm-table"><thead><tr>${headers.map((hh) => `<th>${h(hh)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function openPanelDetail(key: string) {
  const info = PANEL_INFO[key];
  const detail = panelData[key] ? panelDetailBody(key) : '<div class="muted" style="padding:14px">Data is still loading \u2014 try again in a moment.</div>';
  showWnModal(`<div class="pm"><div class="pm-titlebar"><h3>${h(info?.title || key)}</h3></div>${info ? pmAbout(info) : ''}<div class="pm-detail">${detail}</div></div>`, 'panel');
  const root = document.getElementById('wnModal');
  if (!root) return;
  root.querySelectorAll('.pm-link[data-open-id]').forEach((el) => el.addEventListener('click', () => { closeWnModal(); openDock((el as HTMLElement).dataset.openId!); }));
  root.querySelectorAll('.pm-link2[data-region]').forEach((el) => el.addEventListener('click', () => { closeWnModal(); focusZones((el as HTMLElement).dataset.region!, (el as HTMLElement).dataset.display!); }));
}

function panelDetailBody(key: string): string {
  if (key === 'kpi') {
    const s = panelData.kpi as SummaryResp; const cur = s.currency;
    return pmStats([
      { label: 'Total spend', value: money(s.totalCost, cur), sub: `${s.days} days` },
      { label: 'Previous period', value: money(s.prevCost, cur), sub: s.deltaPct != null ? `${s.deltaPct >= 0 ? '+' : ''}${s.deltaPct.toFixed(0)}%` : '' },
      { label: 'Daily burn', value: money(s.dailyBurn, cur), sub: 'avg / day' },
      { label: 'Forecast 30d', value: money(s.forecast30, cur), sub: 'run-rate' },
      { label: 'Resources', value: String(s.resourceCount), sub: `${s.regionCount} regions \u00b7 ${s.rgCount} RGs` },
      { label: 'Top service', value: s.topService ? compactMoney(s.topService.cost, cur) : '\u2014', sub: s.topService ? s.topService.name : '' },
      { label: 'Tag coverage', value: `${Math.round(s.taggedPct)}%`, sub: `${s.untaggedCount} untagged` },
    ]);
  }
  if (key === 'service') {
    const d = panelData.service as AnalyticsResp; const cur = d.currency;
    const total = d.byService.reduce((a, x) => a + x.cost, 0);
    return pmTable(['Service', 'Cost', '% of total'], d.byService.map((s) => [h(s.name), `<b>${money(s.cost, cur)}</b>`, `${total ? ((s.cost / total) * 100).toFixed(1) : '0'}%`]));
  }
  if (key === 'trend') {
    const d = panelData.trend as AnalyticsResp; const cur = d.currency;
    const vals = d.trend.map((t) => t.cost); const total = vals.reduce((a, b) => a + b, 0);
    return pmStats([
      { label: 'Total', value: money(total, cur) },
      { label: 'Avg / day', value: money(total / (vals.length || 1), cur) },
      { label: 'Peak day', value: money(Math.max(...vals, 0), cur) },
      { label: 'Days', value: String(d.trend.length) },
    ]) + pmTable(['Date', 'Cost'], d.trend.slice().reverse().map((t) => [h(t.date), `<b>${money(t.cost, cur)}</b>`]));
  }
  if (key === 'topres') {
    const d = panelData.topres as AnalyticsResp; const cur = d.currency;
    return pmTable(['Resource', 'Type', 'Resource group', 'Region', 'Cost'], d.topResources.map((r) => [`<button class="pm-link" data-open-id="${h(r.id)}">${typeIcon(r.type, { tinted: true })}${h(r.name)}</button>`, h(shortType(r.type)), h(r.resourceGroup || ''), h(r.location || ''), `<b>${money(r.cost, cur)}</b>`]));
  }
  if (key === 'waste') {
    const d = panelData.waste as OptimizeResp; const cur = d.currency;
    const all = [...d.findings, d.untagged].filter((f) => f.count > 0);
    const head = pmStats([
      { label: 'Est. monthly savings', value: money(d.estimatedMonthlySavings, cur) },
      { label: 'Findings', value: String(all.length) },
    ]);
    const tbl = pmTable(['Finding', 'Count', 'Monthly cost'], all.map((f) => [h(f.label), String(f.count), `<b>${money(f.monthlyCost, cur)}</b>`]));
    const resLists = d.findings.filter((f) => f.resources?.length && f.count > 0).slice(0, 4).map((f) => `<div class="pm-sub"><h5>${h(f.label)} \u00b7 ${f.count}</h5>${pmTable(['Resource', 'Region', 'Monthly'], f.resources.slice(0, 20).map((r) => [`<button class="pm-link" data-open-id="${h(r.id)}">${h(r.name)}</button>`, h(r.location || ''), money(r.monthlyCost || 0, cur)]))}</div>`).join('');
    return head + tbl + resLists;
  }
  if (key === 'insights') {
    const d = panelData.insights as InsightsResp;
    if (!d.insights.length) return '<span class="muted">no insights</span>';
    return d.insights.map((i) => {
      const imp = typeof i.impact === 'number' && Math.abs(i.impact) >= 0.5 ? `<span class="fimp ${i.impact < 0 ? 'save' : 'rise'}">${i.impact < 0 ? '\u2193' : '\u2191'}${compactMoney(Math.abs(i.impact), d.currency)}</span>` : '';
      return `<div class="pm-insight"><div class="pm-insight-h"><span class="fdot ${i.severity === 'warn' ? 'sev-med' : 'sev-low'}"></span><b>${h(i.title)}</b>${imp}</div><div class="pm-insight-d">${h(i.detail)}</div></div>`;
    }).join('');
  }
  if (key === 'gov') {
    const g = (panelData.gov as OptimizeResp).governance;
    return pmStats([
      { label: 'Tagged', value: `${Math.round(g.taggedPct)}%`, sub: `${g.tagged}/${g.total}` },
      { label: 'Missing owner', value: String(g.missingOwner) },
      { label: 'Missing cost-center', value: String(g.missingCostCenter) },
      { label: 'Missing environment', value: String(g.missingEnv) },
    ]);
  }
  if (key === 'regions') {
    const pd = panelData.regions as { regions: RegionAgg[]; unassigned: number; currency: string };
    const cur = pd.currency; const total = pd.regions.reduce((s, r) => s + r.cost, 0) + pd.unassigned;
    const rows = pd.regions.slice().sort((a, b) => b.cost - a.cost).map((r) => [`<button class="pm-link2" data-region="${h(r.region)}" data-display="${h(r.display)}">${flagImg(r.region)}${h(r.display)}</button>`, String(r.count), `<b>${money(r.cost, cur)}</b>`, `${total ? ((r.cost / total) * 100).toFixed(1) : '0'}%`]);
    if (pd.unassigned > 0.005) rows.push(['<span class="muted">(unassigned / shared)</span>', '', `<b>${money(pd.unassigned, cur)}</b>`, `${total ? ((pd.unassigned / total) * 100).toFixed(1) : '0'}%`]);
    return pmTable(['Region', 'Resources', 'Cost', '% of total'], rows);
  }
  if (key === 'security') {
    const p = panelData.security as PostureResp; const sec = p.security || []; const sc = p.secureScore;
    const head = sc ? pmStats([{ label: 'Secure score', value: `${Math.round(sc.pct ?? (sc.max ? (sc.current / sc.max) * 100 : 0))}%`, sub: `${sc.current}/${sc.max}` }]) : '';
    const rows = sec.filter((x) => x.count > 0).sort((a, b) => b.count - a.count).map((x) => [h(x.severity), `<span class="f-status ${x.status === 'Healthy' ? 'ok' : 'bad'}">${h(x.status)}</span>`, String(x.count)]);
    return head + pmTable(['Severity', 'Status', 'Count'], rows) + (sec.length ? '' : '<div class="pm-note">Defender for Cloud is not enabled or has no assessments for this subscription.</div>');
  }
  if (key === 'advisor') {
    const adv = (panelData.advisor as PostureResp).advisor || [];
    const byCat = new Map<string, number>(); for (const a of adv) byCat.set(a.category, (byCat.get(a.category) || 0) + a.count);
    const total = adv.reduce((s, a) => s + a.count, 0);
    const rows = [...byCat.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => [h(c.replace('HighAvailability', 'Reliability').replace('OperationalExcellence', 'Operations')), String(n), `${total ? ((n / total) * 100).toFixed(0) : '0'}%`]);
    return pmStats([{ label: 'Total recommendations', value: String(total) }]) + pmTable(['Category', 'Count', 'Share'], rows);
  }
  if (key === 'resiliency') {
    const r = (panelData.resiliency as PostureResp).resiliency;
    const pinnedPct = r.total ? Math.round((r.zonePinned / r.total) * 100) : 0;
    return pmStats([
      { label: 'Zone-pinned', value: `${pinnedPct}%`, sub: `${r.zonePinned}/${r.total}` },
      { label: 'Zone-redundant', value: String(r.zoneRedundant) },
      { label: 'Single-zone / regional', value: String(r.total - r.zonePinned) },
    ]) + '<div class="pm-note">Zone-pinned resources are anchored to a specific availability zone; zone-redundant resources replicate across zones. Resources that are neither carry single-zone outage risk.</div>';
  }
  if (key === 'health') {
    const ev = (panelData.svcHealth as ServiceHealthResp | undefined)?.events || [];
    if (!ev.length) return '<div class="pm-note" style="color:var(--green)">All systems operational \u2014 no active Service Health events.</div>';
    return pmTable(['Event', 'Type', 'Impacted regions', 'Services'], ev.map((e) => [h(e.title), h(e.eventType), h((e.regions || []).slice(0, 4).join(', ') || 'non-regional'), h((e.services || []).join(', '))]));
  }
  if (key === 'backup') {
    const o = panelData.backup as OpsResp; const b = o.backup || { protectedItems: 0, vaults: 0 };
    const cov = o.vmCount ? Math.round(Math.min(100, (b.protectedItems / o.vmCount) * 100)) : 0;
    return pmStats([
      { label: 'Protected items', value: String(b.protectedItems) },
      { label: 'Recovery vaults', value: String(b.vaults) },
      { label: 'VMs in subscription', value: String(o.vmCount) },
      { label: 'Est. VM coverage', value: `${cov}%` },
    ]) + (b.protectedItems === 0 && o.vmCount > 0 ? '<div class="pm-note" style="color:var(--high)">No backup-protected items found \u2014 VMs are unprotected. Enable Azure Backup.</div>' : '');
  }
  if (key === 'monitoring') {
    const o = panelData.monitoring as OpsResp; const mon = o.vmCount ? Math.round((o.monitoredVms / o.vmCount) * 100) : 0;
    return pmStats([
      { label: 'Monitored VMs', value: String(o.monitoredVms) },
      { label: 'Unmonitored VMs', value: String(Math.max(0, o.vmCount - o.monitoredVms)) },
      { label: 'Total VMs', value: String(o.vmCount) },
      { label: 'Coverage', value: `${mon}%` },
    ]) + (mon < 50 && o.vmCount > 0 ? '<div class="pm-note" style="color:var(--high)">Low VM Insights / agent coverage \u2014 deploy Azure Monitor Agent.</div>' : '');
  }
  if (key === 'changes') {
    const ch = (panelData.changes as OpsResp).changes || [];
    if (!ch.length) return '<span class="muted">no recent changes</span>';
    return pmTable(['Resource', 'Change', 'When'], ch.map((c) => [`<button class="pm-link" data-open-id="${h(c.target)}">${h(resName(c.target))}</button>`, h(c.changeType || 'Update'), fmtAgo(c.ts)]));
  }
  if (key === 'deps') {
    const pd = panelData.deps as { count: number; degSize: number; top: { id: string; name: string; type: string; degree: number }[] };
    return pmStats([{ label: 'Dependencies', value: String(pd.count) }, { label: 'Connected resources', value: String(pd.degSize) }]) +
      pmTable(['Resource', 'Type', 'Links'], pd.top.map((t) => [`<button class="pm-link" data-open-id="${h(t.id)}">${typeIcon(t.type, { tinted: true })}${h(t.name)}</button>`, h(shortType(t.type)), String(t.degree)]));
  }
  return '<span class="muted">No detail available.</span>';
}

function trendSvg(series: { date: string; cost: number }[], cur: string): string {
  if (!series.length) return '<span class="muted">no daily data</span>';
  const w = 600, ht = 90, pad = 4, n = series.length;
  const max = Math.max(...series.map((s) => s.cost), 0.0001);
  const x = (i: number) => (i / (n - 1 || 1)) * (w - 2 * pad) + pad;
  const y = (v: number) => ht - pad - (v / max) * (ht - 2 * pad - 6);
  const line = series.map((s, i) => `${x(i).toFixed(1)},${y(s.cost).toFixed(1)}`).join(' ');
  const area = `${pad},${ht - pad} ${line} ${(w - pad).toFixed(1)},${ht - pad}`;
  return `<svg class="trend-svg" viewBox="0 0 ${w} ${ht}" preserveAspectRatio="none"><polygon points="${area}" fill="rgba(68,255,136,.12)"/><polyline points="${line}" fill="none" stroke="#44ff88" stroke-width="1.5"/></svg>` +
    `<div class="small muted">${series[0].date} \u2192 ${series[n - 1].date} \u00b7 peak ${money(max, cur)}/day</div>`;
}

// ---- Linkage --------------------------------------------------------------
async function ensureLinkage() {
  const sub = state.subscriptionId!;
  if (linkageLoaded === sub) return;
  try {
    const [inv, link] = await Promise.all([api.inventory(sub), api.linkage(sub)]);
    const byId = new Map(inv.resources.map((r) => [r.id.toLowerCase(), r]));
    const coord = new Map<string, [number, number]>();
    for (const r of regionData) if (r.lat != null && r.lon != null) coord.set(r.region, [r.lon, r.lat]);
    const counts = new Map<string, number>();
    for (const e of link.edges) {
      const ra = byId.get(e.from.toLowerCase())?.location, rb = byId.get(e.to.toLowerCase())?.location;
      if (ra && rb && ra !== rb && coord.has(ra) && coord.has(rb)) { const k = [ra, rb].sort().join('|'); counts.set(k, (counts.get(k) || 0) + 1); }
    }
    const arcs: RegionArc[] = [];
    for (const [k, c] of counts) { const [a, b] = k.split('|'); arcs.push({ from: coord.get(a)!, to: coord.get(b)!, count: c }); }
    map.setArcs(arcs);
    linkageLoaded = sub;
  } catch { /* ignore */ }
}

// ---- Availability-zone drill-in (on the map) -----------------------------
let zoneRegion: string | null = null;
let allSubs: { subscriptionId: string; displayName: string }[] = [];
let focusedZones: RegionZonesResp | null = null;
let focusedDisplay = '';

async function focusZones(region: string, display: string) {
  zoneRegion = region; focusedDisplay = display; focusedZones = null;
  const r = regionData.find((x) => x.region === region);
  if (!r) { closeZoneView(); return; }
  map.focusRegion(r, null);
  showFocusBar(display, null);
  const host = $('zoneView'); host.classList.remove('hidden');
  host.innerHTML = `<div class="az-head"><button class="hbtn" id="zoneClose">\u2715</button><div class="az-head-main">${flagImg(region, { w: 24 })}<div><div class="zone-title">${h(display)}</div><div class="zone-sub muted">loading availability zones\u2026</div></div></div></div>`;
  $('zoneClose').addEventListener('click', exitFocus);
  try {
    const subIds = allSubs.length ? allSubs.map((s) => s.subscriptionId) : [state.subscriptionId!];
    const z = await api.regionZones(subIds, region, state.range);
    if (zoneRegion !== region) return;
    focusedZones = z;
    const counts: Record<string, number> = {};
    for (const b of z.zones) counts[b.zone] = b.count;
    map.setZoneCounts(counts);
    showFocusBar(display, z);
    renderZoneOverview();
  } catch {
    if (zoneRegion === region) host.querySelector('.zone-sub')!.textContent = 'zone data unavailable';
  }
}

const ZONE_META: { zone: string; label: string; cls: string; color: string }[] = [
  { zone: '1', label: 'Zone 1', cls: 'z1', color: '#4cc2ff' },
  { zone: '2', label: 'Zone 2', cls: 'z2', color: '#6ad7a0' },
  { zone: '3', label: 'Zone 3', cls: 'z3', color: '#c08be8' },
  { zone: 'none', label: 'Regional', cls: 'reg', color: '#96a4b8' },
];
const DC_RACK = '<svg class="azc-rack" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="3" width="16" height="6" rx="1"/><rect x="4" y="11" width="16" height="6" rx="1"/><rect x="4" y="19" width="16" height="3" rx="1"/><circle cx="7" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="7" cy="14" r="1" fill="currentColor" stroke="none"/></svg>';

// Beautiful availability-zone topology overview for the focused region.
function renderZoneOverview() {
  const z = focusedZones; if (!z) return;
  const cur = z.currency;
  const byZone = new Map(z.zones.map((b) => [b.zone, b]));
  const maxCount = Math.max(1, ...z.zones.map((b) => b.count));
  const zoned = z.zones.filter((b) => b.zone !== 'none').reduce((s, b) => s + b.count, 0);
  const regional = byZone.get('none')?.count || 0;
  const zr = z.zones.reduce((s, b) => s + b.resources.filter((r) => r.zoneRedundant).length, 0);
  const resilPct = z.count ? Math.round((zoned / z.count) * 100) : 0;
  const zonesAvail = z.zones.filter((b) => b.zone !== 'none').length;
  const cards = ZONE_META.map((m) => {
    const b = byZone.get(m.zone);
    const count = b?.count || 0; const cost = b?.cost || 0;
    const zrc = b ? b.resources.filter((r) => r.zoneRedundant).length : 0;
    const w = Math.max(3, (count / maxCount) * 100);
    return `<button class="azc azc-${m.cls}" data-zone="${m.zone}"${count ? '' : ' disabled'}>` +
      `<div class="azc-top"><span class="azc-badge">${m.label.toUpperCase()}</span><span class="azc-dc">${DC_RACK}</span></div>` +
      `<div class="azc-count">${count}<span class="azc-cl">res</span></div>` +
      `<div class="azc-cost">${money(cost, cur)}</div>` +
      `<div class="azc-bar"><div class="azc-fill" style="width:${w.toFixed(0)}%"></div></div>` +
      (zrc ? `<div class="azc-zr"><span class="zr-badge">ZR</span>${zrc} zone-redundant</div>` : '<div class="azc-zr muted">no zone-redundancy</div>') +
      `</button>`;
  }).join('');
  const host = $('zoneView'); host.classList.remove('hidden');
  host.innerHTML =
    `<div class="az-head"><button class="hbtn" id="zoneClose">\u2715</button><div class="az-head-main">${flagImg(z.region, { w: 26 })}<div><div class="zone-title">${h(z.display)}</div><div class="zone-sub">${z.count} resources \u00b7 ${money(z.total, cur)} \u00b7 ${zonesAvail || 'no'} zone${zonesAvail === 1 ? '' : 's'} in use</div></div></div></div>` +
    `<div class="az-resil"><div class="az-resil-top"><span class="az-resil-k">Zone resilience</span><span class="${resilPct > 0 ? 'fb-ok' : 'fb-warn'}">${resilPct}% zone-pinned</span></div><div class="az-resil-bar"><div class="az-resil-fill" style="width:${resilPct}%"></div></div><div class="az-resil-sub">${zoned} zone-pinned \u00b7 ${regional} regional \u00b7 ${zr} zone-redundant</div></div>` +
    azTopologySvg(byZone, maxCount) +
    `<div class="az-zones">${cards}</div>` +
    `<div class="az-hint">Click a zone card above to list its resources.</div>`;
  $('zoneClose').addEventListener('click', exitFocus);
  host.querySelectorAll('.azc:not([disabled])').forEach((el) => el.addEventListener('click', () => openZoneResources((el as HTMLElement).dataset.zone!)));
}

function azTopologySvg(byZone: Map<string, RegionZonesResp['zones'][number]>, maxCount: number): string {
  const hubX = 44, hubY = 80, nodeX = 232;
  const ys: Record<string, number> = { '1': 24, '2': 61, '3': 98, none: 135 };
  const spokes = ZONE_META.map((m) => `<path d="M${hubX} ${hubY} C ${hubX + 70} ${hubY}, ${nodeX - 70} ${ys[m.zone]}, ${nodeX} ${ys[m.zone]}" stroke="${m.color}" stroke-width="1.4" fill="none" opacity="0.45"/>`).join('');
  const nodes = ZONE_META.map((m) => {
    const c = byZone.get(m.zone)?.count || 0;
    const r = 9 + Math.min(13, (c / maxCount) * 13);
    const dim = c ? '' : ' opacity="0.4"';
    return `<g${dim}><circle cx="${nodeX}" cy="${ys[m.zone]}" r="${r}" fill="${m.color}22" stroke="${m.color}" stroke-width="1.8"/>` +
      `<text x="${nodeX}" y="${ys[m.zone] + 4}" text-anchor="middle" class="azt-c">${c}</text>` +
      `<text x="${nodeX + r + 8}" y="${ys[m.zone] + 4}" class="azt-l" fill="${m.color}">${m.zone === 'none' ? 'REGIONAL' : 'ZONE ' + m.zone}</text></g>`;
  }).join('');
  return `<svg class="az-topo" viewBox="0 0 320 160" preserveAspectRatio="xMidYMid meet">${spokes}` +
    `<circle cx="${hubX}" cy="${hubY}" r="22" fill="#0c1714" stroke="var(--green)" stroke-width="1.8"/>` +
    `<text x="${hubX}" y="${hubY - 1}" text-anchor="middle" class="azt-hub">REGION</text>` +
    `<text x="${hubX}" y="${hubY + 11}" text-anchor="middle" class="azt-hub2">datacenters</text>${nodes}</svg>`;
}

function showFocusBar(display: string, z: RegionZonesResp | null) {
  const bar = $('focusBar'); bar.classList.remove('hidden');
  let note = '';
  if (z) {
    const zoned = z.zones.filter((b) => b.zone !== 'none').reduce((s, b) => s + b.count, 0);
    note = zoned === 0
      ? `<span class="fb-warn">\u26a0 0 of ${z.count} zone-pinned \u00b7 single-zone risk</span>`
      : `<span class="fb-ok">${zoned} of ${z.count} zone-pinned</span>`;
  }
  bar.innerHTML = `<button class="hbtn" id="focusBack">\u2190 World</button>` +
    `<span class="fb-title">${flagImg(zoneRegion || '', { w: 18 })}${h(display)} \u00b7 Availability Zones</span>` +
    `<span class="fb-hint">availability zones \u2192</span>${note}`;
  $('focusBack').addEventListener('click', exitFocus);
}

function exitFocus() {
  zoneRegion = null; focusedZones = null;
  if (map?.isFocused?.()) map.clearFocus();
  const bar = document.getElementById('focusBar'); if (bar) { bar.classList.add('hidden'); bar.innerHTML = ''; }
  closeZoneView();
}

function closeZoneView() { const v = document.getElementById('zoneView'); if (v) { v.classList.add('hidden'); v.innerHTML = ''; } }

// Drill into one zone — slide-over list with inline search + type filter so a
// region with thousands of resources stays navigable.
const zoneResFilter = { text: '', type: '', sub: '', tag: '' };
type ZRes = RegionZonesResp['zones'][number]['resources'][number];
function tagKv(r: ZRes): string { return r.tags ? Object.entries(r.tags).map(([k, v]) => `${k}=${v}`).join(' ') : ''; }
// ---- CSV / Excel export ---------------------------------------------------
function csvCell(v: unknown): string { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
// ============================================================================
//  FinOps Pro \u2014 cost allocation / showback, scorecard, budget & exports
// ============================================================================

// ---- Cost Allocation (showback by tag / resource group / region) -----------
let allocDim = 'auto';
function allocTagKeys(): { key: string; count: number }[] {
  const m = new Map<string, number>();
  for (const r of invById.values()) for (const k of Object.keys(r.tags || {})) { const lk = k.toLowerCase(); m.set(lk, (m.get(lk) || 0) + 1); }
  return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}
function resolveAllocDim(): string {
  if (allocDim !== 'auto') return allocDim;
  const keys = allocTagKeys();
  for (const p of ['environment', 'env', 'costcenter', 'cost-center', 'cost_center', 'application', 'app', 'owner', 'team', 'project', 'department', 'service', 'workload']) {
    const f = keys.find((k) => k.key === p); if (f) return 'tag:' + f.key;
  }
  return keys.length ? 'tag:' + keys[0].key : 'rg';
}
function allocValueOf(r: InventoryResource, dim: string): string | null {
  if (dim === 'rg') return r.resourceGroup || null;
  if (dim === 'location') return r.location || null;
  if (dim.startsWith('tag:')) {
    const tk = dim.slice(4); const tags = r.tags || {};
    const found = Object.keys(tags).find((k) => k.toLowerCase() === tk);
    const v = found ? tags[found] : null;
    return v && String(v).trim() ? String(v) : null;
  }
  return null;
}
interface AllocResult { rows: { key: string; cost: number; count: number }[]; total: number; alloc: number; unalloc: { cost: number; count: number }; }
function costByDimension(dim: string): AllocResult {
  const costMap = lastAnalytics?.costById || {};
  const active = filterActive();
  const groups = new Map<string, { cost: number; count: number }>();
  let total = 0, unCost = 0, unCount = 0;
  for (const r of invById.values()) {
    if (active && !matchesFilter(r.name, r.type, r.resourceGroup)) continue;
    const c = costMap[r.id.toLowerCase()] || 0;
    total += c;
    const val = allocValueOf(r, dim);
    if (val == null) { unCost += c; unCount++; }
    else { const g = groups.get(val) || { cost: 0, count: 0 }; g.cost += c; g.count++; groups.set(val, g); }
  }
  const rows = [...groups.entries()].map(([key, v]) => ({ key, cost: v.cost, count: v.count })).sort((a, b) => b.cost - a.cost);
  return { rows, total, alloc: total - unCost, unalloc: { cost: unCost, count: unCount } };
}
function renderAlloc() {
  const body = document.getElementById('body-alloc'); if (!body) return;
  if (!invById.size) { body.innerHTML = '<span class="muted">\u2026</span>'; return; }
  const cur = state.currency;
  const dim = resolveAllocDim();
  const keys = allocTagKeys();
  const opts = [
    ...keys.slice(0, 16).map((k) => `<option value="tag:${h(k.key)}" ${dim === 'tag:' + k.key ? 'selected' : ''}>Tag: ${h(k.key)} (${k.count})</option>`),
    `<option value="rg" ${dim === 'rg' ? 'selected' : ''}>Resource group</option>`,
    `<option value="location" ${dim === 'location' ? 'selected' : ''}>Region / location</option>`,
  ].join('');
  const res = costByDimension(dim);
  const denom = Math.max(res.total, 0.0001);
  const max = Math.max(res.rows[0]?.cost || 0, res.unalloc.cost, 0.0001);
  const dimLabel = dim.startsWith('tag:') ? dim.slice(4) : dim === 'rg' ? 'resource group' : 'location';
  const bar = (key: string, label: string, cost: number, count: number, faded = false) =>
    `<button class="hrow clk-alloc" data-key="${h(key)}" title="Drill into ${h(label)} \u2192"><div class="hb-top"><span class="hb-name${faded ? ' muted' : ''}">${h(label)} \u00b7 ${count}</span><span class="hb-val">${money(cost, cur)} \u00b7 ${((cost / denom) * 100).toFixed(0)}%</span></div><div class="hb-track"><div class="hb-fill" style="width:${Math.max(2, (cost / max) * 100).toFixed(1)}%${faded ? ';opacity:.45' : ''}"></div></div></button>`;
  const bars = res.rows.slice(0, 9).map((r) => bar(r.key, r.key, r.cost, r.count)).join('');
  const unalloc = res.unalloc.count ? bar('', '(unallocated)', res.unalloc.cost, res.unalloc.count, true) : '';
  const allocPct = res.total ? (res.alloc / res.total) * 100 : 0;
  body.innerHTML = `<div class="alloc-head"><span class="alloc-by">Allocate by</span><select id="allocDimSel" class="ff-sel">${opts}</select><span class="alloc-cov ${allocPct < 50 ? 'warn' : ''}">${allocPct.toFixed(0)}% allocated</span></div>` +
    `<div class="alloc-bars">${bars || '<span class="muted">no cost to allocate</span>'}${unalloc}</div>` +
    `<div class="alloc-note">Showback by <b>${h(dimLabel)}</b> \u00b7 click a row to drill into its resources</div>`;
  setCount('alloc', res.rows.length);
  setSev('alloc', allocPct < 50 ? 'high' : 'normal');
  (document.getElementById('allocDimSel') as HTMLSelectElement | null)?.addEventListener('change', (e) => { allocDim = (e.target as HTMLSelectElement).value; renderAlloc(); });
  body.querySelectorAll('.clk-alloc').forEach((b) => b.addEventListener('click', () => {
    const key = (b as HTMLElement).dataset.key || '';
    const label = key || '(unallocated)';
    openResourceDrill(`${dimLabel}: ${label}`, `cost allocated to ${label}`, invDrill((r) => {
      if (filterActive() && !matchesFilter(r.name, r.type, r.resourceGroup)) return false;
      const v = allocValueOf(r, dim); return key ? v === key : v == null;
    }));
  }));
}

// ---- Budget (client-side monthly target, stored per subscription) ----------
function budgetKey(): string { return `finops-budget:${state.subscriptionId || 'default'}`; }
function getBudget(): number | null { const v = localStorage.getItem(budgetKey()); const n = v ? Number(v) : NaN; return Number.isFinite(n) && n > 0 ? n : null; }
function promptBudget() {
  const cur = getBudget();
  const ans = window.prompt(`Set a monthly budget target in ${state.currency || 'USD'} (blank to clear):`, cur ? String(cur) : '');
  if (ans == null) return;
  const n = Number(ans.replace(/[^0-9.]/g, ''));
  if (ans.trim() === '' || !(n > 0)) localStorage.removeItem(budgetKey()); else localStorage.setItem(budgetKey(), String(n));
  renderFinKpi();
}

// ---- Untagged spend (real cost of resources carrying no tags) --------------
function untaggedSpend(): { cost: number; count: number; total: number } {
  const costMap = lastAnalytics?.costById || {};
  let cost = 0, count = 0, total = 0;
  for (const r of invById.values()) {
    const c = costMap[r.id.toLowerCase()] || 0; total += c;
    if (!r.tags || !Object.keys(r.tags).length) { cost += c; count++; }
  }
  return { cost, count, total };
}

// ---- FinOps Scorecard: savings rate, untagged spend, budget, concentration -
function renderFinKpi() {
  const body = document.getElementById('body-finkpi'); if (!body) return;
  const s = panelData.kpi as SummaryResp | undefined;
  const opt = panelData.waste as OptimizeResp | undefined;
  const cur = s?.currency || state.currency;
  if (!s && !invById.size) { body.innerHTML = '<span class="muted">\u2026</span>'; return; }
  const runRate = s ? (s.forecast30 || s.dailyBurn * 30) : 0;
  const savings = opt?.estimatedMonthlySavings || 0;
  const wastePct = runRate ? Math.min(100, (savings / runRate) * 100) : 0;
  const ut = untaggedSpend();
  const untagPct = ut.total ? (ut.cost / ut.total) * 100 : 0;
  const svc = (lastAnalytics?.byService || []).slice().sort((a, b) => b.cost - a.cost);
  const svcTotal = svc.reduce((a, x) => a + x.cost, 0);
  const conc = svcTotal ? (svc.slice(0, 5).reduce((a, x) => a + x.cost, 0) / svcTotal) * 100 : 0;
  const mom = s?.deltaPct;
  const budget = getBudget();
  const haveCost = !!lastAnalytics;
  let budgetHtml: string;
  if (budget) {
    const pct = (runRate / budget) * 100;
    const over = runRate > budget;
    budgetHtml = `<div class="fb-budget"><div class="fb-budget-top"><span>Projected monthly run-rate vs budget</span><button class="fb-setbtn" id="finBudgetSet">edit</button></div>` +
      `<div class="fb-bar"><div class="fb-bar-fill ${over ? 'over' : ''}" style="width:${Math.min(100, pct).toFixed(1)}%"></div></div>` +
      `<div class="fb-budget-foot"><span><b>${compactMoney(runRate, cur)}</b> projected</span><span class="${over ? 'up' : 'down'}">${over ? '\u25b2 over by ' : '\u25bc under by '}${compactMoney(Math.abs(runRate - budget), cur)}</span><span>budget <b>${compactMoney(budget, cur)}</b></span></div></div>`;
  } else {
    budgetHtml = `<div class="fb-budget fb-budget-empty"><span>Projected monthly run-rate <b>${compactMoney(runRate, cur)}</b></span><button class="fb-setbtn" id="finBudgetSet">set a budget target \u2192</button></div>`;
  }
  const cards = [
    { l: 'Effective savings rate', v: opt ? `${wastePct.toFixed(0)}%` : '\u2014', s: opt ? `${compactMoney(savings, cur)}/mo waste` : 'loading\u2026', k: 'waste', warn: wastePct >= 10 },
    { l: 'Untagged spend', v: haveCost ? `${untagPct.toFixed(0)}%` : '\u2014', s: haveCost ? `${compactMoney(ut.cost, cur)} \u00b7 ${ut.count} res` : `${ut.count} res`, k: 'untagged', warn: untagPct >= 20 },
    { l: 'Cost concentration', v: (haveCost && svcTotal) ? `${conc.toFixed(0)}%` : '\u2014', s: 'top 5 services', k: 'conc', warn: false },
    { l: 'Period change', v: mom != null ? `${mom >= 0 ? '+' : ''}${mom.toFixed(0)}%` : '\u2014', s: 'vs prior period', k: 'mom', warn: (mom || 0) >= 25 },
  ];
  body.innerHTML = budgetHtml + `<div class="kpis fin-kpis">${cards.map((c) => `<button class="kpi ${c.warn ? 'kpi-warn' : ''}" data-fk="${c.k}" title="Drill \u2192"><div class="kpi-l">${c.l}</div><div class="kpi-v">${c.v}</div><div class="kpi-s">${h(c.s)}</div></button>`).join('')}</div>`;
  setCount('finkpi', `${wastePct.toFixed(0)}% waste`);
  setSev('finkpi', wastePct >= 15 || untagPct >= 30 ? 'high' : 'normal');
  document.getElementById('finBudgetSet')?.addEventListener('click', promptBudget);
  body.querySelectorAll('.kpi[data-fk]').forEach((b) => b.addEventListener('click', () => {
    const k = (b as HTMLElement).dataset.fk;
    if (k === 'waste') openResourceDrill('Waste & savings', `${compactMoney(savings, cur)}/mo potential savings`, [...(opt?.findings || []), ...(opt?.untagged ? [opt.untagged] : [])].flatMap((x) => (x.resources || []).map((r) => ({ id: r.id, name: r.name, type: r.type, resourceGroup: r.resourceGroup, location: r.location, cost: r.monthlyCost }))));
    else if (k === 'untagged') openResourceDrill('Untagged spend', `${compactMoney(ut.cost, cur)} across ${ut.count} resources`, invDrill((r) => !r.tags || !Object.keys(r.tags).length));
    else if (k === 'conc' && svc[0]) openServiceDrill(svc[0].name);
    else if (k === 'mom') openResourceDrill('Spend by resource', 'top resources by cost', invDrill());
  }));
}

// ============================================================================
//  Additional FinOps charts — all computed from the live cost + inventory data
//  already loaded: Spend Forecast, Cost Concentration (Pareto), Inventory
//  Composition, Weekly Spend Pattern, Spend Anomalies.
// ============================================================================

// Cumulative spend to date + a 30-day run-rate projection, against the budget.
function renderForecast() {
  const body = document.getElementById('body-forecast'); if (!body) return;
  const a = lastAnalytics; if (!a) { body.innerHTML = '<span class="muted">\u2026</span>'; return; }
  const cur = a.currency || state.currency;
  const trend = a.trend || [];
  if (trend.length < 2) { body.innerHTML = '<div class="chart-empty">Select a 7d+ period to project spend.</div>'; setCount('forecast', '\u2014'); return; }
  const s = panelData.kpi as SummaryResp | undefined;
  const dailyBurn = (s?.dailyBurn && s.dailyBurn > 0) ? s.dailyBurn : trend.reduce((x, p) => x + p.cost, 0) / trend.length;
  const budget = getBudget();
  const cum: number[] = []; let run = 0;
  for (const p of trend) { run += p.cost; cum.push(run); }
  const N = trend.length, FWD = 30, H = N + FWD;
  const spent = cum[N - 1];
  const next30 = dailyBurn * FWD;
  const projEnd = spent + next30;
  const yMax = Math.max(projEnd, budget || 0, 0.0001);
  const W = 600, ht = 148, padL = 4, padR = 4, padT = 10, padB = 14;
  const X = (i: number) => padL + (i / (H - 1 || 1)) * (W - padL - padR);
  const Y = (v: number) => padT + (1 - v / yMax) * (ht - padT - padB);
  const actPts = cum.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  const actArea = `${X(0).toFixed(1)},${(ht - padB).toFixed(1)} ${actPts} ${X(N - 1).toFixed(1)},${(ht - padB).toFixed(1)}`;
  const projPts = `${X(N - 1).toFixed(1)},${Y(spent).toFixed(1)} ${X(H - 1).toFixed(1)},${Y(projEnd).toFixed(1)}`;
  const over = budget != null && next30 > budget;
  const budgetLine = budget ? `<line x1="${padL}" y1="${Y(budget).toFixed(1)}" x2="${W - padR}" y2="${Y(budget).toFixed(1)}" stroke="#ff8800" stroke-width="1" stroke-dasharray="4 3"/><text x="${W - padR}" y="${(Y(budget) - 3).toFixed(1)}" text-anchor="end" class="ext-ax">budget ${compactMoney(budget, cur)}</text>` : '';
  const svg = `<svg class="ext-svg" viewBox="0 0 ${W} ${ht}" preserveAspectRatio="none">` +
    `<polygon points="${actArea}" fill="rgba(68,255,136,.13)"/>` +
    budgetLine +
    `<polyline points="${actPts}" fill="none" stroke="#44ff88" stroke-width="1.6"/>` +
    `<polyline points="${projPts}" fill="none" stroke="#3bd6ff" stroke-width="1.5" stroke-dasharray="5 3"/>` +
    `<circle cx="${X(H - 1).toFixed(1)}" cy="${Y(projEnd).toFixed(1)}" r="2.6" fill="#3bd6ff"/></svg>`;
  const chips = `<div class="mstats ext-chips">` +
    `<span class="mstat"><i>spent ${N}d</i>${compactMoney(spent, cur)}</span>` +
    `<span class="mstat"><i>burn / day</i>${compactMoney(dailyBurn, cur)}</span>` +
    `<span class="mstat"><i>next 30d</i>${compactMoney(next30, cur)}</span>` +
    (budget ? `<span class="mstat"><i>vs budget</i><b class="${over ? 'up' : 'down'}">${over ? '\u25b2' : '\u25bc'} ${compactMoney(Math.abs(next30 - budget), cur)}</b></span>` : `<span class="mstat"><i>budget</i><button class="fb-setbtn" id="fcBudget">+ set</button></span>`) +
    `</div>`;
  body.innerHTML = svg + chips;
  setCount('forecast', compactMoney(next30, cur));
  setSev('forecast', over ? 'high' : 'normal');
  document.getElementById('fcBudget')?.addEventListener('click', promptBudget);
  body.querySelector('.ext-svg')?.addEventListener('click', () => openResourceDrill('Spend by resource', `${compactMoney(spent, cur)} spent \u00b7 ${compactMoney(next30, cur)} projected next 30d`, invDrill()));
}

// Cost concentration (Pareto): top resources as bars + cumulative-% line, so you
// can see how few resources drive most of the bill (the 80/20).
function renderPareto() {
  const body = document.getElementById('body-pareto'); if (!body) return;
  const a = lastAnalytics; if (!a) { body.innerHTML = '<span class="muted">\u2026</span>'; return; }
  const cur = a.currency || state.currency;
  const agg = filterActive() ? filteredAgg() : null;
  const costsDesc = (agg ? agg.resources.map((r) => r.cost) : Object.values(a.costById || {})).filter((v) => v > 0).sort((x, y) => y - x);
  const grand = costsDesc.reduce((sx, v) => sx + v, 0);
  if (!grand) { body.innerHTML = '<div class="chart-empty">No billed resources in this scope.</div>'; setCount('pareto', '0'); return; }
  let acc = 0, k80 = costsDesc.length;
  for (let i = 0; i < costsDesc.length; i++) { acc += costsDesc[i]; if (acc >= grand * 0.8) { k80 = i + 1; break; } }
  const named = (agg ? agg.resources : a.topResources).filter((r) => r.cost > 0).slice(0, 12);
  const n = named.length;
  const W = 600, ht = 140, padL = 4, padR = 4, padT = 10, padB = 14;
  const maxCost = Math.max(...named.map((r) => r.cost), 0.0001);
  const bw = (W - padL - padR) / (n || 1);
  const barW = Math.min(34, bw * 0.62);
  const yC = (v: number) => ht - padB - (v / maxCost) * (ht - padT - padB);
  const yP = (p: number) => padT + (1 - p / 100) * (ht - padT - padB);
  let bars = ''; const cumPts: string[] = []; let c2 = 0;
  named.forEach((r, i) => {
    c2 += r.cost; const cx = padL + bw * i + bw / 2; const by = yC(r.cost);
    bars += `<rect class="pareto-bar" data-id="${h(r.id)}" x="${(cx - barW / 2).toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, ht - padB - by).toFixed(1)}" rx="1"><title>${h(r.name)}: ${money(r.cost, cur)} (${((r.cost / grand) * 100).toFixed(1)}%)</title></rect>`;
    cumPts.push(`${cx.toFixed(1)},${yP((c2 / grand) * 100).toFixed(1)}`);
  });
  const l80 = `<line x1="${padL}" y1="${yP(80).toFixed(1)}" x2="${W - padR}" y2="${yP(80).toFixed(1)}" stroke="rgba(255,170,0,.55)" stroke-width="1" stroke-dasharray="4 3"/><text x="${padL + 3}" y="${(yP(80) - 3).toFixed(1)}" class="ext-ax">80%</text>`;
  const dots = cumPts.map((p) => { const [cx, cy] = p.split(','); return `<circle cx="${cx}" cy="${cy}" r="2" fill="#3bd6ff"/>`; }).join('');
  body.innerHTML = `<svg class="ext-svg pareto-svg" viewBox="0 0 ${W} ${ht}">${l80}${bars}<polyline points="${cumPts.join(' ')}" fill="none" stroke="#3bd6ff" stroke-width="1.5"/>${dots}</svg>` +
    `<div class="small muted ext-note"><b>${k80}</b> of ${costsDesc.length} resources drive <b>80%</b> of spend \u00b7 top ${n} shown \u00b7 click a bar to open</div>`;
  setCount('pareto', `${k80}/${costsDesc.length}`);
  body.querySelectorAll('.pareto-bar').forEach((el) => el.addEventListener('click', () => openDock((el as HTMLElement).dataset.id!)));
}

// Inventory composition: resource COUNT by type (complements the cost charts).
function renderInvMix() {
  const body = document.getElementById('body-invmix'); if (!body) return;
  if (!invById.size) { body.innerHTML = '<span class="muted">\u2026</span>'; return; }
  const counts = new Map<string, number>(); let total = 0;
  for (const r of invById.values()) {
    if (filterActive() && !matchesFilter(r.name, r.type, r.resourceGroup)) continue;
    const k = shortType(r.type); counts.set(k, (counts.get(k) || 0) + 1); total++;
  }
  const arr = [...counts.entries()].map(([label, value]) => ({ label, value })).sort((x, y) => y.value - x.value);
  if (!total) { body.innerHTML = '<div class="chart-empty">No resources in this scope.</div>'; setCount('invmix', '0'); return; }
  const segs = arr.slice(0, 8).map((x) => ({ label: x.label, value: x.value }));
  const max = Math.max(...arr.map((x) => x.value), 1);
  const rows = arr.slice(0, 8).map((x) => `<button class="hrow svc-row" data-type="${h(x.label)}" title="Drill into ${h(x.label)} \u2192"><div class="hb-top"><span class="hb-name">${h(x.label)}</span><span class="hb-val">${x.value}</span></div><div class="hb-track"><div class="hb-fill" style="width:${Math.max(2, (x.value / max) * 100).toFixed(1)}%"></div></div></button>`).join('');
  body.innerHTML = `<div class="donut-host">${donut(segs, { center: String(total), centerSub: 'resources', fmt: (v) => String(Math.round(v)) })}</div><div class="svc-bars">${rows}</div>`;
  setCount('invmix', total);
  body.querySelectorAll('.svc-row').forEach((b) => b.addEventListener('click', () => { const t = (b as HTMLElement).dataset.type!; openResourceDrill(t, `${counts.get(t) || 0} \u00d7 ${t}`, invDrill((r) => shortType(r.type) === t && (!filterActive() || matchesFilter(r.name, r.type, r.resourceGroup)))); }));
}

// Weekly spend pattern: average daily cost by weekday (spots idle weekends).
function renderDow() {
  const body = document.getElementById('body-dow'); if (!body) return;
  const a = lastAnalytics; if (!a) { body.innerHTML = '<span class="muted">\u2026</span>'; return; }
  const cur = a.currency || state.currency;
  const trend = a.trend || [];
  if (new Set(trend.map((p) => p.date)).size < 7) { body.innerHTML = '<div class="chart-empty">Select a 7d+ period to see weekday patterns.</div>'; setCount('dow', '\u2014'); return; }
  const sums = new Array(7).fill(0), cnts = new Array(7).fill(0);
  for (const p of trend) { const d = new Date(p.date); if (isNaN(d.getTime())) continue; const wd = d.getUTCDay(); sums[wd] += p.cost; cnts[wd]++; }
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const items = [1, 2, 3, 4, 5, 6, 0].map((wd) => ({ label: names[wd], value: cnts[wd] ? sums[wd] / cnts[wd] : 0, color: (wd === 0 || wd === 6) ? '#ff8800' : '#3bd6ff' }));
  const wdAvg = [1, 2, 3, 4, 5].reduce((s2, d) => s2 + (cnts[d] ? sums[d] / cnts[d] : 0), 0) / 5;
  const weAvg = [0, 6].reduce((s2, d) => s2 + (cnts[d] ? sums[d] / cnts[d] : 0), 0) / 2;
  body.innerHTML = columns(items, { height: 86, fmt: (v) => compactMoney(v, cur) }) +
    `<div class="small muted ext-note">weekday <b>${money(wdAvg, cur)}</b>/day \u00b7 weekend <b>${money(weAvg, cur)}</b>/day${weAvg > 0 && weAvg < wdAvg * 0.6 ? ' \u00b7 idle weekends \u2014 schedule non-prod off' : ''}</div>`;
  setCount('dow', `${compactMoney(wdAvg, cur)}/d`);
}

// Spend anomalies: flag days where daily cost exceeds mean + 2\u03c3 (statistical spike).
function renderAnomaly() {
  const body = document.getElementById('body-anomaly'); if (!body) return;
  const a = lastAnalytics; if (!a) { body.innerHTML = '<span class="muted">\u2026</span>'; return; }
  const cur = a.currency || state.currency;
  const trend = a.trend || [];
  if (trend.length < 4) { body.innerHTML = '<div class="chart-empty">Select a 7d+ period to detect anomalies.</div>'; setCount('anomaly', '\u2014'); return; }
  const costs = trend.map((p) => p.cost);
  const mean = costs.reduce((s2, v) => s2 + v, 0) / costs.length;
  const sd = Math.sqrt(costs.reduce((s2, v) => s2 + (v - mean) ** 2, 0) / costs.length);
  const hi = mean + 2 * sd, lo = Math.max(0, mean - 2 * sd);
  const W = 600, ht = 128, padL = 4, padR = 4, padT = 8, padB = 12, n = trend.length;
  const max = Math.max(...costs, hi, 0.0001);
  const X = (i: number) => padL + (i / (n - 1 || 1)) * (W - padL - padR);
  const Y = (v: number) => padT + (1 - v / max) * (ht - padT - padB);
  const line = trend.map((p, i) => `${X(i).toFixed(1)},${Y(p.cost).toFixed(1)}`).join(' ');
  const band = sd > 0 ? `<rect x="${padL}" y="${Y(hi).toFixed(1)}" width="${(W - padL - padR).toFixed(1)}" height="${Math.max(0, Y(lo) - Y(hi)).toFixed(1)}" fill="rgba(59,214,255,.08)"/><line x1="${padL}" y1="${Y(mean).toFixed(1)}" x2="${W - padR}" y2="${Y(mean).toFixed(1)}" stroke="rgba(255,255,255,.22)" stroke-width="1" stroke-dasharray="3 3"/>` : '';
  const anomalies = trend.map((p, i) => ({ p, i })).filter(({ p }) => sd > 0 && p.cost > hi);
  const dots = anomalies.map(({ p, i }) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(p.cost).toFixed(1)}" r="3" fill="#ff4444"><title>${h(p.date)}: ${money(p.cost, cur)} (+${(((p.cost - mean) / (mean || 1)) * 100).toFixed(0)}% vs avg)</title></circle>`).join('');
  const list = anomalies.length
    ? `<div class="anom-list">${anomalies.slice(-4).reverse().map(({ p }) => `<div class="anom-row"><span class="anom-dot"></span><span class="anom-date">${h(p.date)}</span><span class="anom-cost">${money(p.cost, cur)}</span><span class="up">+${(((p.cost - mean) / (mean || 1)) * 100).toFixed(0)}%</span></div>`).join('')}</div>`
    : `<div class="small muted ext-note">No spend spikes \u2014 daily cost stays within \u00b12\u03c3 of the ${money(mean, cur)}/day average.</div>`;
  body.innerHTML = `<svg class="ext-svg" viewBox="0 0 ${W} ${ht}" preserveAspectRatio="none">${band}<polyline points="${line}" fill="none" stroke="#44ff88" stroke-width="1.5"/>${dots}</svg>` + list;
  setCount('anomaly', anomalies.length ? `${anomalies.length} spike${anomalies.length === 1 ? '' : 's'}` : 'normal');
  setSev('anomaly', anomalies.length ? 'high' : 'normal');
}

// ============================================================================
//  Cost Explorer — an interactive cost-analysis view (Azure Cost Management
//  parity): group by Service / Resource type / Resource group / Location, view
//  as daily-stacked / accumulated / breakdown, over presets or a custom date
//  range, with click-through to the underlying resources. Backed by the live
//  /api/cost endpoint (group-by + Daily granularity + custom from/to).
// ============================================================================
type ExpGroupBy = 'ServiceName' | 'ResourceType' | 'ResourceGroupName' | 'ResourceLocation';
type ExpView = 'daily' | 'accum' | 'total';
const EXP_GROUPS: { id: ExpGroupBy; label: string }[] = [
  { id: 'ServiceName', label: 'Service' },
  { id: 'ResourceType', label: 'Resource type' },
  { id: 'ResourceGroupName', label: 'Resource group' },
  { id: 'ResourceLocation', label: 'Location' },
];
const EXP_RANGES: { id: string; label: string }[] = [
  { id: '7d', label: '7D' }, { id: '30d', label: '30D' }, { id: '90d', label: '90D' },
  { id: 'mtd', label: 'MTD' }, { id: 'lastmonth', label: 'Last mo' },
];
const EXP_PALETTE = ['#44ff88', '#3bd6ff', '#ffaa00', '#ff6b9d', '#a78bfa', '#ff8800', '#2dd4bf'];
const expState: { groupBy: ExpGroupBy; view: ExpView; range: string; from: string; to: string } = { groupBy: 'ServiceName', view: 'daily', range: '30d', from: '', to: '' };
let expData: CostResp | null = null;
let expKey = '';
let expReqKey = '';
let expLoading = false;

function expDimLabel(dim: string): string { if (!dim) return '(unattributed)'; return expState.groupBy === 'ResourceType' ? shortType(dim) : dim; }
function expFmtDate(s: string): string { return s && s.length >= 8 ? `${+s.slice(4, 6)}/${+s.slice(6, 8)}` : s; }
function expDates(): { range: string; from?: string; to?: string } {
  const r = expState.range;
  if (r === 'custom') return expState.from && expState.to ? { range: 'custom', from: expState.from, to: expState.to } : { range: '30d' };
  const now = new Date();
  if (r === 'mtd') { const f = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); return { range: 'custom', from: f.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) }; }
  if (r === 'lastmonth') { const f = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)); const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)); return { range: 'custom', from: f.toISOString().slice(0, 10), to: t.toISOString().slice(0, 10) }; }
  return { range: r };
}
function ensureExplorer() {
  const sub = state.subscriptionId; if (!sub) return;
  if (expState.range === 'custom' && !(expState.from && expState.to)) { renderExplorer(); return; }
  const d = expDates();
  const key = `${sub}:${expState.groupBy}:${d.range}:${d.from || ''}:${d.to || ''}`;
  if (expKey === key && expData) { renderExplorer(); return; }
  expLoading = true; expReqKey = key; renderExplorer();
  api.cost(sub, expState.groupBy, 'Daily', d.range, d.from, d.to)
    .then((r) => { if (expReqKey !== key) return; expData = r; expKey = key; expLoading = false; renderExplorer(); })
    .catch(() => { if (expReqKey === key) { expLoading = false; expData = null; expKey = key; renderExplorer(); } });
}
function expDrill(dim: string) {
  const g = expState.groupBy;
  if (g === 'ServiceName') { openServiceDrill(dim); return; }
  const ld = dim.toLowerCase();
  if (g === 'ResourceType') openResourceDrill(shortType(dim), `resources of type ${shortType(dim)}`, invDrill((r) => r.type.toLowerCase() === ld));
  else if (g === 'ResourceGroupName') openResourceDrill(`Resource group: ${dim}`, `resources in ${dim}`, invDrill((r) => (r.resourceGroup || '').toLowerCase() === ld));
  else openResourceDrill(`Location: ${dim}`, `resources in ${dim}`, invDrill((r) => (r.location || '').toLowerCase() === ld));
}
function expStackedSvg(dates: string[], byDate: Map<string, Map<string, number>>, topDims: string[], colorOf: (d: string) => string, cur: string): string {
  const W = 600, ht = 152, padL = 4, padR = 4, padT = 8, padB = 16;
  const dayTotals = dates.map((dt) => { let s = 0; for (const v of byDate.get(dt)!.values()) s += v; return s; });
  const maxDay = Math.max(...dayTotals, 0.0001);
  const n = dates.length, bw = (W - padL - padR) / (n || 1), barW = Math.min(26, bw * 0.78), yh = ht - padT - padB;
  let bars = '';
  dates.forEach((dt, i) => {
    const m = byDate.get(dt)!; const cx = padL + bw * i + bw / 2; let yAcc = ht - padB;
    const otherVal = [...m.entries()].filter(([k]) => !topDims.includes(k)).reduce((s, [, v]) => s + v, 0);
    const segs: [string, number][] = [...topDims.map((d): [string, number] => [d, m.get(d) || 0]), ['__other', otherVal]];
    for (const [dim, val] of segs) {
      if (val <= 0) continue; const segH = (val / maxDay) * yh; yAcc -= segH;
      bars += `<rect x="${(cx - barW / 2).toFixed(1)}" y="${yAcc.toFixed(1)}" width="${barW.toFixed(1)}" height="${segH.toFixed(1)}" fill="${dim === '__other' ? '#5a6b7a' : colorOf(dim)}"><title>${expFmtDate(dt)} \u00b7 ${dim === '__other' ? 'Other' : h(expDimLabel(dim))}: ${money(val, cur)}</title></rect>`;
    }
  });
  const labIdx = [0, Math.floor(n / 2), n - 1];
  const xlabs = labIdx.map((i) => { const cx = padL + bw * i + bw / 2; return `<text x="${cx.toFixed(1)}" y="${ht - 4}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}" class="ext-ax">${expFmtDate(dates[i])}</text>`; }).join('');
  return `<svg class="ext-svg" viewBox="0 0 ${W} ${ht}">${bars}${xlabs}</svg>`;
}
function expAccumSvg(dates: string[], byDate: Map<string, Map<string, number>>, total: number, cur: string): string {
  const W = 600, ht = 152, padL = 4, padR = 4, padT = 10, padB = 16;
  const cum: number[] = []; let run = 0;
  for (const dt of dates) { let s = 0; for (const v of byDate.get(dt)!.values()) s += v; run += s; cum.push(run); }
  const max = Math.max(...cum, 0.0001), n = dates.length;
  const X = (i: number) => padL + (i / (n - 1 || 1)) * (W - padL - padR);
  const Y = (v: number) => padT + (1 - v / max) * (ht - padT - padB);
  const line = cum.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  const area = `${X(0).toFixed(1)},${(ht - padB).toFixed(1)} ${line} ${X(n - 1).toFixed(1)},${(ht - padB).toFixed(1)}`;
  return `<svg class="ext-svg" viewBox="0 0 ${W} ${ht}" preserveAspectRatio="none"><polygon points="${area}" fill="rgba(68,255,136,.13)"/><polyline points="${line}" fill="none" stroke="#44ff88" stroke-width="1.6"/></svg><div class="small muted ext-note">accumulated <b>${money(total, cur)}</b> over ${n} days</div>`;
}
function expChartHtml(d: CostResp, cur: string): string {
  const byDim = new Map<string, number>();
  const byDate = new Map<string, Map<string, number>>();
  for (const r of d.rows) {
    const dim = r.key || '';
    byDim.set(dim, (byDim.get(dim) || 0) + r.cost);
    if (r.date) { const dt = String(r.date); if (!byDate.has(dt)) byDate.set(dt, new Map()); const m = byDate.get(dt)!; m.set(dim, (m.get(dim) || 0) + r.cost); }
  }
  const dimsSorted = [...byDim.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const total = dimsSorted.reduce((s, x) => s + x[1], 0);
  if (!total) return '<div class="chart-empty">No cost in this scope / period.</div>';
  const topDims = dimsSorted.slice(0, 7).map((x) => x[0]);
  const colorOf = (dim: string) => { const i = topDims.indexOf(dim); return i >= 0 ? EXP_PALETTE[i] : '#5a6b7a'; };
  const dates = [...byDate.keys()].sort();
  let chart: string;
  if (expState.view === 'total' || !dates.length) {
    chart = `<div class="donut-host">${donut(dimsSorted.slice(0, 8).map(([label, value]) => ({ label: expDimLabel(label), value })), { center: compactMoney(total, cur), centerSub: 'total', fmt: (v) => money(v, cur) })}</div>`;
  } else if (expState.view === 'accum') {
    chart = expAccumSvg(dates, byDate, total, cur);
  } else {
    chart = expStackedSvg(dates, byDate, topDims, colorOf, cur);
  }
  const legend = (expState.view !== 'total' && dates.length)
    ? `<div class="exp-legend">${topDims.map((dim) => `<button class="exp-leg" data-dim="${h(dim)}"><span class="exp-sw" style="background:${colorOf(dim)}"></span>${h(expDimLabel(dim))}</button>`).join('')}${dimsSorted.length > 7 ? `<span class="exp-leg"><span class="exp-sw" style="background:#5a6b7a"></span>Other</span>` : ''}</div>`
    : '';
  const max = dimsSorted[0]?.[1] || 0.0001;
  const rows = dimsSorted.slice(0, 14).map(([dim, cost]) => `<button class="hrow exp-row" data-dim="${h(dim)}" title="Drill into ${h(expDimLabel(dim))} \u2192"><div class="hb-top"><span class="hb-name">${h(expDimLabel(dim))}</span><span class="hb-val">${money(cost, cur)} \u00b7 ${((cost / total) * 100).toFixed(0)}%</span></div><div class="hb-track"><div class="hb-fill" style="width:${Math.max(2, (cost / max) * 100).toFixed(1)}%;background:${colorOf(dim)}"></div></div></button>`).join('');
  return chart + legend + `<div class="exp-table">${rows}</div>`;
}
function renderExplorer() {
  const body = document.getElementById('body-explorer'); if (!body) return;
  const cur = expData?.rows?.[0]?.currency || state.currency;
  const groupSel = `<select class="ff-sel" id="expGroup" title="Group cost by dimension">${EXP_GROUPS.map((g) => `<option value="${g.id}" ${expState.groupBy === g.id ? 'selected' : ''}>${g.label}</option>`).join('')}</select>`;
  const viewBtns = ([['daily', 'Daily'], ['accum', 'Accumulated'], ['total', 'Breakdown']] as [ExpView, string][]).map(([v, l]) => `<button class="exp-vbtn ${expState.view === v ? 'active' : ''}" data-view="${v}">${l}</button>`).join('');
  const rangeChips = EXP_RANGES.map((r) => `<button class="exp-rchip ${expState.range === r.id ? 'active' : ''}" data-range="${r.id}">${r.label}</button>`).join('') + `<button class="exp-rchip ${expState.range === 'custom' ? 'active' : ''}" data-range="custom">Custom</button>`;
  const customInputs = expState.range === 'custom' ? `<span class="exp-custom"><input type="date" class="exp-date" id="expFrom" value="${expState.from}"><span class="exp-arrow">\u2192</span><input type="date" class="exp-date" id="expTo" value="${expState.to}"></span>` : '';
  const toolbar = `<div class="exp-toolbar"><span class="exp-lbl">Group by</span>${groupSel}<span class="exp-views">${viewBtns}</span><span class="exp-ranges">${rangeChips}${customInputs}</span></div>`;
  let main: string;
  if (expLoading) main = '<div class="exp-loading"><span class="spinner"></span><span class="muted">Querying Azure Cost Management\u2026 (live, ~10\u201320s)</span></div>';
  else if (expState.range === 'custom' && !(expState.from && expState.to)) main = '<div class="chart-empty">Pick a start and end date.</div>';
  else if (!expData) main = '<div class="chart-empty">Cost data unavailable for this scope.</div>';
  else main = expChartHtml(expData, cur);
  body.innerHTML = toolbar + `<div class="exp-main">${main}</div>`;
  const totalNow = expData ? expData.rows.reduce((s, r) => s + r.cost, 0) : 0;
  setCount('explorer', expLoading ? '\u2026' : compactMoney(totalNow, cur));
  (document.getElementById('expGroup') as HTMLSelectElement | null)?.addEventListener('change', (e) => { expState.groupBy = (e.target as HTMLSelectElement).value as ExpGroupBy; ensureExplorer(); });
  body.querySelectorAll('.exp-vbtn').forEach((b) => b.addEventListener('click', () => { expState.view = (b as HTMLElement).dataset.view as ExpView; renderExplorer(); }));
  body.querySelectorAll('.exp-rchip').forEach((b) => b.addEventListener('click', () => { expState.range = (b as HTMLElement).dataset.range!; ensureExplorer(); }));
  document.getElementById('expFrom')?.addEventListener('change', (e) => { expState.from = (e.target as HTMLInputElement).value; ensureExplorer(); });
  document.getElementById('expTo')?.addEventListener('change', (e) => { expState.to = (e.target as HTMLInputElement).value; ensureExplorer(); });
  body.querySelectorAll('.exp-row, .exp-leg[data-dim]').forEach((b) => b.addEventListener('click', () => expDrill((b as HTMLElement).dataset.dim!)));
}

// ---- About ---------------------------------------------------------------
function openAbout() {
  const html = `<div class="pm about-pm">` +
    `<div class="pm-titlebar"><h3>Azure Infra World Map</h3><span class="pm-sub2">Global cloud intelligence \u00b7 live command center for your Azure estate</span></div>` +
    `<div class="pm-detail about-body">` +
      `<p class="about-lead">A real-time, interactive command center for your entire Azure footprint \u2014 cost, resources, security, reliability, governance and service health \u2014 visualized on a live 3D globe and world map, with drill-down to every resource.</p>` +
      `<div class="about-grid">` +
        `<div class="about-card"><span class="about-ic">\u25c9</span><div><b>Cost Explorer &amp; Analysis</b><span>Group by service, type, resource group or location \u00b7 daily, accumulated &amp; breakdown views \u00b7 custom date ranges \u00b7 drill to resource.</span></div></div>` +
        `<div class="about-card"><span class="about-ic">\u25b2</span><div><b>Forecast, Budgets &amp; Anomalies</b><span>30-day run-rate projection, budget tracking, Pareto concentration and statistical spend-spike detection.</span></div></div>` +
        `<div class="about-card"><span class="about-ic">\u2941</span><div><b>Resource Intelligence</b><span>Live inventory, dependency linkage across regions, availability-zone topology, tag governance &amp; showback.</span></div></div>` +
        `<div class="about-card"><span class="about-ic">\u2695</span><div><b>Posture &amp; Operations</b><span>Defender for Cloud security, Advisor, Well-Architected scoring, service health, backup &amp; resiliency.</span></div></div>` +
      `</div>` +
      `<p class="about-data">Powered entirely by <b>live Azure data</b> \u2014 Cost Management, Resource Graph, Microsoft Defender for Cloud, Advisor, Azure Monitor and Service Health. Read-only; nothing is modified in your environment.</p>` +
      `<div class="about-author">` +
        `<div class="about-author-badge">ZS</div>` +
        `<div class="about-author-info">` +
          `<span class="about-author-label">Solution developed by</span>` +
          `<b class="about-author-name">Zahir Hussain Shah</b>` +
          `<span class="about-author-role">Senior Solution Engineer \u00b7 Microsoft Qatar</span>` +
        `</div>` +
      `</div>` +
    `</div></div>`;
  showWnModal(html, 'panel');
}

// ---- Exports: Excel workbook, PDF report, resources CSV --------------------
function curSubName(): string { return allSubs.find((x) => x.subscriptionId === state.subscriptionId)?.displayName || state.subscriptionId || 'subscription'; }
function fileStamp(base: string): string { return `${base}-${curSubName()}-${new Date().toISOString().slice(0, 10)}`.replace(/[^\w.-]+/g, '-').toLowerCase(); }

function openExportMenu() {
  showWnModal(`<div class="pm"><div class="pm-titlebar"><h3>Export FinOps report</h3><span class="pm-sub2">${h(curSubName())} \u00b7 ${h(state.range)}</span></div>` +
    `<div class="exp-menu">` +
    `<button class="exp-opt" id="expXlsx"><span class="exp-ico">\u25a6</span><span class="exp-txt"><span class="exp-t">Excel workbook (.xlsx)</span><span class="exp-d">Multi-sheet: summary, cost by service &amp; type, resources, allocation, waste, regions, governance.</span></span></button>` +
    `<button class="exp-opt" id="expPdf"><span class="exp-ico">\u2750</span><span class="exp-txt"><span class="exp-t">PDF report</span><span class="exp-d">Formatted executive FinOps report \u2014 opens print dialog (Save as PDF).</span></span></button>` +
    `<button class="exp-opt" id="expCsv"><span class="exp-ico">\u2630</span><span class="exp-txt"><span class="exp-t">Resources CSV</span><span class="exp-d">Every resource with cost &amp; tags \u2014 for pivots / chargeback.</span></span></button>` +
    `</div></div>`, 'panel');
  document.getElementById('expXlsx')?.addEventListener('click', () => { closeWnModal(); exportWorkbook(); });
  document.getElementById('expPdf')?.addEventListener('click', () => { closeWnModal(); exportPdfReport(); });
  document.getElementById('expCsv')?.addEventListener('click', () => { closeWnModal(); exportResourcesCsv(); });
}

function exportWorkbook() {
  if (!invById.size) { showBanner('Data still loading \u2014 try again in a moment.'); return; }
  const cur = state.currency;
  const s = panelData.kpi as SummaryResp | undefined;
  const a = lastAnalytics;
  const opt = panelData.waste as OptimizeResp | undefined;
  const costMap = a?.costById || {};
  const ut = untaggedSpend();
  const runRate = s ? (s.forecast30 || s.dailyBurn * 30) : 0;
  const savings = opt?.estimatedMonthlySavings || 0;
  const budget = getBudget();
  const sheets: XSheet[] = [];

  sheets.push({ name: 'Summary', cols: [32, 22], rows: [
    [{ v: 'Azure FinOps Report', header: true }, { v: '', header: true }],
    ['Subscription', curSubName()],
    ['Period', state.range],
    ['Currency', cur],
    ['Generated (UTC)', new Date().toUTCString()],
    [],
    [{ v: 'Metric', header: true }, { v: 'Value', header: true }],
    ['Total spend', { v: s?.totalCost ?? 0, money: true }],
    ['Previous period', { v: s?.prevCost ?? 0, money: true }],
    ['Change vs prior', { v: s?.deltaPct != null ? s.deltaPct / 100 : 0, pct: true }],
    ['Daily burn', { v: s?.dailyBurn ?? 0, money: true }],
    ['Projected monthly run-rate', { v: runRate, money: true }],
    ['Monthly budget', budget ? { v: budget, money: true } : 'not set'],
    ['Budget variance', budget ? { v: runRate - budget, money: true } : '\u2014'],
    ['Resources', { v: s?.resourceCount ?? invById.size, int: true }],
    ['Regions', { v: s?.regionCount ?? 0, int: true }],
    ['Resource groups', { v: s?.rgCount ?? 0, int: true }],
    ['Tag coverage', { v: s ? (s.taggedPct || 0) / 100 : 0, pct: true }],
    ['Untagged spend', { v: ut.cost, money: true }],
    ['Untagged spend %', { v: ut.total ? ut.cost / ut.total : 0, pct: true }],
    ['Estimated monthly savings', { v: savings, money: true }],
    ['Effective savings rate', { v: runRate ? savings / runRate : 0, pct: true }],
  ] });

  if (a?.byService?.length) {
    const tot = a.byService.reduce((x, y) => x + y.cost, 0);
    sheets.push({ name: 'Cost by Service', cols: [36, 16, 12], rows: [
      [{ v: 'Service', header: true }, { v: 'Cost', header: true }, { v: '% of total', header: true }],
      ...a.byService.map((x): XCell[] => [x.name, { v: x.cost, money: true }, { v: tot ? x.cost / tot : 0, pct: true }]),
    ] });
  }
  if (a?.byType?.length) {
    const tot = a.byType.reduce((x, y) => x + y.cost, 0);
    sheets.push({ name: 'Cost by Type', cols: [42, 16, 12], rows: [
      [{ v: 'Resource type', header: true }, { v: 'Cost', header: true }, { v: '% of total', header: true }],
      ...a.byType.map((x): XCell[] => [shortType(x.name), { v: x.cost, money: true }, { v: tot ? x.cost / tot : 0, pct: true }]),
    ] });
  }
  const invRows = [...invById.values()].map((r) => ({ r, c: costMap[r.id.toLowerCase()] || 0 })).sort((x, y) => y.c - x.c);
  sheets.push({ name: 'Resources', cols: [34, 30, 22, 16, 14], rows: [
    [{ v: 'Name', header: true }, { v: 'Type', header: true }, { v: 'Resource group', header: true }, { v: 'Location', header: true }, { v: 'Cost', header: true }],
    ...invRows.slice(0, 5000).map(({ r, c }): XCell[] => [r.name, shortType(r.type), r.resourceGroup || '', r.location || '', { v: c, money: true }]),
  ] });
  const dim = resolveAllocDim(); const alloc = costByDimension(dim);
  const dimLabel = dim.startsWith('tag:') ? `Tag: ${dim.slice(4)}` : dim === 'rg' ? 'Resource group' : 'Location';
  sheets.push({ name: 'Cost Allocation', cols: [34, 16, 12, 12], rows: [
    [{ v: dimLabel, header: true }, { v: 'Cost', header: true }, { v: 'Resources', header: true }, { v: '% of total', header: true }],
    ...alloc.rows.map((x): XCell[] => [x.key, { v: x.cost, money: true }, { v: x.count, int: true }, { v: alloc.total ? x.cost / alloc.total : 0, pct: true }]),
    ...(alloc.unalloc.count ? [['(unallocated)', { v: alloc.unalloc.cost, money: true }, { v: alloc.unalloc.count, int: true }, { v: alloc.total ? alloc.unalloc.cost / alloc.total : 0, pct: true }] as XCell[]] : []),
  ] });
  if (opt) {
    const findings = [...(opt.findings || []), ...(opt.untagged ? [opt.untagged] : [])];
    sheets.push({ name: 'Waste & Savings', cols: [36, 12, 18], rows: [
      [{ v: 'Finding', header: true }, { v: 'Count', header: true }, { v: 'Monthly cost', header: true }],
      ...findings.map((f): XCell[] => [f.label, { v: f.count, int: true }, { v: f.monthlyCost || 0, money: true }]),
      [{ v: 'Total estimated savings', bold: true }, { v: '' }, { v: savings, money: true, bold: true }],
    ] });
  }
  if (regionData.length) {
    const tot = regionData.reduce((x, y) => x + y.cost, 0);
    sheets.push({ name: 'Regions', cols: [26, 16, 12, 12], rows: [
      [{ v: 'Region', header: true }, { v: 'Cost', header: true }, { v: 'Resources', header: true }, { v: '% of total', header: true }],
      ...regionData.slice().sort((x, y) => y.cost - x.cost).map((r): XCell[] => [r.display, { v: r.cost, money: true }, { v: r.count, int: true }, { v: tot ? r.cost / tot : 0, pct: true }]),
    ] });
  }
  if (opt?.governance) {
    const g = opt.governance;
    sheets.push({ name: 'Governance', cols: [30, 16], rows: [
      [{ v: 'Tag governance', header: true }, { v: 'Value', header: true }],
      ['Resources', { v: g.total, int: true }],
      ['Tagged', { v: g.tagged, int: true }],
      ['Tag coverage', { v: g.total ? g.tagged / g.total : 0, pct: true }],
      ['Missing owner', { v: g.missingOwner, int: true }],
      ['Missing cost-center', { v: g.missingCostCenter, int: true }],
      ['Missing environment', { v: g.missingEnv, int: true }],
    ] });
  }
  downloadXlsx(fileStamp('azure-finops'), sheets);
}

function exportResourcesCsv() {
  if (!invById.size) { showBanner('Data still loading \u2014 try again in a moment.'); return; }
  const costMap = lastAnalytics?.costById || {};
  const head = ['Name', 'Type', 'ResourceGroup', 'Location', `Cost (${state.currency})`, 'Tags', 'ResourceId'];
  const rows = [...invById.values()]
    .map((r) => ({ r, c: costMap[r.id.toLowerCase()] || 0 }))
    .sort((a, b) => b.c - a.c)
    .map(({ r, c }) => [r.name, shortType(r.type), r.resourceGroup || '', r.location || '', c.toFixed(2), r.tags ? Object.entries(r.tags).map(([k, v]) => `${k}=${v}`).join('; ') : '', r.id]);
  downloadCsv(fileStamp('azure-finops-resources'), head, rows);
}

function exportPdfReport() {
  const cur = state.currency;
  const s = panelData.kpi as SummaryResp | undefined;
  const a = lastAnalytics;
  const opt = panelData.waste as OptimizeResp | undefined;
  const post = panelData.security as PostureResp | undefined;
  const costMap = a?.costById || {};
  const ut = untaggedSpend();
  const runRate = s ? (s.forecast30 || s.dailyBurn * 30) : 0;
  const savings = opt?.estimatedMonthlySavings || 0;
  const budget = getBudget();
  const when = new Date().toUTCString();
  const m = (n: number) => money(n, cur);
  const kc = (l: string, v: string, sub = '') => `<div class="kc"><div class="kv">${h(v)}</div><div class="kl">${h(l)}</div>${sub ? `<div class="ks">${h(sub)}</div>` : ''}</div>`;
  const barRow = (label: string, val: number, max: number) => `<div class="br"><span class="bl">${h(label)}</span><div class="bt"><div class="bf" style="width:${Math.max(1, (val / max) * 100).toFixed(1)}%"></div></div><span class="bv">${m(val)}</span></div>`;
  const svc = (a?.byService || []).slice(0, 10);
  const svcMax = Math.max(...svc.map((x) => x.cost), 0.0001);
  const svcBars = svc.map((x) => barRow(x.name, x.cost, svcMax)).join('') || '<span class="muted">no data</span>';
  const top = [...invById.values()].map((r) => ({ r, c: costMap[r.id.toLowerCase()] || 0 })).sort((x, y) => y.c - x.c).slice(0, 15);
  const topRows = top.map(({ r, c }) => `<tr><td>${h(r.name)}</td><td>${h(shortType(r.type))}</td><td>${h(r.resourceGroup || '')}</td><td class="n">${m(c)}</td></tr>`).join('');
  const dim = resolveAllocDim(); const alloc = costByDimension(dim);
  const dimLabel = dim.startsWith('tag:') ? dim.slice(4) : dim === 'rg' ? 'resource group' : 'location';
  const allocItems = [...alloc.rows.slice(0, 8), ...(alloc.unalloc.count ? [{ key: '(unallocated)', cost: alloc.unalloc.cost, count: alloc.unalloc.count }] : [])];
  const allocMax = Math.max(allocItems[0]?.cost || 0, 0.0001);
  const allocBars = allocItems.map((x) => barRow(x.key, x.cost, allocMax)).join('') || '<span class="muted">no data</span>';
  const findings = [...(opt?.findings || []), ...(opt?.untagged ? [opt.untagged] : [])].filter((f) => f.count > 0);
  const wasteRows = findings.map((f) => `<tr><td>${h(f.label)}</td><td class="n">${f.count}</td><td class="n">${m(f.monthlyCost || 0)}</td></tr>`).join('') || '<tr><td colspan="3">no waste detected</td></tr>';
  const g = opt?.governance;
  const secHigh = post ? (post.security || []).filter((x) => x.status === 'Unhealthy' && String(x.severity).toLowerCase() === 'high').reduce((acc, x) => acc + x.count, 0) : 0;
  const score = post?.secureScore;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Azure FinOps Report \u2014 ${h(curSubName())}</title><style>` +
    `body{font:13px 'Segoe UI',system-ui,sans-serif;color:#252423;margin:30px;max-width:1000px}` +
    `h1{font-size:21px;margin:0 0 2px}h2{font-size:14px;margin:20px 0 8px;color:#1b3a5b;border-bottom:2px solid #e1dfdd;padding-bottom:4px}` +
    `.meta{color:#605e5c;font-size:12px;margin-bottom:14px}` +
    `.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}` +
    `.kc{border:1px solid #e1dfdd;border-radius:2px;padding:10px 12px}.kv{font-size:19px;font-weight:700;color:#1b3a5b}.kl{font-size:11px;color:#605e5c;text-transform:uppercase;letter-spacing:.4px;margin-top:2px}.ks{font-size:11px;color:#8a8886;margin-top:2px}` +
    `.br{display:flex;align-items:center;gap:8px;margin:3px 0;font-size:12px}.bl{width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bt{flex:1;height:11px;background:#f3f2f1;border-radius:2px;overflow:hidden}.bf{height:100%;background:linear-gradient(90deg,#0078d4,#2bb5a0)}.bv{width:96px;text-align:right;font-variant-numeric:tabular-nums}` +
    `table{width:100%;border-collapse:collapse;font-size:12px}th{text-align:left;color:#605e5c;border-bottom:1px solid #c8c6c4;padding:4px 6px;font-size:11px;text-transform:uppercase}td{padding:4px 6px;border-bottom:1px solid #efedeb}td.n{text-align:right;font-variant-numeric:tabular-nums}` +
    `.cols{display:grid;grid-template-columns:1fr 1fr;gap:24px}` +
    `footer{margin-top:22px;color:#8a8886;font-size:11px;border-top:1px solid #e1dfdd;padding-top:8px}` +
    `@media print{body{margin:12mm}.kc,table{break-inside:avoid}}</style></head><body>` +
    `<h1>Azure FinOps Report</h1><div class="meta">Subscription <b>${h(curSubName())}</b> &nbsp;\u00b7&nbsp; Period ${h(state.range)} &nbsp;\u00b7&nbsp; Generated ${h(when)}</div>` +
    `<div class="kpis">${kc('Total spend', m(s?.totalCost ?? 0), `${s?.days ?? 0} days`)}${kc('Projected / month', m(runRate), 'run-rate')}${kc('Est. savings', m(savings) + '/mo', `${(runRate ? savings / runRate * 100 : 0).toFixed(0)}% of spend`)}${kc('Tag coverage', `${Math.round(s?.taggedPct ?? 0)}%`, `${ut.count} untagged`)}</div>` +
    (budget ? `<div class="meta" style="margin-top:10px">Budget <b>${m(budget)}</b>/mo \u00b7 projected ${m(runRate)} \u00b7 <b>${runRate > budget ? 'OVER' : 'under'} by ${m(Math.abs(runRate - budget))}</b></div>` : '') +
    `<div class="cols"><div><h2>Cost by Service</h2>${svcBars}</div><div><h2>Cost Allocation \u00b7 ${h(dimLabel)}</h2>${allocBars}</div></div>` +
    `<h2>Top Resources</h2><table><thead><tr><th>Resource</th><th>Type</th><th>Resource group</th><th class="n">Cost</th></tr></thead><tbody>${topRows}</tbody></table>` +
    `<div class="cols"><div><h2>Waste &amp; Savings</h2><table><thead><tr><th>Finding</th><th class="n">Count</th><th class="n">Monthly</th></tr></thead><tbody>${wasteRows}</tbody></table></div>` +
    `<div><h2>Governance &amp; Posture</h2><table><tbody>` +
    (g ? `<tr><td>Tag coverage</td><td class="n">${Math.round(g.taggedPct)}%</td></tr><tr><td>Missing owner</td><td class="n">${g.missingOwner}</td></tr><tr><td>Missing cost-center</td><td class="n">${g.missingCostCenter}</td></tr><tr><td>Missing environment</td><td class="n">${g.missingEnv}</td></tr>` : '') +
    (score ? `<tr><td>Secure score</td><td class="n">${score.pct}%</td></tr>` : '') +
    `<tr><td>High-severity security findings</td><td class="n">${secHigh}</td></tr>` +
    `<tr><td>Untagged spend</td><td class="n">${m(ut.cost)}</td></tr></tbody></table></div></div>` +
    `<footer>Generated from live Azure Cost Management, Resource Graph, Advisor and Microsoft Defender for Cloud data. Forecast = average daily burn \u00d7 30. Directional cost report.</footer>` +
    `<scr${''}ipt>window.onload=function(){setTimeout(function(){window.print()},300)}</scr${''}ipt></body></html>`;
  const win = window.open('', '_blank');
  if (!win) { showBanner('Allow pop-ups to export the PDF report.'); return; }
  win.document.write(html); win.document.close();
}

function downloadCsv(filename: string, head: string[], rows: (string | number)[][]) {
  const csv = [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `${filename}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportZoneCsv(b: RegionZonesResp['zones'][number], cur: string, zoneLabel: string) {
  const rows = zoneFiltered(b);
  const head = ['Name', 'Type', 'ResourceGroup', 'Subscription', 'Zone', 'ZoneRedundant', `Cost (${cur})`, 'Tags', 'ResourceId'];
  const data = rows.map((r) => [r.name, shortType(r.type), r.resourceGroup || '', r.subscriptionName || '', zoneLabel, r.zoneRedundant ? 'yes' : 'no', r.cost.toFixed(2), tagKv(r), r.id]);
  downloadCsv(`finops-${focusedDisplay || 'region'}-${zoneLabel}`.replace(/[^\w.-]+/g, '-').toLowerCase(), head, data);
}
function openZoneResources(zone: string) {
  if (!focusedZones) return;
  const b = focusedZones.zones.find((x) => x.zone === zone);
  if (!b) return;
  zoneResFilter.text = ''; zoneResFilter.type = ''; zoneResFilter.sub = ''; zoneResFilter.tag = '';
  const cur = focusedZones.currency;
  const title = zone === 'none' ? 'Regional / Non-zonal' : `Zone ${zone}`;
  const types = [...new Set(b.resources.map((r) => r.type))].sort();
  const subsPresent = [...new Map(b.resources.filter((r) => r.subscriptionId).map((r) => [r.subscriptionId!, r.subscriptionName || r.subscriptionId!])).entries()]
    .sort((a, c) => a[1].localeCompare(c[1]));
  const tagCounts = new Map<string, number>();
  for (const r of b.resources) if (r.tags) for (const [k, v] of Object.entries(r.tags)) { const kv = `${k}=${v}`; tagCounts.set(kv, (tagCounts.get(kv) || 0) + 1); }
  const tagOpts = [...tagCounts.entries()].sort((a, c) => c[1] - a[1]).slice(0, 80).map(([kv]) => kv).sort();
  const host = $('zoneView'); host.classList.remove('hidden');
  host.innerHTML = `<div class="zone-head"><button class="hbtn" id="zoneBack">\u2190 Zones</button><span class="zone-title">${flagImg(focusedZones.region, { w: 18 })}${h(focusedDisplay)} \u00b7 ${title}</span><span class="zone-sub" id="zresCount">${b.count} resources \u00b7 ${money(b.cost, cur)}</span><button class="zres-export" id="zresCsv" title="Export current list to CSV (opens in Excel)">\u2913 CSV</button></div>` +
    `<div class="zres-filter">` +
      `<input id="zresSearch" class="zres-search" placeholder="search ${b.count} resource${b.count === 1 ? '' : 's'}\u2026" autocomplete="off"/>` +
      `<select id="zresType" class="zres-sel"><option value="">All types</option>${types.map((t) => `<option value="${h(t)}">${h(shortType(t))}</option>`).join('')}</select>` +
      (subsPresent.length > 1 ? `<select id="zresSub" class="zres-sel"><option value="">All subscriptions (${subsPresent.length})</option>${subsPresent.map(([id, name]) => `<option value="${h(id)}">${h(name)}</option>`).join('')}</select>` : '') +
      (tagOpts.length ? `<select id="zresTag" class="zres-sel"><option value="">All tags</option>${tagOpts.map((t) => `<option value="${h(t)}">${h(t)}</option>`).join('')}</select>` : '') +
    `</div>` +
    `<div class="zres-list big" id="zresList"></div>`;
  $('zoneBack').addEventListener('click', renderZoneOverview);
  const search = $<HTMLInputElement>('zresSearch');
  let timer: number | undefined;
  search.addEventListener('input', () => { zoneResFilter.text = search.value.trim().toLowerCase(); clearTimeout(timer); timer = window.setTimeout(() => renderZoneResList(b, cur), 130); });
  $<HTMLSelectElement>('zresType').addEventListener('change', (e) => { zoneResFilter.type = (e.target as HTMLSelectElement).value.toLowerCase(); renderZoneResList(b, cur); });
  const subSel = document.getElementById('zresSub') as HTMLSelectElement | null;
  if (subSel) subSel.addEventListener('change', () => { zoneResFilter.sub = subSel.value; renderZoneResList(b, cur); });
  const tagSel = document.getElementById('zresTag') as HTMLSelectElement | null;
  if (tagSel) tagSel.addEventListener('change', () => { zoneResFilter.tag = tagSel.value; renderZoneResList(b, cur); });
  $('zresCsv').addEventListener('click', () => exportZoneCsv(b, cur, title));
  renderZoneResList(b, cur);
  search.focus();
}
function zoneFiltered(b: RegionZonesResp['zones'][number]): ZRes[] {
  const { text, type, sub, tag } = zoneResFilter;
  let filtered: ZRes[] = b.resources;
  if (text) filtered = filtered.filter((r) => `${r.name} ${shortType(r.type)} ${r.type} ${r.resourceGroup || ''} ${r.subscriptionName || ''} ${tagKv(r)}`.toLowerCase().includes(text));
  if (type) filtered = filtered.filter((r) => r.type.toLowerCase() === type);
  if (sub) filtered = filtered.filter((r) => r.subscriptionId === sub);
  if (tag) filtered = filtered.filter((r) => !!r.tags && Object.entries(r.tags).some(([k, v]) => `${k}=${v}` === tag));
  return filtered;
}
function renderZoneResList(b: RegionZonesResp['zones'][number], cur: string) {
  const listEl = document.getElementById('zresList'); if (!listEl) return;
  const { text, type, sub, tag } = zoneResFilter;
  const filtered = zoneFiltered(b);
  const multiSub = new Set(b.resources.map((r) => r.subscriptionId)).size > 1;
  const countEl = document.getElementById('zresCount');
  if (countEl) countEl.textContent = (text || type || sub || tag) ? `${filtered.length} of ${b.count} match` : `${b.count} resources \u00b7 ${money(b.cost, cur)}`;
  if (!filtered.length) { listEl.innerHTML = '<span class="muted small" style="padding:12px">No resources match.</span>'; return; }
  const shown = filtered.slice(0, 300);
  listEl.innerHTML = shown.map((r) =>
    `<button class="zres" data-id="${h(r.id)}">${typeIcon(r.type, { tinted: true })}<span class="zres-name" title="${h(r.name)} \u00b7 ${h(shortType(r.type))}${r.subscriptionName ? ' \u00b7 ' + h(r.subscriptionName) : ''}">${h(r.name)}</span>${multiSub && r.subscriptionName ? `<span class="zres-subchip" title="${h(r.subscriptionName)}">${h(r.subscriptionName)}</span>` : ''}${r.zoneRedundant ? '<span class="zr-badge">ZR</span>' : ''}<span class="zres-cost">${compactMoney(r.cost, cur)}</span></button>`).join('') +
    (filtered.length > 300 ? `<div class="zres-more">showing first 300 of ${filtered.length} \u2014 refine your search</div>` : '');
  listEl.querySelectorAll('.zres').forEach((el) => el.addEventListener('click', () => openDock((el as HTMLElement).dataset.id!)));
}

// ---- Resource detail dock -------------------------------------------------
let dockId: string | null = null;
let dockTab = 'overview';
let dockDetail: ResourceDetail | null = null;
let dockMetricWindow = '6h';
const dockCache = new Map<string, unknown>();
const DOCK_TABS = ['overview', 'metrics', 'cost', 'changes', 'activity', 'security', 'advisor'];
async function openDock(id: string) {
  dockId = id; dockTab = 'overview'; dockDetail = null;
  const ctxCat = typeToCategory(invById.get(id.toLowerCase())?.type || '');
  if (ctxCat) setWhatsNewCategory(ctxCat);
  ensureWhatsNew();
  const dock = $('detailDock'); dock.classList.remove('hidden');
  dock.innerHTML = `<div class="dock-head"><div><div class="dock-title">${h(resName(id))}</div><div class="dock-type">loading\u2026</div></div><button class="dock-x" id="dockX">\u2715</button></div><div class="dock-body"><span class="muted">\u2026</span></div>`;
  $('dockX').addEventListener('click', closeDock);
  try {
    const d = await api.resource(id, state.range);
    if (dockId !== id) return;
    dockDetail = d; renderDock();
  } catch (err: any) { const b = $('detailDock').querySelector('.dock-body'); if (b) b.innerHTML = `<span class="muted">error: ${err.message}</span>`; }
}
function closeDock() { dockId = null; dockDetail = null; $('detailDock').classList.add('hidden'); $('detailDock').innerHTML = ''; }
// Normalized power state for compute VMs (drives the running/stopped status bulb).
function powerInfo(d: ResourceDetail): { code: string; label: string; on: boolean } | null {
  const ps = (d.powerState || '').toLowerCase();
  if (!ps) return null;
  const label = ps === 'running' ? 'Running' : ps === 'deallocated' ? 'Deallocated'
    : ps === 'stopped' ? 'Stopped' : ps === 'starting' ? 'Starting' : ps === 'stopping' ? 'Stopping'
    : ps.charAt(0).toUpperCase() + ps.slice(1);
  return { code: ps, label, on: ps === 'running' };
}
function powerBulbHtml(d: ResourceDetail): string {
  const p = powerInfo(d);
  if (!p) return '';
  return `<span class="pwr-bulb ${p.on ? 'on' : 'off'}" title="Power state: ${h(p.label)}"><span class="pwr-led"></span>${h(p.label)}</span>`;
}
function renderDock() {
  const d = dockDetail; if (!d) return;
  const res = d.resource || {}; const inv = invById.get(d.id.toLowerCase());
  const typeStr = shortType((res.type || inv?.type || '').toLowerCase());
  const icon = typeIcon(res.type || inv?.type || '', { tinted: true, cls: 'rty-ico lg' });
  const hl = (d.health?.state || '').toLowerCase();
  const hcls = hl === 'available' ? 'ok' : hl === 'unavailable' ? 'bad' : hl ? 'warn' : '';
  const hb = d.health?.state ? `<span class="health-badge ${hcls}">${healthIcon(d.health.state)}${h(d.health.state)}</span>` : '';
  const pwr = powerBulbHtml(d);
  const tabs = DOCK_TABS.map((t) => `<button class="dock-tab ${t === dockTab ? 'active' : ''}" data-tab="${t}">${t}</button>`).join('');
  $('detailDock').innerHTML = `<div class="dock-head"><div class="dock-head-main">${icon}<div class="dock-head-txt"><div class="dock-title">${h(res.name || resName(d.id))} ${hb}</div><div class="dock-type">${h(typeStr)}${pwr ? ` <span class="dock-sep">\u2022</span> ${pwr}` : ''}</div></div></div><button class="dock-x" id="dockX">\u2715</button></div><div class="dock-tabs">${tabs}</div><div class="dock-body" id="dockBody"></div>`;
  $('dockX').addEventListener('click', closeDock);
  $('detailDock').querySelectorAll('.dock-tab').forEach((b) => b.addEventListener('click', () => { dockTab = (b as HTMLElement).dataset.tab!; renderDock(); }));
  renderDockTab();
}
function renderDockTab() {
  const d = dockDetail!; const body = $('dockBody'); const inv = invById.get(d.id.toLowerCase());
  if (dockTab === 'overview') {
    const res = d.resource || {}; const props = res.properties || {}; const tags = res.tags || inv?.tags || {};
    const zones = inv?.zones || [];
    const kv: [string, string][] = [];
    if (res.location || inv?.location) kv.push(['Location', res.location || inv?.location || '']);
    if (inv?.resourceGroup) kv.push(['Resource group', inv.resourceGroup]);
    kv.push(['Availability zone', zones.length ? zones.join(', ') : 'Non-zonal']);
    if (props.provisioningState) kv.push(['Provisioning', props.provisioningState]);
    if (res.sku?.name || inv?.sku) kv.push(['SKU', res.sku?.name || (typeof inv?.sku === 'object' ? JSON.stringify(inv?.sku) : String(inv?.sku || ''))]);
    if (res.kind || inv?.kind) kv.push(['Kind', res.kind || inv?.kind || '']);
    const tagKeys = Object.keys(tags || {});
    const health = d.health?.state;
    const hpct = health ? (health.toLowerCase() === 'available' ? 100 : health.toLowerCase() === 'unavailable' ? 0 : 50) : null;
    const costTotal = d.cost?.total || 0; const cur = d.cost?.currency || state.currency;
    const pw = powerInfo(d);
    body.innerHTML =
      `<div class="dgrid">` +
        (hpct != null ? `<div class="dcard">${gauge(hpct, { label: 'Health', sub: h(health!), color: hpct >= 100 ? '#44ff88' : hpct === 0 ? '#ff4444' : '#ffaa00', size: 104 })}</div>` : '') +
        (pw ? `<div class="dcard dcard-stat"><div class="dstat-v pwr-stat ${pw.on ? 'on' : 'off'}"><span class="pwr-led"></span>${h(pw.label)}</div><div class="dstat-l">power state</div></div>` : '') +
        `<div class="dcard dcard-stat"><div class="dstat-v">${money(costTotal, cur)}</div><div class="dstat-l">cost \u00b7 ${h(state.range)}</div></div>` +
        `<div class="dcard dcard-stat"><div class="dstat-v">${zones.length ? 'Zonal' : 'Regional'}</div><div class="dstat-l">${zones.length ? 'zone ' + zones.join(',') : 'non-zonal'}</div></div>` +
      `</div>` +
      `<div class="dsec"><h4>Properties</h4><div class="kv">${kv.map(([k, v]) => `<div class="k">${h(k)}</div><div class="v">${h(String(v))}</div>`).join('')}</div></div>` +
      `<div class="dsec"><h4>Tags</h4>${tagKeys.length ? `<div class="chip-row">${tagKeys.map((k) => `<span class="tag-chip">${h(k)}<i>${h(String(tags[k]))}</i></span>`).join('')}</div>` : '<span class="muted">untagged</span>'}</div>` +
      dockWhatsNewHtml(res.type || inv?.type || '') +
      `<div class="dsec"><h4>Resource ID</h4><div class="idbox">${h(d.id)}</div></div>`;
    body.querySelectorAll('.wn-up').forEach((el) => el.addEventListener('click', () => openWnUpdateById((el as HTMLElement).dataset.upId!)));
  } else if (dockTab === 'metrics') {
    renderMetricsTab(body);
  } else if (dockTab === 'cost') {
    renderCostTab(body, d);
  } else if (dockTab === 'changes') {
    lazyDock('changes', body, () => api.resourceChanges(d.id), renderChangesDock);
  } else if (dockTab === 'activity') {
    lazyDock('activity', body, () => api.resourceActivity(d.id), renderActivityDock);
  } else if (dockTab === 'security') {
    lazyDock('security', body, () => api.resourceSecurity(d.id), renderSec);
  } else if (dockTab === 'advisor') {
    lazyDock('advisor', body, () => api.resourceRecommendations(d.id), renderAdv);
  }
}

const METRIC_WINDOWS = ['1h', '6h', '24h', '7d'];
const METRIC_COLORS = ['#44ff88', '#3bd6ff', '#ffaa00', '#ff6b9d', '#a78bfa', '#4ade80'];
function renderMetricsTab(body: HTMLElement) {
  const id = dockId!;
  const win = dockMetricWindow;
  const tabs = `<div class="mwin">${METRIC_WINDOWS.map((w) => `<button class="mwin-btn ${w === win ? 'active' : ''}" data-w="${w}">${w}</button>`).join('')}</div>`;
  const key = `metrics:${id.toLowerCase()}:${win}`;
  const wire = () => body.querySelectorAll('.mwin-btn').forEach((b) => b.addEventListener('click', () => { dockMetricWindow = (b as HTMLElement).dataset.w!; renderMetricsTab(body); }));
  const cached = dockCache.get(key) as MetricsDetailResp | undefined;
  if (cached) { body.innerHTML = tabs + metricsBody(cached); wire(); return; }
  body.innerHTML = tabs + '<div class="dsec"><span class="muted">loading performance metrics\u2026</span></div>';
  wire();
  api.resourceMetrics(id, win).then((m) => {
    if (dockId !== id || dockTab !== 'metrics' || dockMetricWindow !== win) return;
    dockCache.set(key, m);
    body.innerHTML = tabs + metricsBody(m); wire();
  }).catch((err) => { if (dockId === id && dockMetricWindow === win) { body.innerHTML = tabs + `<div class="dsec"><span class="muted">${h(err.message)}</span></div>`; wire(); } });
}
function metricsBody(m: MetricsDetailResp): string {
  if (!m || !m.supported || !m.series?.length) return `<div class="dsec"><span class="muted">${h(m?.reason || 'no metrics for this resource type')}</span></div>`;
  const stale = m._stale ? `<div class="stale-badge">cached snapshot${m._snapshotAt ? ' \u00b7 ' + fmtAgo(new Date(m._snapshotAt).toISOString()) : ''}</div>` : '';
  return stale + m.series.map((s, i) => {
    const color = METRIC_COLORS[i % METRIC_COLORS.length];
    return `<div class="dsec mchart-sec"><h4>${h(s.name)}${s.unit && s.unit !== 'Count' ? ` <span class="muted">(${h(s.unit)})</span>` : ''}</h4>${metricChart({ name: s.name, unit: s.unit, points: s.points, color })}</div>`;
  }).join('');
}
function renderCostTab(body: HTMLElement, d: ResourceDetail): string | void {
  const cur = d.cost?.currency || state.currency;
  if (d.cost?.error) { body.innerHTML = `<div class="dsec"><span class="muted">${h(d.cost.error)}</span></div>`; return; }
  const series = d.cost?.series || [];
  const total = d.cost?.total || 0;
  const days = series.length || 1;
  const avg = total / days;
  const peak = series.reduce((mx, p) => Math.max(mx, p.cost), 0);
  const stats = `<div class="dgrid">` +
    `<div class="dcard dcard-stat"><div class="dstat-v">${money(total, cur)}</div><div class="dstat-l">total \u00b7 ${h(state.range)}</div></div>` +
    `<div class="dcard dcard-stat"><div class="dstat-v">${money(avg, cur)}</div><div class="dstat-l">avg / day</div></div>` +
    `<div class="dcard dcard-stat"><div class="dstat-v">${money(peak, cur)}</div><div class="dstat-l">peak / day</div></div>` +
    `</div>`;
  const chart = series.length
    ? `<div class="dsec"><h4>Daily spend</h4>${columns(series.slice(-30).map((p) => ({ label: String(p.date).slice(5), value: p.cost, color: '#44ff88' })), { height: 90, fmt: (v) => money(v, cur) })}</div>`
    : '<div class="dsec"><span class="muted small">no daily breakdown</span></div>';
  body.innerHTML = stats + chart;
}
function renderChangesDock(r: ChangesResp): string {
  if (!r.supported) return `<div class="dsec"><span class="muted">${h(r.reason || 'change tracking unavailable')}</span></div>`;
  if (!r.changes.length) return `<div class="dsec"><span class="muted">no recorded changes</span></div>`;
  return `<div class="dsec"><h4>Changes \u00b7 ${r.changes.length}</h4><div class="timeline">` + r.changes.map((c) => {
    const ct = (c.changeType || '').toLowerCase();
    const cls = ct === 'create' ? 'sev-low' : ct === 'delete' ? 'sev-high' : 'sev-med';
    const props = (c.props || []).slice(0, 4).map((p) => `<div class="chg-prop"><span class="cp-k">${h(p.name)}</span><span class="cp-v">${h(String(p.from ?? '\u2014'))} \u2192 ${h(String(p.to ?? '\u2014'))}</span></div>`).join('');
    return `<div class="tl-row"><span class="tl-dot ${cls}"></span><div class="tl-body"><div class="tl-top"><span class="tl-op">${h(c.changeType || 'Update')}</span><span class="tl-time">${fmtAgo(c.ts)}</span></div>${c.changedBy ? `<div class="tl-sub">by ${h(c.changedBy)}</div>` : ''}${props}</div></div>`;
  }).join('') + `</div></div>`;
}
function renderActivityDock(r: ActivityResp): string {
  if (!r.supported) return `<div class="dsec"><span class="muted">${h(r.reason || 'activity log unavailable')}</span></div>`;
  if (!r.events.length) return `<div class="dsec"><span class="muted">no activity in the last 7 days</span></div>`;
  return `<div class="dsec"><h4>Activity \u00b7 ${r.events.length}</h4><div class="timeline">` + r.events.map((e) => {
    const lvl = (e.level || '').toLowerCase();
    const cls = lvl === 'error' || lvl === 'critical' ? 'sev-high' : lvl === 'warning' ? 'sev-med' : 'sev-low';
    const okcls = (e.status || '').toLowerCase().includes('succe') ? 'ok' : (e.status || '').toLowerCase().includes('fail') ? 'bad' : '';
    return `<div class="tl-row"><span class="tl-dot ${cls}"></span><div class="tl-body"><div class="tl-top"><span class="tl-op">${h(e.operation || '')}</span><span class="tl-time">${fmtAgo(e.ts)}</span></div><div class="tl-sub">${e.status ? `<span class="f-status ${okcls}">${h(e.status)}</span> \u00b7 ` : ''}${h(e.caller || '')}</div></div></div>`;
  }).join('') + `</div></div>`;
}
async function lazyDock<T>(tab: string, body: HTMLElement, fetcher: () => Promise<T>, render: (d: T) => string) {
  const id = dockId!; const key = `${tab}:${id.toLowerCase()}`;
  if (dockCache.has(key)) { body.innerHTML = render(dockCache.get(key) as T); return; }
  body.innerHTML = '<span class="muted">scanning\u2026</span>';
  try { const data = await fetcher(); if (dockId !== id || dockTab !== tab) return; dockCache.set(key, data); body.innerHTML = render(data); }
  catch (err: any) { body.innerHTML = `<span class="muted">${err.message}</span>`; }
}
function renderSec(s: SecurityResp): string {
  if (!s.supported) return `<div class="dsec"><span class="muted">Defender data unavailable</span></div>`;
  const f = s.findings.filter((x) => x.status !== 'NotApplicable');
  if (!f.length) return `<div class="dsec"><span class="muted">no findings</span></div>`;
  const unhealthy = f.filter((x) => x.status === 'Unhealthy').length;
  return `<div class="dsec"><h4>Defender \u00b7 ${unhealthy} unhealthy / ${f.length}</h4>` + f.map((x) => {
    const ok = x.status === 'Healthy'; const cls = String(x.severity).toLowerCase() === 'high' ? 'sev-high' : String(x.severity).toLowerCase() === 'medium' ? 'sev-med' : 'sev-low';
    return `<div class="finding"><span class="fdot ${cls}"></span><div class="fbody"><div class="ftitle">${h(x.name)}</div>${x.remediation && !ok ? `<div class="fsub">${h(stripTags(x.remediation))}</div>` : ''}</div><span class="f-status ${ok ? 'ok' : 'bad'}">${h(x.status)}</span></div>`;
  }).join('') + `</div>`;
}
function renderAdv(r: RecommendationsResp): string {
  if (!r.supported) return `<div class="dsec"><span class="muted">Advisor unavailable</span></div>`;
  if (!r.recommendations.length) return `<div class="dsec"><span class="muted">no recommendations</span></div>`;
  return `<div class="dsec"><h4>Advisor \u00b7 ${r.recommendations.length}</h4>` + r.recommendations.map((x) => {
    const cls = x.impact === 'High' ? 'sev-high' : x.impact === 'Medium' ? 'sev-med' : 'sev-low';
    return `<div class="finding"><span class="fdot ${cls}"></span><div class="fbody"><div class="ftitle">${h(x.problem)}</div><div class="fsub">${h(x.category)} \u00b7 ${h(x.impact)}</div></div></div>`;
  }).join('') + `</div>`;
}
function costBars(series: { date: string; cost: number }[], cur: string): string {
  if (!series.length) return '<span class="muted small">no daily breakdown</span>';
  const w = 320, ht = 46, n = series.length, max = Math.max(...series.map((s) => s.cost), 0.0001), bw = w / n;
  const bars = series.map((s, i) => { const bh = Math.max(1, (s.cost / max) * (ht - 4)); return `<rect x="${(i * bw).toFixed(1)}" y="${(ht - bh).toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${bh.toFixed(1)}" fill="#44ff88"><title>${s.date}: ${money(s.cost, cur)}</title></rect>`; }).join('');
  return `<svg class="bars-svg" viewBox="0 0 ${w} ${ht}" preserveAspectRatio="none">${bars}</svg>`;
}
function sparkSvg(vals: number[]): string {
  const w = 320, ht = 46, n = vals.length, max = Math.max(...vals), min = Math.min(...vals), rng = max - min || 1;
  const pts = vals.map((v, i) => `${((i / (n - 1 || 1)) * w).toFixed(1)},${(ht - 2 - ((v - min) / rng) * (ht - 6)).toFixed(1)}`).join(' ');
  return `<svg class="spark-svg" viewBox="0 0 ${w} ${ht}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="#3bd6ff" stroke-width="1.4"/></svg>`;
}

// ---- Editions modal -------------------------------------------------------
const EDITIONS = [
  { name: 'Free', price: 'Included', feats: [['World cost map + heatmap + danger zones', true], ['MG \u2192 Sub \u2192 RG \u2192 Resource drill-down', true], ['Availability-zone topology', true], ['Resource detail (props/metrics/cost)', true]] },
  { name: 'Pro', price: 'Translated', feats: [['Live panels: analytics, waste, governance', true], ['AI Insights + anomaly detection', true], ['Per-resource Security (Defender) + Advisor', true], ['Lens presets + layer toggles', true], ['Budgets & alerts (email/Teams)', false]] },
  { name: 'Enterprise', price: 'Roadmap', feats: [['Multi-subscription rollups', true], ['MCP endpoint for Copilot/agents', true], ['Azure Policy tag remediation', false], ['Chargeback / showback', false], ['Entra SSO + RBAC views', false]] },
];
function openEditions() {
  const root = $('modalRoot');
  root.innerHTML = `<div class="modal-backdrop" id="edBack"></div><div class="modal"><h2>Editions</h2><p class="muted">WorldMonitor Pro/Enterprise tiers mapped to Azure FinOps.</p>` +
    `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:12px">${EDITIONS.map((e) => `<div style="border:1px solid var(--border);padding:12px"><div style="font-size:14px;font-weight:700;color:#fff">${e.name}</div><div style="font-size:10px;color:var(--green);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">${e.price}</div>${e.feats.map(([t, on]) => `<div style="font-size:10px;color:${on ? 'var(--text-2)' : 'var(--text-muted)'};padding:3px 0">${on ? '\u2713' : '\u25cb'} ${t}</div>`).join('')}</div>`).join('')}</div></div>`;
  root.classList.remove('hidden');
  $('edBack').addEventListener('click', () => { root.classList.add('hidden'); root.innerHTML = ''; });
}

function showBanner(msg: string) { $('banner').innerHTML = `<div class="banner">${h(msg)}</div>`; }

init();
