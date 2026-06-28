import './styles.css';
import { api } from './api';
import { FinOpsMap, type RegionArc } from './map';
import { money, compactMoney, shortType, resName } from './format';
import type { AppState, RegionAgg, TreeResp, InventoryResource, ResourceDetail, SubPathResp, SummaryResp, AnalyticsResp, OptimizeResp, InsightsResp, AskResp, SecurityResp, RecommendationsResp, ChangesResp, ActivityResp, RegionZonesResp } from './types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const state: AppState = {
  subscriptionId: null,
  range: '30d',
  showLinkage: false,
  currency: 'USD',
  selectedResourceId: null,
};

let map: FinOpsMap;
let regionData: RegionAgg[] = [];
let inventory: InventoryResource[] = [];
const invById = new Map<string, InventoryResource>();
let adjacency = new Map<string, Set<string>>(); // undirected neighbour ids
let linkageLoadedFor: string | null = null;
let treeResp: TreeResp | null = null;
let unassignedCost = 0;
let view: 'map' | 'analytics' | 'optimize' | 'insights' = 'map';
let analyticsLoadedFor: string | null = null;
let optimizeLoadedFor: string | null = null;
let insightsLoadedFor: string | null = null;
const chatLog: { role: 'user' | 'analyst'; text: string }[] = [];

function setStatus(msg: string | null) {
  const el = $('mapStatus');
  if (!msg) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.textContent = msg;
}

async function init() {
  map = new FinOpsMap($('map'));
  map.onRegionClick((r) => { filterTreeByRegion(r.region, r.display); openZoneView(r.region, r.display); });

  $('subPicker').addEventListener('change', (e) => {
    state.subscriptionId = (e.target as HTMLSelectElement).value;
    linkageLoadedFor = null;
    loadAll();
  });
  $('rangePicker').addEventListener('change', (e) => {
    state.range = (e.target as HTMLSelectElement).value;
    loadAll();
  });
  $('linkToggle').addEventListener('change', async (e) => {
    state.showLinkage = (e.target as HTMLInputElement).checked;
    if (state.showLinkage) await ensureLinkage();
    map.setShowLinkage(state.showLinkage);
  });
  $('refreshBtn').addEventListener('click', () => loadAll());
  $('treeSearch').addEventListener('input', () => renderTree());
  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => switchView((t as HTMLElement).dataset.view as 'map' | 'analytics' | 'optimize' | 'insights')));
  $('editionsBtn').addEventListener('click', openEditions);

  try {
    const ctx = await api.context();
    const picker = $<HTMLSelectElement>('subPicker');
    picker.innerHTML = '';
    for (const s of ctx.subscriptions) {
      const o = document.createElement('option');
      o.value = s.subscriptionId;
      o.textContent = s.displayName;
      picker.appendChild(o);
    }
    state.subscriptionId = ctx.defaultSubscriptionId || ctx.subscriptions[0]?.subscriptionId || null;
    if (state.subscriptionId) picker.value = state.subscriptionId;
    if (ctx.user) { const u = $('userName'); if (u) u.textContent = ctx.user; }
    $('footerCtx').textContent =
      `${ctx.user ? ctx.user + ' · ' : ''}${ctx.subscriptions.length} subscription${ctx.subscriptions.length === 1 ? '' : 's'} · cost cache: ${ctx.sqlCache ? 'on' : 'off (live API)'}`;
    await loadAll();
    // Deep-link: ?region=westeurope opens that region's availability-zone view.
    const rp = new URLSearchParams(location.search).get('region');
    if (rp) {
      const rd = regionData.find((r) => r.region === rp.toLowerCase());
      openZoneView(rp.toLowerCase(), rd?.display || rp);
    }
  } catch (err: any) {
    setStatus(null);
    showBanner(`Could not reach Azure: ${err.message}`);
  }
}

async function loadAll() {
  if (!state.subscriptionId) return;
  const sub = state.subscriptionId;
  state.selectedResourceId = null;
  setStatus('Loading resources & cost…');
  clearDetail();
  closeZoneView();
  api.subPath(sub).then(renderMgPath).catch(() => { $('mgPath').innerHTML = ''; });
  loadSummary(sub);
  analyticsLoadedFor = null;
  optimizeLoadedFor = null;
  insightsLoadedFor = null;
  if (view === 'analytics') loadAnalytics();
  else if (view === 'optimize') loadOptimize();
  else if (view === 'insights') loadInsights();
  try {
    const [regionsResp, tree] = await Promise.all([
      api.regions(sub, state.range),
      api.tree(sub, state.range),
    ]);
    if (state.subscriptionId !== sub) return; // changed while loading
    state.currency = regionsResp.currency || 'USD';
    regionData = regionsResp.regions;
    unassignedCost = regionsResp.unassignedCost || 0;
    treeResp = tree;
    map.setRegions(regionData, state.currency);
    renderTree();
    renderLegend(regionsResp.costError);
    setStatus(regionData.length ? null : 'No resources found in this subscription.');
    if (state.showLinkage) { await ensureLinkage(); map.setShowLinkage(true); }
  } catch (err: any) {
    setStatus(`Error: ${err.message}`);
  }
}

function renderLegend(costError?: string | null) {
  const regionCost = regionData.reduce((s, r) => s + r.cost, 0);
  const totalCost = regionCost + unassignedCost;
  const totalRes = regionData.reduce((s, r) => s + r.count, 0);
  $('mapLegend').innerHTML =
    `<b>${compactMoney(totalCost, state.currency)}</b> total · <b>${totalRes}</b> resources · ${regionData.length} regions` +
    (unassignedCost > 0.005 ? `<br/><span style="opacity:.85">${compactMoney(unassignedCost, state.currency)} unassigned / non-regional</span>` : '') +
    (costError ? `<br/><span style="color:#ffb3b3">cost unavailable: ${escapeHtml(costError)}</span>` : '') +
    `<br/><span style="opacity:.7">bubble size &amp; colour = cost · click a region for its 3 availability zones</span>`;
}

function renderMgPath(p: SubPathResp) {
  const el = $('mgPath');
  if (!p || (!p.managementGroups?.length && !p.subscription)) { el.innerHTML = ''; return; }
  const crumbs = [
    ...(p.managementGroups || []).map((m) => ({ label: m.displayName, cls: 'mg' })),
    { label: p.subscription?.name || '', cls: 'sub' },
  ];
  el.innerHTML = crumbs
    .map((c) => `<span class="crumb ${c.cls}">${escapeHtml(c.label)}</span>`)
    .join('<span class="crumb-sep">›</span>');
}

// ---- tree ----------------------------------------------------------------
let regionFilter: string | null = null;

function filterTreeByRegion(region: string, display: string) {
  regionFilter = regionFilter === region ? null : region;
  $('treeTitle').textContent = regionFilter ? `Resources · ${display}` : 'Resources';
  renderTree();
}

// ---- Availability-zone region view ---------------------------------------
let zoneRegion: string | null = null;

async function openZoneView(region: string, display: string) {
  zoneRegion = region;
  const host = $('zoneView');
  host.classList.remove('hidden');
  host.innerHTML =
    `<div class="zone-head"><button class="btn-ghost" id="zoneBack">\u2190 Map</button>` +
    `<div class="zone-titlewrap"><div class="zone-title">${escapeHtml(display)} \u00b7 Availability Zones</div>` +
    `<div class="zone-sub muted">Loading zone topology\u2026</div></div></div>`;
  $('zoneBack').addEventListener('click', closeZoneView);
  try {
    const sub = state.subscriptionId!;
    const z = await api.regionZones(sub, region, state.range);
    if (zoneRegion !== region) return;
    renderZoneView(z, display);
  } catch (err: any) {
    const sub = host.querySelector('.zone-sub');
    if (sub) sub.textContent = `Error: ${err.message}`;
  }
}

function closeZoneView() {
  zoneRegion = null;
  $('zoneView').classList.add('hidden');
  $('zoneView').innerHTML = '';
}

const DC_SVG = `<svg class="dc-svg" viewBox="0 0 48 40" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.6"><rect x="8" y="4" width="32" height="9" rx="1.5"/><rect x="8" y="15.5" width="32" height="9" rx="1.5"/><rect x="8" y="27" width="32" height="9" rx="1.5"/></g><g fill="currentColor"><circle cx="12.5" cy="8.5" r="1.3"/><circle cx="12.5" cy="20" r="1.3"/><circle cx="12.5" cy="31.5" r="1.3"/><rect x="30" y="7.4" width="7" height="2.2" rx="1"/><rect x="30" y="18.9" width="7" height="2.2" rx="1"/><rect x="30" y="30.4" width="7" height="2.2" rx="1"/></g></svg>`;

function renderZoneView(z: RegionZonesResp, display: string) {
  const host = $('zoneView');
  const cur = z.currency;
  const zonedCount = z.zones.filter((b) => b.zone !== 'none').reduce((s, b) => s + b.count, 0);
  const banner = zonedCount === 0
    ? `<div class="zone-banner warn">\u26a0 None of the ${z.count} resources in ${escapeHtml(display)} are pinned to an availability zone \u2014 they run in a single regional footprint. Consider zonal or zone-redundant deployment for critical workloads.</div>`
    : `<div class="zone-banner ok">${zonedCount} of ${z.count} resources are zone-pinned for higher resiliency.</div>`;
  const cards = z.zones.map((b) => {
    const isRegional = b.zone === 'none';
    const title = isRegional ? 'Regional / non-zonal' : `Zone ${b.zone}`;
    const sub = isRegional ? 'No specific zone assigned' : 'Independent physical datacenter';
    const chips = b.resources.slice(0, 60).map((r) =>
      `<button class="zres" data-id="${escapeHtml(r.id)}" title="${escapeHtml(r.name)} \u00b7 ${escapeHtml(shortType(r.type))} \u00b7 ${money(r.cost, cur)}">` +
      `<span class="zres-name">${escapeHtml(r.name)}</span>` +
      (r.zoneRedundant ? `<span class="zr-badge" title="Zone-redundant">ZR</span>` : '') +
      `<span class="zres-cost">${compactMoney(r.cost, cur)}</span></button>`).join('');
    return `<div class="az-card ${isRegional ? 'az-regional' : 'az-' + b.zone}">` +
      `<div class="az-top"><div class="dc-icon">${DC_SVG}</div><div class="az-meta"><div class="az-name">${title}</div>` +
      `<div class="az-sub muted">${sub}</div></div></div>` +
      `<div class="az-stats"><span><b>${b.count}</b> resources</span><span class="az-cost">${money(b.cost, cur)}</span></div>` +
      `<div class="zres-list">${chips || '<div class="muted small" style="padding:10px">No resources in this zone.</div>'}</div></div>`;
  }).join('');
  host.innerHTML =
    `<div class="zone-head"><button class="btn-ghost" id="zoneBack">\u2190 Map</button>` +
    `<div class="zone-titlewrap"><div class="zone-title">${escapeHtml(display)} \u00b7 Availability Zones</div>` +
    `<div class="zone-sub muted">${z.count} resources \u00b7 ${money(z.total, cur)} / period \u00b7 3 zones = 3 physically separate datacenters</div></div></div>` +
    banner +
    `<div class="zone-grid">${cards}</div>`;
  $('zoneBack').addEventListener('click', closeZoneView);
  host.querySelectorAll('.zres').forEach((b) =>
    b.addEventListener('click', () => { closeZoneView(); selectResource((b as HTMLElement).dataset.id!); }));
}

function renderTree() {
  if (!treeResp) return;
  const term = $<HTMLInputElement>('treeSearch').value.trim().toLowerCase();
  const host = $('tree');
  host.innerHTML = '';
  let shownCost = 0;

  for (const rg of treeResp.tree.children) {
    // Leaf node with no child resources (e.g. unassigned / shared cost).
    if (!rg.children.length) {
      if (term || regionFilter || rg.cost <= 0) continue;
      shownCost += rg.cost;
      const group = document.createElement('div');
      group.className = 'tree-group';
      const head = document.createElement('div');
      head.className = 'tree-rg';
      head.innerHTML =
        `<span class="rg-name"><span class="chev">▪</span>${escapeHtml(rg.name)}</span>` +
        `<span class="cost">${money(rg.cost, treeResp!.currency)}</span>`;
      group.appendChild(head);
      host.appendChild(group);
      continue;
    }
    const children = rg.children.filter((r) => {
      if (regionFilter && r.location !== regionFilter) return false;
      if (term && !(r.name.toLowerCase().includes(term) || r.resourceType.includes(term))) return false;
      return true;
    });
    if (!children.length) continue;
    const rgCost = children.reduce((s, r) => s + r.cost, 0);
    shownCost += rgCost;

    const group = document.createElement('div');
    group.className = 'tree-group';
    const head = document.createElement('div');
    head.className = 'tree-rg';
    head.innerHTML =
      `<span class="rg-name"><span class="chev">▸</span>${escapeHtml(rg.name)}</span>` +
      `<span class="cost">${money(rgCost, treeResp.currency)}</span>`;
    head.addEventListener('click', () => group.classList.toggle('open'));
    group.appendChild(head);

    const kids = document.createElement('div');
    kids.className = 'tree-children';
    for (const r of children) {
      const row = document.createElement('div');
      row.className = 'tree-res' + (r.id === state.selectedResourceId ? ' selected' : '');
      row.dataset.id = r.id;
      row.innerHTML =
        `<span class="res-name">${escapeHtml(r.name)}<br/><span class="res-sub">${escapeHtml(shortType(r.resourceType))} · ${r.location}</span></span>` +
        `<span class="cost">${money(r.cost, treeResp!.currency)}</span>`;
      row.addEventListener('click', () => selectResource(r.id));
      kids.appendChild(row);
    }
    group.appendChild(kids);
    if (term || regionFilter) group.classList.add('open');
    host.appendChild(group);
  }
  $('treeTotal').textContent = compactMoney(shownCost, treeResp.currency);
  if (!host.children.length) host.innerHTML = '<div class="muted" style="padding:12px">No matching resources.</div>';
}

// ---- linkage -------------------------------------------------------------
async function ensureLinkage() {
  const sub = state.subscriptionId!;
  if (linkageLoadedFor === sub) return;
  setStatus('Computing resource linkage…');
  try {
    const [inv, link] = await Promise.all([api.inventory(sub), api.linkage(sub)]);
    inventory = inv.resources;
    invById.clear();
    for (const r of inventory) invById.set(r.id.toLowerCase(), r);
    adjacency = new Map();
    const addAdj = (a: string, b: string) => {
      if (!adjacency.has(a)) adjacency.set(a, new Set());
      adjacency.get(a)!.add(b);
    };
    // region-pair arc aggregation
    const regionCoord = new Map<string, [number, number]>();
    for (const r of regionData) if (r.lat != null && r.lon != null) regionCoord.set(r.region, [r.lon, r.lat]);
    const arcCounts = new Map<string, number>();
    for (const e of link.edges) {
      const a = e.from.toLowerCase(), b = e.to.toLowerCase();
      addAdj(a, b); addAdj(b, a);
      const ra = invById.get(a)?.location, rb = invById.get(b)?.location;
      if (ra && rb && ra !== rb && regionCoord.has(ra) && regionCoord.has(rb)) {
        const key = [ra, rb].sort().join('|');
        arcCounts.set(key, (arcCounts.get(key) || 0) + 1);
      }
    }
    const arcs: RegionArc[] = [];
    for (const [key, count] of arcCounts) {
      const [ra, rb] = key.split('|');
      arcs.push({ from: regionCoord.get(ra)!, to: regionCoord.get(rb)!, count });
    }
    map.setArcs(arcs);
    linkageLoadedFor = sub;
    setStatus(null);
  } catch (err: any) {
    setStatus(`Linkage error: ${err.message}`);
  }
}

// ---- detail --------------------------------------------------------------
function clearDetail() {
  const d = $('detail');
  d.className = 'detail detail-empty';
  d.innerHTML = '<div class="detail-placeholder">Select a resource on the map or in the tree to see properties, metrics and cost.</div>';
}

async function selectResource(id: string) {
  state.selectedResourceId = id;
  document.querySelectorAll('.tree-res.selected').forEach((e) => e.classList.remove('selected'));
  const row = document.querySelector(`.tree-res[data-id="${cssEscape(id)}"]`);
  if (row) { row.classList.add('selected'); (row.closest('.tree-group') as HTMLElement)?.classList.add('open'); }

  const d = $('detail');
  d.className = 'detail';
  d.innerHTML = `<div class="detail-head"><div class="res-title">${escapeHtml(resName(id))}</div><div class="res-type">Loading…</div></div>`;
  try {
    const detail = await api.resource(id, state.range);
    if (state.selectedResourceId !== id) return;
    renderDetail(detail);
  } catch (err: any) {
    d.innerHTML = `<div class="detail-head"><div class="res-title">${escapeHtml(resName(id))}</div></div><div class="detail-section"><span class="muted">Error: ${escapeHtml(err.message)}</span></div>`;
  }
}

// ---- detail (tabbed) -----------------------------------------------------
let currentDetail: ResourceDetail | null = null;
type DetailTab = 'overview' | 'cost' | 'metrics' | 'security' | 'advisor' | 'changes' | 'activity' | 'connections';
let detailTab: DetailTab = 'overview';
const detailExtras = new Map<string, unknown>(); // `${tab}:${id}` -> data

const DETAIL_TABS: { id: DetailTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'cost', label: 'Cost' },
  { id: 'metrics', label: 'Monitoring' },
  { id: 'security', label: 'Security' },
  { id: 'advisor', label: 'Advisor' },
  { id: 'changes', label: 'Changes' },
  { id: 'activity', label: 'Activity' },
  { id: 'connections', label: 'Connections' },
];

function renderDetail(d: ResourceDetail) {
  currentDetail = d;
  detailTab = 'overview';
  const res = d.resource || {};
  const inv = invById.get(d.id.toLowerCase());
  const typeStr = shortType((res.type || inv?.type || '').toLowerCase());
  const health = d.health?.state;
  const hl = (health || '').toLowerCase();
  const healthCls = hl === 'available' ? 'ok' : hl === 'unavailable' ? 'bad' : hl ? 'warn' : '';
  const healthBadge = health ? `<span class="health-badge ${healthCls}" title="${escapeHtml(d.health?.summary || '')}">${escapeHtml(health)}</span>` : '';
  const tabs = DETAIL_TABS.map((t) =>
    `<button class="dtab ${t.id === detailTab ? 'active' : ''}" data-tab="${t.id}">${t.label}</button>`).join('');
  $('detail').innerHTML =
    `<div class="detail-head">` +
    `<div class="res-title">${escapeHtml(res.name || resName(d.id))}</div>` +
    `<div class="res-type">${escapeHtml(typeStr)}${healthBadge}</div>` +
    `</div>` +
    `<div class="dtabs">${tabs}</div>` +
    `<div id="detailBody" class="detail-body"></div>`;
  $('detail').querySelectorAll('.dtab').forEach((b) =>
    b.addEventListener('click', () => switchDetailTab((b as HTMLElement).dataset.tab as DetailTab)));
  renderDetailTab();
}

function switchDetailTab(tab: DetailTab) {
  detailTab = tab;
  $('detail').querySelectorAll('.dtab').forEach((b) =>
    b.classList.toggle('active', (b as HTMLElement).dataset.tab === tab));
  renderDetailTab();
}

function renderDetailTab() {
  const d = currentDetail;
  if (!d) return;
  const body = document.getElementById('detailBody');
  if (!body) return;
  switch (detailTab) {
    case 'overview': body.innerHTML = detailOverview(d); break;
    case 'cost': body.innerHTML = detailCost(d); break;
    case 'metrics': body.innerHTML = `<div class="detail-section"><h3>Performance metrics</h3>${renderMetrics(d)}</div>`; break;
    case 'connections':
      body.innerHTML = `<div class="detail-section"><h3>Linked resources</h3>${renderLinkage(d.id)}</div>`;
      wireDetailLinks(body);
      break;
    case 'security': lazyTab(d.id, 'security', body, () => api.resourceSecurity(d.id), renderSecurity); break;
    case 'advisor': lazyTab(d.id, 'advisor', body, () => api.resourceRecommendations(d.id), renderRecommendations); break;
    case 'changes': lazyTab(d.id, 'changes', body, () => api.resourceChanges(d.id), renderChanges); break;
    case 'activity': lazyTab(d.id, 'activity', body, () => api.resourceActivity(d.id), renderActivity); break;
  }
}

async function lazyTab<T>(id: string, tab: DetailTab, body: HTMLElement, fetcher: () => Promise<T>, render: (d: T) => string) {
  const key = `${tab}:${id.toLowerCase()}`;
  if (detailExtras.has(key)) { body.innerHTML = render(detailExtras.get(key) as T); wireDetailLinks(body); return; }
  body.innerHTML = `<div class="detail-section"><div class="muted">Loading…</div></div>`;
  try {
    const data = await fetcher();
    if (currentDetail?.id !== id || detailTab !== tab) return; // user moved on
    detailExtras.set(key, data);
    body.innerHTML = render(data);
    wireDetailLinks(body);
  } catch (err: any) {
    body.innerHTML = `<div class="detail-section"><span class="muted">Error: ${escapeHtml(err.message)}</span></div>`;
  }
}

function wireDetailLinks(body: HTMLElement) {
  body.querySelectorAll('a[data-id]').forEach((a) => a.addEventListener('click', () => selectResource((a as HTMLElement).dataset.id!)));
}

function detailOverview(d: ResourceDetail): string {
  const res = d.resource || {};
  const props = res.properties || {};
  const inv = invById.get(d.id.toLowerCase());
  const sku = res.sku ? (res.sku.name || JSON.stringify(res.sku)) : (inv?.sku as any)?.name;
  const tags = res.tags || inv?.tags || {};
  const zones = inv?.zones || [];
  const kv: [string, string][] = [];
  if (res.location || inv?.location) kv.push(['Location', res.location || inv?.location || '']);
  if (inv?.resourceGroup) kv.push(['Resource group', inv.resourceGroup]);
  kv.push(['Availability zone', zones.length ? zones.join(', ') : 'Non-zonal (regional)']);
  if (res.kind || inv?.kind) kv.push(['Kind', res.kind || inv?.kind || '']);
  if (sku) kv.push(['SKU', sku]);
  if (props.provisioningState) kv.push(['Provisioning', props.provisioningState]);
  for (const k of ['hardwareProfile', 'tier', 'state', 'status']) if (props[k] && typeof props[k] === 'string') kv.push([k, props[k]]);
  const tagKeys = Object.keys(tags || {});
  const tagHtml = tagKeys.length
    ? `<div class="detail-section"><h3>Tags</h3><div class="kv">` +
      tagKeys.map((k) => `<div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(String(tags[k]))}</div>`).join('') + `</div></div>`
    : `<div class="detail-section"><h3>Tags</h3><div class="muted">No tags — cost can’t be allocated to an owner / cost-center.</div></div>`;
  return `<div class="detail-section"><h3>Properties</h3><div class="kv">` +
    kv.map(([k, v]) => `<div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(String(v))}</div>`).join('') +
    `</div></div>` + tagHtml +
    `<div class="detail-section"><div class="muted small">Resource ID</div><div class="idbox">${escapeHtml(d.id)}</div></div>`;
}

function detailCost(d: ResourceDetail): string {
  const currency = d.cost?.currency || state.currency;
  const totalCost = d.cost?.total ?? 0;
  return `<div class="detail-section"><h3>Cost (period)</h3>` +
    (d.cost?.error
      ? `<div class="muted">Cost unavailable: ${escapeHtml(d.cost.error)}</div>`
      : `<div><span class="cost-big">${money(totalCost, currency)}</span><span class="cost-cur">${currency}</span></div>` + costBars(d.cost?.series || [], currency)) +
    `</div>`;
}

const SEV_CLS: Record<string, string> = { high: 'sev-high', medium: 'sev-med', low: 'sev-low' };
function renderSecurity(s: SecurityResp): string {
  if (!s.supported) return `<div class="detail-section"><div class="muted">Security data unavailable: ${escapeHtml(s.reason || '')}. Microsoft Defender for Cloud may not be enabled.</div></div>`;
  const findings = s.findings.filter((f) => f.status !== 'NotApplicable');
  if (!findings.length) return `<div class="detail-section"><div class="muted">No security findings 🎉</div></div>`;
  const unhealthy = findings.filter((f) => f.status === 'Unhealthy').length;
  const items = findings.map((f) => {
    const cls = SEV_CLS[String(f.severity).toLowerCase()] || 'sev-low';
    const ok = f.status === 'Healthy';
    return `<div class="finding-row ${ok ? 'healthy' : ''}"><span class="sev-dot ${cls}"></span>` +
      `<div class="f-main"><div class="f-name">${escapeHtml(f.name)}</div>` +
      (f.remediation && !ok ? `<div class="f-sub">${escapeHtml(stripTags(f.remediation))}</div>` : '') + `</div>` +
      `<span class="f-status ${ok ? 'ok' : 'bad'}">${escapeHtml(f.status)}</span></div>`;
  }).join('');
  return `<div class="detail-section"><h3>Defender for Cloud · ${unhealthy} unhealthy of ${findings.length}</h3><div class="finding-list">${items}</div></div>`;
}

function renderRecommendations(r: RecommendationsResp): string {
  if (!r.supported) return `<div class="detail-section"><div class="muted">Advisor unavailable: ${escapeHtml(r.reason || '')}.</div></div>`;
  if (!r.recommendations.length) return `<div class="detail-section"><div class="muted">No Advisor recommendations.</div></div>`;
  const items = r.recommendations.map((x) => {
    const cls = x.impact === 'High' ? 'sev-high' : x.impact === 'Medium' ? 'sev-med' : 'sev-low';
    return `<div class="rec-row"><span class="rec-cat ${cls}">${escapeHtml(x.category)}</span>` +
      `<div class="f-main"><div class="f-name">${escapeHtml(x.problem)}</div>` +
      (x.solution ? `<div class="f-sub">${escapeHtml(x.solution)}</div>` : '') + `</div></div>`;
  }).join('');
  return `<div class="detail-section"><h3>Azure Advisor · ${r.recommendations.length}</h3><div class="finding-list">${items}</div></div>`;
}

function renderChanges(c: ChangesResp): string {
  if (!c.supported) return `<div class="detail-section"><div class="muted">Change history unavailable: ${escapeHtml(c.reason || '')}.</div></div>`;
  if (!c.changes.length) return `<div class="detail-section"><div class="muted">No changes recorded in the last ~14 days.</div></div>`;
  const items = c.changes.map((ch) => {
    const props = (ch.props || []).map((p) =>
      `<div class="chg-prop"><span class="chg-k">${escapeHtml(p.name || '')}</span><span class="chg-v">${escapeHtml(String(p.from ?? '∅'))} → ${escapeHtml(String(p.to ?? '∅'))}</span></div>`).join('');
    return `<div class="tl-row"><div class="tl-dot ${escapeHtml((ch.changeType || '').toLowerCase())}"></div><div class="tl-main">` +
      `<div class="tl-head"><b>${escapeHtml(ch.changeType)}</b><span class="muted">${fmtTime(ch.ts)}</span></div>` +
      (ch.changedBy ? `<div class="muted small">by ${escapeHtml(ch.changedBy)}</div>` : '') + props + `</div></div>`;
  }).join('');
  return `<div class="detail-section"><h3>Change history</h3><div class="timeline">${items}</div></div>`;
}

function renderActivity(a: ActivityResp): string {
  if (!a.supported) return `<div class="detail-section"><div class="muted">Activity log unavailable: ${escapeHtml(a.reason || '')}.</div></div>`;
  if (!a.events.length) return `<div class="detail-section"><div class="muted">No activity in the last 7 days.</div></div>`;
  const items = a.events.map((e) => {
    const lvl = String(e.level || '').toLowerCase();
    const cls = lvl === 'error' || lvl === 'critical' ? 'bad' : lvl === 'warning' ? 'warn' : 'ok';
    return `<div class="tl-row"><div class="tl-dot ${cls}"></div><div class="tl-main">` +
      `<div class="tl-head"><b>${escapeHtml(e.operation)}</b><span class="muted">${fmtTime(e.ts)}</span></div>` +
      `<div class="muted small">${escapeHtml(e.status)}${e.caller ? ' · ' + escapeHtml(e.caller) : ''}</div></div></div>`;
  }).join('');
  return `<div class="detail-section"><h3>Activity (7 days)</h3><div class="timeline">${items}</div></div>`;
}

function fmtTime(ts: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function renderMetrics(d: ResourceDetail): string {
  const m = d.metrics;
  if (!m || !m.supported) return `<div class="muted">${escapeHtml(m?.reason || 'No metrics available for this resource type.')}</div>`;
  if (!m.series.length) return `<div class="muted">No metric data in the selected window.</div>`;
  return m.series.map((s) => {
    const vals = s.points.map((p) => p.v).filter((v): v is number => v != null);
    if (!vals.length) return '';
    const last = vals[vals.length - 1];
    const max = Math.max(...vals);
    return `<div class="metric"><div class="m-name"><span>${escapeHtml(s.name)}</span><b>${fmtMetric(last)} ${escapeHtml(s.unit || '')}</b></div>${sparkline(vals)}<div class="muted">max ${fmtMetric(max)}</div></div>`;
  }).join('') || '<div class="muted">No metric data.</div>';
}

function renderLinkage(id: string): string {
  const neighbours = adjacency.get(id.toLowerCase());
  if (!linkageLoadedFor) return `<div class="muted">Enable “Show linkage” in the top bar to load resource relationships.</div>`;
  if (!neighbours || !neighbours.size) return `<div class="muted">No linked resources detected.</div>`;
  const items = [...neighbours].slice(0, 30).map((nid) => {
    const r = invById.get(nid);
    const label = r ? `${r.name} · ${shortType(r.type)}` : resName(nid);
    return `<div><a data-id="${escapeHtml(r?.id || nid)}">${escapeHtml(label)}</a></div>`;
  }).join('');
  return `<div class="linkage-list">${items}${neighbours.size > 30 ? `<div class="muted">+${neighbours.size - 30} more</div>` : ''}</div>`;
}

// ---- mini charts ---------------------------------------------------------
function costBars(series: { date: string; cost: number }[], currency: string): string {
  if (!series.length) return '<div class="muted">No daily breakdown.</div>';
  const w = 320, h = 48, n = series.length;
  const max = Math.max(...series.map((s) => s.cost), 0.0001);
  const bw = w / n;
  const bars = series.map((s, i) => {
    const bh = Math.max(1, (s.cost / max) * (h - 4));
    return `<rect x="${(i * bw).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${bh.toFixed(1)}" fill="#0078d4"><title>${s.date}: ${money(s.cost, currency)}</title></rect>`;
  }).join('');
  return `<svg class="bars" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${bars}</svg>`;
}

function sparkline(vals: number[]): string {
  const w = 320, h = 48, n = vals.length;
  const max = Math.max(...vals), min = Math.min(...vals);
  const rng = max - min || 1;
  const pts = vals.map((v, i) => `${((i / (n - 1 || 1)) * w).toFixed(1)},${(h - 2 - ((v - min) / rng) * (h - 6)).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="#0078d4" stroke-width="1.5"/></svg>`;
}

function fmtMetric(v: number): string {
  if (v == null || isNaN(v)) return '—';
  if (Math.abs(v) >= 1000) return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
  return Number(v.toFixed(2)).toString();
}

// ---- utils ---------------------------------------------------------------
function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
function stripTags(s: string): string {
  return String(s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}
function cssEscape(s: string): string {
  return (window as any).CSS?.escape ? (window as any).CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
}
function showBanner(msg: string) {
  const existing = document.querySelector('.banner');
  if (existing) existing.remove();
  const b = document.createElement('div');
  b.className = 'banner';
  b.textContent = msg;
  document.querySelector('.layout')?.before(b);
}

// ---- views (Map | Analytics | Optimize) ----------------------------------
function switchView(v: 'map' | 'analytics' | 'optimize' | 'insights') {
  view = v;
  for (const name of ['map', 'analytics', 'optimize', 'insights']) {
    $(`view-${name}`).classList.toggle('hidden', name !== v);
  }
  document.querySelectorAll('.tab').forEach((t) =>
    t.classList.toggle('active', (t as HTMLElement).dataset.view === v));
  if (v === 'analytics') loadAnalytics();
  else if (v === 'optimize') loadOptimize();
  else if (v === 'insights') loadInsights();
}

function selectFromOtherView(id: string) {
  switchView('map');
  selectResource(id);
}

// ---- KPI summary bar -----------------------------------------------------
async function loadSummary(sub: string) {
  try {
    const s = await api.summary(sub, state.range);
    if (state.subscriptionId !== sub) return;
    renderKpis(s);
  } catch {
    $('kpibar').innerHTML = '';
  }
}

function renderKpis(s: SummaryResp) {
  const cur = s.currency;
  const delta = s.deltaPct == null ? ''
    : ` · <span class="${s.deltaPct >= 0 ? 'up' : 'down'}">${s.deltaPct >= 0 ? '▲' : '▼'} ${Math.abs(s.deltaPct).toFixed(0)}%</span>`;
  const cards = [
    { label: 'Total spend', value: compactMoney(s.totalCost, cur), sub: `${s.days}d${delta}` },
    { label: 'Daily burn', value: compactMoney(s.dailyBurn, cur), sub: 'avg / day' },
    { label: 'Forecast', value: compactMoney(s.forecast30, cur), sub: '30-day run-rate' },
    { label: 'Resources', value: String(s.resourceCount), sub: `${s.regionCount} regions · ${s.rgCount} RGs` },
    { label: 'Top service', value: s.topService ? compactMoney(s.topService.cost, cur) : '—', sub: s.topService ? escapeHtml(s.topService.name) : '' },
    { label: 'Tag coverage', value: `${Math.round(s.taggedPct)}%`, sub: `${s.untaggedCount} untagged` },
  ];
  $('kpibar').innerHTML = cards.map((c) =>
    `<div class="kpi"><div class="kpi-label">${c.label}</div><div class="kpi-value">${c.value}</div><div class="kpi-sub">${c.sub}</div></div>`).join('');
}

// ---- Analytics view ------------------------------------------------------
async function loadAnalytics() {
  const sub = state.subscriptionId;
  if (!sub) return;
  const key = `${sub}:${state.range}`;
  if (analyticsLoadedFor === key) return;
  $('view-analytics').innerHTML = '<div class="muted" style="padding:20px">Loading analytics…</div>';
  try {
    const d = await api.analytics(sub, state.range);
    if (state.subscriptionId !== sub) return;
    analyticsLoadedFor = key;
    renderAnalytics(d);
  } catch (err: any) {
    $('view-analytics').innerHTML = `<div class="muted" style="padding:20px">Error: ${escapeHtml(err.message)}</div>`;
  }
}

function renderAnalytics(d: AnalyticsResp) {
  const cur = d.currency;
  const svc = hbars(d.byService, cur);
  const typ = hbars(d.byType.map((t) => ({ name: shortType(t.name), cost: t.cost })), cur);
  const rows = d.topResources.map((r) =>
    `<tr class="clickable" data-id="${escapeHtml(r.id)}"><td>${escapeHtml(r.name)}</td><td>${escapeHtml(shortType(r.type))}</td><td>${escapeHtml(r.location)}</td><td class="num">${money(r.cost, cur)}</td></tr>`).join('');
  $('view-analytics').innerHTML =
    `<div class="view-toolbar"><h2>Analytics</h2><div class="toolbar-actions">` +
    `<button class="btn-ghost" id="anExportCsv">Export CSV</button>` +
    `<button class="btn-ghost" id="anExportJson">Export JSON</button></div></div>` +
    `<div class="charts-grid">` +
    `<div class="card full"><h3>Daily spend trend</h3>${trendArea(d.trend, cur)}</div>` +
    `<div class="card"><h3>Cost by service</h3>${svc}</div>` +
    `<div class="card"><h3>Cost by resource type</h3>${typ}</div>` +
    `<div class="card full"><h3>Top resources by cost</h3><table class="tbl"><thead><tr><th>Resource</th><th>Type</th><th>Region</th><th class="num">Cost</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="muted">No cost data.</td></tr>'}</tbody></table></div>` +
    `</div>`;
  $('view-analytics').querySelectorAll('tr.clickable').forEach((tr) =>
    tr.addEventListener('click', () => selectFromOtherView((tr as HTMLElement).dataset.id!)));
  $('anExportCsv').addEventListener('click', () => {
    const lines = [['section', 'name', 'cost'].join(',')];
    for (const t of d.trend) lines.push(['trend', t.date, t.cost].join(','));
    for (const s of d.byService) lines.push(['service', csv(s.name), s.cost].join(','));
    for (const t of d.byType) lines.push(['type', csv(t.name), t.cost].join(','));
    for (const r of d.topResources) lines.push(['resource', csv(r.name), r.cost].join(','));
    download(`analytics-${state.range}.csv`, lines.join('\n'), 'text/csv');
  });
  $('anExportJson').addEventListener('click', () =>
    download(`analytics-${state.range}.json`, JSON.stringify(d, null, 2), 'application/json'));
}

// ---- Optimize view -------------------------------------------------------
async function loadOptimize() {
  const sub = state.subscriptionId;
  if (!sub) return;
  const key = `${sub}:${state.range}`;
  if (optimizeLoadedFor === key) return;
  $('view-optimize').innerHTML = '<div class="muted" style="padding:20px">Scanning for waste & governance gaps…</div>';
  try {
    const d = await api.optimize(sub, state.range);
    if (state.subscriptionId !== sub) return;
    optimizeLoadedFor = key;
    renderOptimize(d);
  } catch (err: any) {
    $('view-optimize').innerHTML = `<div class="muted" style="padding:20px">Error: ${escapeHtml(err.message)}</div>`;
  }
}

function renderOptimize(d: OptimizeResp) {
  const cur = d.currency;
  const all = [...d.findings, d.untagged];
  const cards = all.map((f) => {
    const list = (f.resources || []).slice(0, 12).map((r) =>
      `<div class="f-item"><a data-id="${escapeHtml(r.id)}" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</a><span>${money(r.monthlyCost, cur)}/mo</span></div>`).join('');
    return `<div class="finding ${f.count === 0 ? 'zero' : ''}"><div class="f-label">${escapeHtml(f.label)}</div>` +
      `<div class="f-stat"><span class="f-count">${f.count}</span><span class="f-cost">${money(f.monthlyCost, cur)}/mo</span></div>` +
      `<div class="f-list">${list || '<span class="muted">None found 🎉</span>'}</div></div>`;
  }).join('');
  const g = d.governance;
  $('view-optimize').innerHTML =
    `<div class="view-toolbar"><h2>Optimize</h2><div class="toolbar-actions">` +
    `<button class="btn-ghost" id="optExportCsv">Export CSV</button></div></div>` +
    `<div class="opt-head"><div><div class="muted">Estimated monthly savings (orphaned / idle resources)</div>` +
    `<div class="opt-savings">${money(d.estimatedMonthlySavings, cur)}/mo</div></div></div>` +
    `<div class="findings-grid">${cards}</div>` +
    `<div class="card full" style="margin-top:16px"><h3>Tag governance</h3><div class="gov-grid">` +
    `<div class="gov-stat"><div class="g-val">${Math.round(g.taggedPct)}%</div><div class="g-lbl">Tagged (${g.tagged}/${g.total})</div></div>` +
    `<div class="gov-stat"><div class="g-val">${g.missingOwner}</div><div class="g-lbl">Missing <b>owner</b></div></div>` +
    `<div class="gov-stat"><div class="g-val">${g.missingCostCenter}</div><div class="g-lbl">Missing <b>cost-center</b></div></div>` +
    `<div class="gov-stat"><div class="g-val">${g.missingEnv}</div><div class="g-lbl">Missing <b>environment</b></div></div>` +
    `</div></div>`;
  $('view-optimize').querySelectorAll('a[data-id]').forEach((a) =>
    a.addEventListener('click', () => selectFromOtherView((a as HTMLElement).dataset.id!)));
  $('optExportCsv').addEventListener('click', () => {
    const lines = [['finding', 'resource', 'type', 'resourceGroup', 'location', 'monthlyCost'].join(',')];
    for (const f of [...d.findings, d.untagged])
      for (const r of f.resources || [])
        lines.push([csv(f.label), csv(r.name), csv(r.type || ''), csv(r.resourceGroup), csv(r.location), r.monthlyCost].join(','));
    download(`optimize-${state.range}.csv`, lines.join('\n'), 'text/csv');
  });
}

// ---- chart helpers -------------------------------------------------------
function hbars(items: { name: string; cost: number }[], cur: string): string {
  if (!items.length) return '<div class="muted">No data.</div>';
  const max = Math.max(...items.map((i) => i.cost), 0.0001);
  return items.slice(0, 10).map((i) =>
    `<div class="hbar-row"><span class="lbl" title="${escapeHtml(i.name)}">${escapeHtml(i.name)}</span>` +
    `<span class="hbar-track"><span class="hbar-fill" style="width:${Math.max(1, (i.cost / max) * 100).toFixed(1)}%"></span></span>` +
    `<span class="val">${money(i.cost, cur)}</span></div>`).join('');
}

function trendArea(series: { date: string; cost: number }[], cur: string): string {
  if (!series.length) return '<div class="muted">No daily breakdown available.</div>';
  const w = 800, h = 160, pad = 6;
  const n = series.length;
  const max = Math.max(...series.map((s) => s.cost), 0.0001);
  const x = (i: number) => (i / (n - 1 || 1)) * (w - 2 * pad) + pad;
  const y = (v: number) => h - pad - (v / max) * (h - 2 * pad - 8);
  const line = series.map((s, i) => `${x(i).toFixed(1)},${y(s.cost).toFixed(1)}`).join(' ');
  const area = `${pad},${h - pad} ${line} ${(w - pad).toFixed(1)},${h - pad}`;
  const last = series[series.length - 1];
  return `<svg class="trend-area" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">` +
    `<polygon points="${area}" fill="rgba(0,120,212,.12)"/>` +
    `<polyline points="${line}" fill="none" stroke="#0078d4" stroke-width="2"/></svg>` +
    `<div class="muted">${series[0].date} → ${last.date} · peak ${money(max, cur)}/day</div>`;
}

// ---- Insights view (AI recommendations + analyst chat) -------------------
async function loadInsights() {
  const sub = state.subscriptionId;
  if (!sub) return;
  const key = `${sub}:${state.range}`;
  if (insightsLoadedFor === key) return;
  $('view-insights').innerHTML = '<div class="muted" style="padding:20px">Analysing spend & generating recommendations…</div>';
  try {
    const d = await api.insights(sub, state.range);
    if (state.subscriptionId !== sub) return;
    insightsLoadedFor = key;
    renderInsights(d);
  } catch (err: any) {
    $('view-insights').innerHTML = `<div class="muted" style="padding:20px">Error: ${escapeHtml(err.message)}</div>`;
  }
}

const SEV_LABEL: Record<string, string> = { opportunity: 'Opportunity', warn: 'Watch', info: 'Info' };

function renderInsights(d: InsightsResp) {
  const cur = d.currency;
  const cards = d.insights.map((i) => {
    const impact = typeof i.impact === 'number' && Math.abs(i.impact) >= 0.5
      ? `<span class="ins-impact ${i.impact < 0 ? 'save' : 'rise'}">${i.impact < 0 ? '↓ save ' : '↑ '}${money(Math.abs(i.impact), cur)}</span>` : '';
    const action = i.action ? `<span class="ins-action">${escapeHtml(i.action)}</span>` : '';
    return `<div class="ins-card sev-${i.severity}"><div class="ins-top"><span class="ins-sev">${SEV_LABEL[i.severity] || i.severity}</span>${impact}</div>` +
      `<div class="ins-title">${escapeHtml(i.title)}</div><div class="ins-detail">${escapeHtml(i.detail)}</div>${action ? `<div class="ins-foot">${action}</div>` : ''}</div>`;
  }).join('');
  $('view-insights').innerHTML =
    `<div class="view-toolbar"><h2>AI Insights</h2><div class="toolbar-actions"><span class="muted small">Rule-based · LLM-pluggable</span></div></div>` +
    `<div class="ins-grid">${cards || '<div class="muted">No recommendations — spend looks healthy.</div>'}</div>` +
    `<div class="analyst card full"><h3>FinOps Analyst</h3>` +
    `<div class="chat-log" id="chatLog"></div>` +
    `<div class="chat-suggest" id="chatSuggest">` +
    ['Why did spend change?', 'Where can I save money?', 'What are my top costs?', 'Forecast next 30 days', 'Which resources are untagged?']
      .map((q) => `<button class="chip" data-q="${escapeHtml(q)}">${escapeHtml(q)}</button>`).join('') +
    `</div>` +
    `<form class="chat-box" id="chatForm"><input id="chatInput" placeholder="Ask about your Azure spend…" autocomplete="off" />` +
    `<button type="submit" class="btn-primary">Ask</button></form></div>`;
  renderChat();
  $('chatForm').addEventListener('submit', (e) => { e.preventDefault(); askAnalyst($<HTMLInputElement>('chatInput').value); });
  $('chatSuggest').querySelectorAll('.chip').forEach((c) =>
    c.addEventListener('click', () => askAnalyst((c as HTMLElement).dataset.q!)));
}

function renderChat() {
  const log = document.getElementById('chatLog');
  if (!log) return;
  log.innerHTML = chatLog.length
    ? chatLog.map((m) => `<div class="bubble ${m.role}">${escapeHtml(m.text)}</div>`).join('')
    : '<div class="muted small">Ask a question or pick a suggestion to get started.</div>';
  log.scrollTop = log.scrollHeight;
}

async function askAnalyst(q: string) {
  const sub = state.subscriptionId;
  q = (q || '').trim();
  if (!q || !sub) return;
  const input = document.getElementById('chatInput') as HTMLInputElement | null;
  if (input) input.value = '';
  chatLog.push({ role: 'user', text: q });
  chatLog.push({ role: 'analyst', text: '…' });
  renderChat();
  try {
    const r = await api.ask(sub, state.range, q);
    chatLog[chatLog.length - 1] = { role: 'analyst', text: r.answer };
  } catch (err: any) {
    chatLog[chatLog.length - 1] = { role: 'analyst', text: `Error: ${err.message}` };
  }
  renderChat();
}

// ---- Editions modal (tier mapping: WorldMonitor Pro/Enterprise → Azure) ---
const EDITIONS = [
  {
    name: 'Free', price: 'Included', tagline: 'Single-subscription visibility',
    features: [
      { t: 'World cost map + region bubbles', live: true },
      { t: 'MG → Sub → RG → Resource drill-down', live: true },
      { t: 'Resource properties, metrics & daily cost', live: true },
      { t: 'Resource linkage (dependency arcs)', live: true },
      { t: 'KPI bar: spend, burn, forecast, tag coverage', live: true },
    ],
  },
  {
    name: 'Pro', price: 'Translated', tagline: 'Analyst-grade intelligence',
    features: [
      { t: 'Analytics: trend, by-service, by-type, top resources', live: true },
      { t: 'Optimize: waste findings + estimated savings', live: true },
      { t: 'AI Insights: anomalies, RI/Savings Plan, tiering', live: true },
      { t: 'FinOps Analyst chat (natural-language Q&A)', live: true },
      { t: 'CSV / JSON export', live: true },
      { t: 'Budgets & spend alerts (email/Teams)', live: false },
    ],
  },
  {
    name: 'Enterprise', price: 'Roadmap', tagline: 'Org-wide governance & automation',
    features: [
      { t: 'Multi-subscription / multi-tenant rollups', live: true },
      { t: 'MCP endpoint for Copilot / LLM agents', live: true },
      { t: 'Azure Policy tag enforcement & remediation', live: false },
      { t: 'Chargeback / showback by cost-center', live: false },
      { t: 'Scheduled exports to Azure SQL / Storage', live: false },
      { t: 'SSO (Entra ID) + RBAC-scoped views', live: false },
      { t: 'Reservation & Savings Plan recommendations API', live: false },
    ],
  },
];

function openEditions() {
  const root = $('modalRoot');
  const cols = EDITIONS.map((e) => {
    const rows = e.features.map((f) =>
      `<li class="${f.live ? 'on' : 'off'}"><span class="tick">${f.live ? '✓' : '○'}</span>${escapeHtml(f.t)}</li>`).join('');
    return `<div class="ed-col ed-${e.name.toLowerCase()}"><div class="ed-name">${escapeHtml(e.name)}</div>` +
      `<div class="ed-price">${escapeHtml(e.price)}</div><div class="ed-tag">${escapeHtml(e.tagline)}</div>` +
      `<ul class="ed-list">${rows}</ul></div>`;
  }).join('');
  root.innerHTML =
    `<div class="modal-backdrop"></div><div class="modal" role="dialog" aria-modal="true">` +
    `<div class="modal-head"><h2>Editions</h2><button class="modal-x" id="edClose" aria-label="Close">✕</button></div>` +
    `<p class="modal-sub">Capabilities adapted from the WorldMonitor Pro / Enterprise tiers, mapped to Azure FinOps. ` +
    `<span class="lg on"><span class="tick">✓</span>live</span> <span class="lg off"><span class="tick">○</span>roadmap</span></p>` +
    `<div class="ed-grid">${cols}</div></div>`;
  root.classList.remove('hidden');
  $('edClose').addEventListener('click', closeEditions);
  root.querySelector('.modal-backdrop')!.addEventListener('click', closeEditions);
}
function closeEditions() {
  const root = $('modalRoot');
  root.classList.add('hidden');
  root.innerHTML = '';
}

// ---- Kiosk / embed modes -------------------------------------------------
function applyDisplayModes() {
  const params = new URLSearchParams(location.search);
  const embed = params.get('embed');
  if (embed) {
    document.body.classList.add('embed-mode');
    if (embed === 'kpi') document.body.classList.add('embed-kpi');
    return;
  }
  if (params.get('kiosk') === '1') {
    document.body.classList.add('kiosk-mode');
    const order: ('map' | 'analytics' | 'optimize' | 'insights')[] = ['map', 'analytics', 'optimize', 'insights'];
    let idx = 0;
    setInterval(() => { idx = (idx + 1) % order.length; switchView(order[idx]); }, 20000);
  }
}

// ---- export helpers ------------------------------------------------------
function csv(s: string): string {
  const v = String(s ?? '');
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
function download(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

applyDisplayModes();
init();

