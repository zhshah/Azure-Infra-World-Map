// Azure SDK helpers for the Azure Infra World Map backend.
// Auth: DefaultAzureCredential — works locally via your `az login` session AND in
// the cloud (Azure App Service / Container Apps) via a Managed Identity, with no
// code changes. Locally, subscriptions are scoped to the logged-on `az` context
// (`az account show` + `az account list --all`, Enabled subs in the active tenant).
// When the Azure CLI is unavailable (e.g. in App Service), subscriptions are
// enumerated via the ARM Subscriptions API using the Managed Identity instead.
import { DefaultAzureCredential } from '@azure/identity';
import { SubscriptionClient } from '@azure/arm-resources-subscriptions';
import { ResourceGraphClient } from '@azure/arm-resourcegraph';
import { ManagementGroupsAPI } from '@azure/arm-managementgroups';
import { ResourceManagementClient } from '@azure/arm-resources';
import { CostManagementClient } from '@azure/arm-costmanagement';
import { MetricsQueryClient } from '@azure/monitor-query';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
// Node 24 requires shell:true to launch the Windows `az.cmd` shim (else spawn EINVAL).
const AZ = 'az';
const AZ_OPTS = { maxBuffer: 32 * 1024 * 1024, shell: true, windowsHide: true };

// Default (home-tenant) credential — used for SQL token + management groups.
// DefaultAzureCredential resolves to a Managed Identity in Azure and to your
// `az login` session locally, so the same build runs in both environments.
let _defaultCredential;
export function getCredential() {
  if (!_defaultCredential) _defaultCredential = new DefaultAzureCredential({ additionallyAllowedTenants: ['*'] });
  return _defaultCredential;
}

// ---- Subscriptions (scoped to the logged-in `az` context) ----------------
let _subs = null;
let _defaultSubId = null;
let _homeTenantId = null;
let _signedInUser = null;

// The current `az` context = the logged-on user's default subscription + its tenant.
async function getActiveContext() {
  try {
    const { stdout } = await execFileP(AZ, ['account', 'show', '-o', 'json'], AZ_OPTS);
    const a = JSON.parse(stdout);
    return { subId: a.id || null, tenantId: a.tenantId || null, user: a.user?.name || null };
  } catch {
    return { subId: null, tenantId: null, user: null };
  }
}

export async function getSubscriptions() {
  if (_subs) return _subs;
  // 1) Local dev path: use the Azure CLI context. This preserves tenant scoping
  //    and the signed-in user's default subscription.
  try {
    const ctx = await getActiveContext();
    const { stdout } = await execFileP(AZ, ['account', 'list', '--all', '-o', 'json'], AZ_OPTS);
    const arr = JSON.parse(stdout);
    _defaultSubId = ctx.subId;
    _homeTenantId = ctx.tenantId;
    _signedInUser = ctx.user;
    // Only Enabled subscriptions can be queried for cost/inventory.
    let enabled = arr.filter((s) => s.state === 'Enabled');
    // Respect the logged-on user's context: narrow to the active tenant when it has
    // subscriptions (avoids pulling in guest-tenant subs from `--all`). Fall back to
    // all enabled subs only if the active tenant can't be determined / has none.
    if (_homeTenantId) {
      const scoped = enabled.filter((s) => s.tenantId === _homeTenantId);
      if (scoped.length) enabled = scoped;
    }
    _subs = enabled
      .map((s) => ({ subscriptionId: s.id, displayName: s.name, state: s.state, tenantId: s.tenantId, isDefault: s.isDefault }))
      .sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
    return _subs;
  } catch (cliErr) {
    // 2) Cloud / no-CLI path (e.g. Azure App Service): enumerate subscriptions via
    //    the ARM Subscriptions API using the Managed Identity.
    console.warn('[api] Azure CLI unavailable; enumerating subscriptions via Managed Identity:', cliErr?.message || cliErr);
    _subs = await getSubscriptionsViaArm();
    return _subs;
  }
}

// Cloud fallback: list subscriptions visible to the Managed Identity. Honours
// AZURE_SUBSCRIPTION_ID / AZURE_TENANT_ID (when set) to scope/seed the picker.
async function getSubscriptionsViaArm() {
  const client = new SubscriptionClient(getCredential());
  const all = [];
  for await (const s of client.subscriptions.list()) {
    if (s.state && s.state !== 'Enabled') continue;
    all.push({ subscriptionId: s.subscriptionId, displayName: s.displayName, state: s.state, tenantId: s.tenantId });
  }
  const envSub = process.env.AZURE_SUBSCRIPTION_ID || null;
  const envTenant = process.env.AZURE_TENANT_ID || null;
  _homeTenantId = envTenant || all[0]?.tenantId || null;
  _defaultSubId = (envSub && all.some((s) => s.subscriptionId === envSub)) ? envSub : (all[0]?.subscriptionId || null);
  _signedInUser = 'Managed identity';
  let enabled = all;
  if (envTenant) {
    const scoped = enabled.filter((s) => s.tenantId === envTenant);
    if (scoped.length) enabled = scoped;
  }
  return enabled
    .map((s) => ({ ...s, isDefault: s.subscriptionId === _defaultSubId }))
    .sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
}
// Backwards-compatible alias used by the API server.
export const listSubscriptions = getSubscriptions;
async function ensureSubs() { if (!_subs) await getSubscriptions(); return _subs; }
export function getDefaultSubscriptionId() {
  const ids = new Set((_subs || []).map((s) => s.subscriptionId));
  if (_defaultSubId && ids.has(_defaultSubId)) return _defaultSubId; // the active `az` context
  return (_subs || []).find((s) => s.isDefault)?.subscriptionId || _subs?.[0]?.subscriptionId || null;
}
export function getSignedInContext() {
  return { user: _signedInUser, tenantId: _homeTenantId, defaultSubscriptionId: getDefaultSubscriptionId() };
}
function tenantForSub(subId) { return (_subs || []).find((s) => s.subscriptionId === subId)?.tenantId; }

const _credByTenant = new Map();
function credentialForSub(subId) {
  const tenantId = tenantForSub(subId);
  const key = tenantId || 'default';
  if (!_credByTenant.has(key)) {
    _credByTenant.set(key, new DefaultAzureCredential(
      tenantId ? { tenantId, additionallyAllowedTenants: ['*'] } : { additionallyAllowedTenants: ['*'] },
    ));
  }
  return _credByTenant.get(key);
}

// ---- Management groups (best-effort; needs MG reader) ---------------------
export async function getManagementGroupTree() {
  try {
    const client = new ManagementGroupsAPI(getCredential());
    const groups = [];
    for await (const g of client.managementGroups.list()) {
      groups.push({ id: g.id, name: g.name, displayName: g.properties?.displayName || g.name });
    }
    return groups;
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

// Full management-group hierarchy (MGs + subscriptions) built from the Entities API.
export async function getManagementGroupHierarchy() {
  const client = new ManagementGroupsAPI(getCredential());
  const nodes = new Map();
  const order = [];
  try {
    for await (const e of client.entities.list()) {
      const isSub = e.type === '/subscriptions';
      nodes.set(e.id, {
        id: e.id,
        name: e.name,
        displayName: e.displayName || e.name,
        type: isSub ? 'subscription' : 'mg',
        parentId: e.parent?.id || null,
        descendants: e.numberOfDescendants || 0,
        access: e.permissions || e.inheritedPermissions || '',
        children: [],
      });
      order.push(e.id);
    }
  } catch (err) {
    return { error: err?.message || String(err), tree: null };
  }
  let root = null;
  for (const id of order) {
    const n = nodes.get(id);
    if (n.parentId && nodes.has(n.parentId)) nodes.get(n.parentId).children.push(n);
    else if (n.type === 'mg') root = root || n;
  }
  if (!root) {
    const orphans = order.map((id) => nodes.get(id)).filter((n) => !n.parentId || !nodes.has(n.parentId));
    root = { id: 'virtual-root', name: 'root', displayName: 'Accessible scope', type: 'mg', parentId: null, descendants: orphans.length, access: '', children: orphans };
  }
  const sortRec = (n) => { n.children.sort((a, b) => (a.type === b.type ? a.displayName.localeCompare(b.displayName) : a.type === 'mg' ? -1 : 1)); n.children.forEach(sortRec); };
  sortRec(root);
  return {
    tree: root,
    counts: {
      mgs: order.filter((id) => nodes.get(id).type === 'mg').length,
      subscriptions: order.filter((id) => nodes.get(id).type === 'subscription').length,
    },
  };
}

// Resource Graph query scoped to an entire management group (cross-subscription).
async function runGraphMg(mgName, query, cap = 6000) {
  const client = new ResourceGraphClient(getCredential());
  const out = [];
  let skipToken;
  do {
    const res = await client.resources({ managementGroups: [mgName], query, options: { resultFormat: 'objectArray', top: 1000, skipToken } });
    for (const r of res.data || []) out.push(r);
    skipToken = res.skipToken;
  } while (skipToken && out.length < cap);
  return out;
}

// Cross-subscription rollup (cost-light): resources, resiliency, security, advisor per subscription.
export async function getPortfolio(mgName) {
  const byId = new Map();
  const get = (id) => {
    let a = byId.get(id);
    if (!a) { a = { subscriptionId: id, resources: 0, zonePinned: 0, secHigh: 0, secMed: 0, secLow: 0, advisor: 0, advByCat: {} }; byId.set(id, a); }
    return a;
  };
  const errors = {};
  try {
    const rows = await runGraphMg(mgName, `Resources | extend zoned = array_length(zones) > 0 | summarize total=count(), zonePinned=countif(zoned) by subscriptionId`);
    for (const r of rows) { const a = get(r.subscriptionId); a.resources = r.total; a.zonePinned = r.zonePinned; }
  } catch (e) { errors.resources = e?.message || String(e); }
  try {
    const rows = await runGraphMg(mgName, `securityresources | where type=='microsoft.security/assessments' | where tostring(properties.status.code)=='Unhealthy' | summarize c=count() by subscriptionId, sev=tolower(tostring(properties.metadata.severity))`);
    for (const r of rows) { const a = get(r.subscriptionId); if (r.sev === 'high') a.secHigh += r.c; else if (r.sev === 'medium') a.secMed += r.c; else a.secLow += r.c; }
  } catch (e) { errors.security = e?.message || String(e); }
  try {
    const rows = await runGraphMg(mgName, `advisorresources | where type=='microsoft.advisor/recommendations' | summarize c=count() by subscriptionId, cat=tostring(properties.category)`);
    for (const r of rows) { const a = get(r.subscriptionId); a.advisor += r.c; a.advByCat[r.cat] = (a.advByCat[r.cat] || 0) + r.c; }
  } catch (e) { errors.advisor = e?.message || String(e); }
  await ensureSubs();
  const meta = new Map((_subs || []).map((s) => [s.subscriptionId, s.displayName]));
  const subs = [...byId.values()].map((a) => ({ ...a, displayName: meta.get(a.subscriptionId) || a.subscriptionId }))
    .sort((a, b) => b.resources - a.resources);
  const totals = subs.reduce((t, a) => ({
    subscriptions: t.subscriptions + 1, resources: t.resources + a.resources, zonePinned: t.zonePinned + a.zonePinned,
    secHigh: t.secHigh + a.secHigh, secMed: t.secMed + a.secMed, secLow: t.secLow + a.secLow, advisor: t.advisor + a.advisor,
  }), { subscriptions: 0, resources: 0, zonePinned: 0, secHigh: 0, secMed: 0, secLow: 0, advisor: 0 });
  return { mg: mgName, subs, totals, errors: Object.keys(errors).length ? errors : undefined };
}

// Best-effort management-group-scoped cost grouped by subscription (single query).
export async function getPortfolioCost(mgName, from, to) {
  const client = new CostManagementClient(getCredential());
  const scope = `/providers/Microsoft.Management/managementGroups/${mgName}`;
  const body = {
    type: 'ActualCost', timeframe: 'Custom', timePeriod: { from: new Date(from), to: new Date(to) },
    dataset: { granularity: 'None', aggregation: { totalCost: { name: 'Cost', function: 'Sum' } }, grouping: [{ type: 'Dimension', name: 'SubscriptionId' }] },
  };
  await acquireCost();
  try {
    const result = await withCostRetry(() => client.query.usage(scope, body));
    const cols = (result.columns || []).map((c) => c.name);
    const costIdx = cols.indexOf('Cost') >= 0 ? cols.indexOf('Cost') : cols.indexOf('PreTaxCost');
    const subIdx = cols.indexOf('SubscriptionId');
    const curIdx = cols.indexOf('Currency');
    const byId = {};
    let currency = 'USD';
    for (const row of result.rows || []) {
      const id = String(row[subIdx] || '').toLowerCase();
      byId[id] = Number(row[costIdx] || 0);
      if (curIdx >= 0) currency = row[curIdx];
    }
    return { byId, currency };
  } catch (err) {
    return { error: err?.message || String(err), byId: {} };
  } finally {
    releaseCost();
  }
}


// ---- Resource Graph inventory -------------------------------------------
const INVENTORY_QUERY = `
Resources
| project id, name, type, kind, location, resourceGroup, subscriptionId, tags, sku, managedBy, zones, properties
`;

export async function getInventory(subscriptionId) {
  await ensureSubs();
  const client = new ResourceGraphClient(credentialForSub(subscriptionId));
  const resources = [];
  let skipToken;
  do {
    const res = await client.resources(
      { subscriptions: [subscriptionId], query: INVENTORY_QUERY, options: { resultFormat: 'objectArray', top: 1000, skipToken } },
    );
    const rows = res.data || [];
    for (const r of rows) resources.push(slimResource(r));
    skipToken = res.skipToken;
  } while (skipToken && resources.length < 8000);
  return resources;
}

const ID_REGEX = /\/subscriptions\/[0-9a-fA-F-]{36}\/resourceGroups\/[^"'\\\s,}{\]]+\/providers\/[^"'\\\s,}{\]]+/gi;

function slimResource(r) {
  // Extract referenced resource IDs from properties + managedBy for linkage.
  const refs = new Set();
  if (r.managedBy && typeof r.managedBy === 'string') refs.add(r.managedBy.toLowerCase());
  try {
    const propStr = JSON.stringify(r.properties ?? {});
    const matches = propStr.match(ID_REGEX);
    if (matches) for (const m of matches) refs.add(m.toLowerCase());
  } catch { /* ignore */ }
  const selfId = (r.id || '').toLowerCase();
  refs.delete(selfId);
  return {
    id: r.id,
    name: r.name,
    type: (r.type || '').toLowerCase(),
    kind: r.kind || null,
    location: (r.location || 'global').toLowerCase(),
    resourceGroup: r.resourceGroup || null,
    subscriptionId: r.subscriptionId || null,
    sku: r.sku || null,
    tags: r.tags || null,
    managedBy: r.managedBy || null,
    zones: Array.isArray(r.zones) ? r.zones.map(String) : (r.zones != null ? [String(r.zones)] : []),
    references: [...refs],
  };
}

// Build directed linkage edges between resources that exist in the inventory.
// Sub-resource references (e.g. a NIC ipconfig id) are collapsed to the parent
// resource by longest-prefix match against known inventory ids.
export function buildLinkage(resources) {
  const ids = resources.map((r) => r.id.toLowerCase()).sort((a, b) => b.length - a.length);
  const idSet = new Set(ids);
  const resolveParent = (ref) => {
    if (idSet.has(ref)) return ref;
    for (const id of ids) if (ref.startsWith(id + '/')) return id;
    return null;
  };
  const edgeKey = new Set();
  const edges = [];
  for (const r of resources) {
    const from = r.id.toLowerCase();
    for (const ref of r.references || []) {
      const to = resolveParent(ref);
      if (!to || to === from) continue;
      const key = from + '>' + to;
      if (edgeKey.has(key)) continue;
      edgeKey.add(key);
      edges.push({ from: r.id, to });
    }
  }
  return edges;
}

// ---- Generic resource detail --------------------------------------------
export async function getResourceById(resourceId) {
  await ensureSubs();
  const subscriptionId = resourceId.split('/')[2];
  const client = new ResourceManagementClient(credentialForSub(subscriptionId), subscriptionId);
  // apiVersion is required for generic GET; resolve a recent one for the provider.
  const apiVersion = await resolveApiVersion(client, resourceId);
  const resource = await client.resources.getById(resourceId, apiVersion);
  return resource;
}

const _apiVersionCache = new Map();
async function resolveApiVersion(client, resourceId) {
  // resourceId: /subscriptions/x/resourceGroups/y/providers/NS/type[/...]
  const parts = resourceId.split('/providers/')[1]?.split('/') || [];
  const namespace = parts[0];
  const resourceType = parts.slice(1).filter((_, i) => i % 2 === 0).join('/');
  const cacheKey = `${namespace}/${resourceType}`;
  if (_apiVersionCache.has(cacheKey)) return _apiVersionCache.get(cacheKey);
  let apiVersion = '2021-04-01';
  try {
    const provider = await client.providers.get(namespace);
    const rt = provider.resourceTypes?.find(
      (t) => t.resourceType?.toLowerCase() === resourceType.toLowerCase(),
    );
    const versions = rt?.apiVersions || rt?.defaultApiVersion ? rt.apiVersions : null;
    if (versions && versions.length) apiVersion = versions[0];
    else if (rt?.defaultApiVersion) apiVersion = rt.defaultApiVersion;
  } catch { /* fall back to default */ }
  _apiVersionCache.set(cacheKey, apiVersion);
  return apiVersion;
}

// ---- Metrics -------------------------------------------------------------
export async function getResourceMetrics(resourceId, durationIso = 'PT6H', grain = 'PT15M') {
  await ensureSubs();
  const subscriptionId = resourceId.split('/')[2];
  const client = new MetricsQueryClient(credentialForSub(subscriptionId));
  let definitions = [];
  try {
    for await (const d of client.listMetricDefinitions(resourceId)) {
      if (d.name) definitions.push(d.name);
    }
  } catch (err) {
    return { supported: false, reason: err?.message || 'No metrics for this resource type', series: [] };
  }
  if (!definitions.length) return { supported: false, reason: 'No metric definitions', series: [] };
  const pick = definitions.slice(0, 4);
  try {
    const result = await client.queryResource(resourceId, pick, {
      timespan: { duration: durationIso },
      granularity: grain,
      aggregations: ['Average', 'Total'],
    });
    const series = (result.metrics || []).map((m) => ({
      name: m.name,
      unit: m.unit,
      points: (m.timeseries?.[0]?.data || []).map((p) => ({
        t: p.timeStamp,
        v: p.average ?? p.total ?? p.maximum ?? null,
      })),
    }));
    return { supported: true, available: definitions, series };
  } catch (err) {
    return { supported: false, reason: err?.message || String(err), available: definitions, series: [] };
  }
}

// Preferred, human-meaningful metrics per resource type (intersected with what's available).
const PREFERRED_METRICS = {
  'microsoft.compute/virtualmachines': ['Percentage CPU', 'Available Memory Bytes', 'Network In Total', 'Network Out Total', 'Disk Read Bytes', 'Disk Write Bytes'],
  'microsoft.compute/virtualmachinescalesets': ['Percentage CPU', 'Network In Total', 'Network Out Total', 'Disk Read Bytes'],
  'microsoft.web/sites': ['CpuTime', 'Requests', 'Http5xx', 'AverageResponseTime', 'MemoryWorkingSet', 'BytesReceived'],
  'microsoft.web/serverfarms': ['CpuPercentage', 'MemoryPercentage', 'HttpQueueLength', 'BytesReceived'],
  'microsoft.storage/storageaccounts': ['UsedCapacity', 'Transactions', 'Ingress', 'Egress', 'SuccessE2ELatency', 'Availability'],
  'microsoft.documentdb/databaseaccounts': ['TotalRequests', 'NormalizedRUConsumption', 'ProvisionedThroughput', 'ServerSideLatency'],
  'microsoft.sql/servers/databases': ['cpu_percent', 'dtu_consumption_percent', 'storage_percent', 'connection_successful', 'workers_percent'],
  'microsoft.dbforpostgresql/flexibleservers': ['cpu_percent', 'memory_percent', 'storage_percent', 'active_connections', 'iops'],
  'microsoft.dbformysql/flexibleservers': ['cpu_percent', 'memory_percent', 'storage_percent', 'active_connections'],
  'microsoft.containerservice/managedclusters': ['node_cpu_usage_percentage', 'node_memory_working_set_percentage', 'kube_pod_status_ready', 'kube_node_status_condition'],
  'microsoft.app/containerapps': ['UsageNanoCores', 'WorkingSetBytes', 'Requests', 'RestartCount', 'RxBytes'],
  'microsoft.cache/redis': ['percentProcessorTime', 'usedmemorypercentage', 'connectedclients', 'cachehits', 'cachemisses'],
  'microsoft.cognitiveservices/accounts': ['TotalCalls', 'TotalTokens', 'Latency', 'SuccessRate'],
  'microsoft.network/applicationgateways': ['Throughput', 'TotalRequests', 'FailedRequests', 'HealthyHostCount'],
  'microsoft.network/loadbalancers': ['VipAvailability', 'DipAvailability', 'ByteCount', 'PacketCount'],
  'microsoft.network/publicipaddresses': ['ByteCount', 'PacketCount', 'IfUnderDDoSAttack'],
  'microsoft.servicebus/namespaces': ['IncomingMessages', 'OutgoingMessages', 'ActiveConnections', 'ServerErrors'],
  'microsoft.eventhub/namespaces': ['IncomingMessages', 'OutgoingMessages', 'ThrottledRequests', 'CapturedMessages'],
};

function pickMetrics(resourceType, available) {
  const want = PREFERRED_METRICS[(resourceType || '').toLowerCase()] || [];
  const lowerAvail = new Map(available.map((a) => [a.toLowerCase(), a]));
  const out = [];
  for (const w of want) { const real = lowerAvail.get(w.toLowerCase()); if (real && !out.includes(real)) out.push(real); }
  for (const a of available) { if (out.length >= 6) break; if (!out.includes(a)) out.push(a); }
  return out.slice(0, 6);
}

// Richer metrics: per-point average + maximum, type-aware metric selection, summary stats.
export async function getResourceMetricsDetailed(resourceId, durationIso = 'PT6H', grain = 'PT15M') {
  await ensureSubs();
  const subscriptionId = resourceId.split('/')[2];
  const resourceType = resourceId.split('/providers/')[1]?.split('/').slice(0, 3).join('/') || '';
  const normType = resourceType.split('/').filter((_, i) => i === 0 || i % 2 === 1).join('/');
  const client = new MetricsQueryClient(credentialForSub(subscriptionId));
  let definitions = [];
  try {
    for await (const d of client.listMetricDefinitions(resourceId)) { if (d.name) definitions.push(d.name); }
  } catch (err) {
    return { supported: false, reason: err?.message || 'No metrics for this resource type', available: [], series: [] };
  }
  if (!definitions.length) return { supported: false, reason: 'No metric definitions for this resource type', available: [], series: [] };
  const pick = pickMetrics(normType, definitions);
  try {
    const result = await client.queryResource(resourceId, pick, {
      timespan: { duration: durationIso },
      granularity: grain,
      aggregations: ['Average', 'Maximum'],
    });
    const series = (result.metrics || []).map((m) => {
      const data = m.timeseries?.[0]?.data || [];
      const points = data.map((p) => ({ t: p.timeStamp, avg: p.average ?? null, max: p.maximum ?? p.average ?? null }));
      const avgs = points.map((p) => p.avg).filter((v) => v != null);
      const maxs = points.map((p) => p.max).filter((v) => v != null);
      return {
        name: m.name,
        unit: m.unit || '',
        points,
        last: avgs.length ? avgs[avgs.length - 1] : null,
        avg: avgs.length ? avgs.reduce((s, v) => s + v, 0) / avgs.length : null,
        min: avgs.length ? Math.min(...avgs) : null,
        max: maxs.length ? Math.max(...maxs) : null,
      };
    }).filter((s) => s.points.some((p) => p.avg != null));
    return { supported: true, available: definitions, duration: durationIso, grain, series };
  } catch (err) {
    return { supported: false, reason: err?.message || String(err), available: definitions, series: [] };
  }
}

// ---- Cost Management -----------------------------------------------------
// Cost Management throttles aggressively (429). Retry with backoff, honouring
// Retry-After / x-ms-ratelimit headers so concurrent breakdowns don't fail.
async function withCostRetry(fn, tries = 5) {
  let delay = 2000;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code = err?.statusCode ?? err?.response?.status ?? err?.code;
      if (Number(code) === 429 && attempt < tries - 1) {
        let waitMs = delay;
        const h = err?.response?.headers;
        const ra = h?.get?.('retry-after') ?? h?.get?.('x-ms-ratelimit-microsoft.costmanagement-entity-retry-after');
        if (ra) waitMs = Number(ra) * 1000 || delay;
        await new Promise((r) => setTimeout(r, Math.min(waitMs, 30000)));
        delay = Math.min(delay * 2, 30000);
        continue;
      }
      throw err;
    }
  }
}

// Global concurrency gate: never run more than N Cost Management queries at once.
// Cost Management throttles hard on concurrent bursts, so serialising a couple at
// a time is dramatically faster (and more reliable) than firing 6 in parallel and
// eating compounding 429 backoffs.
const COST_MAX = Number(process.env.COST_CONCURRENCY || 2);
let _costActive = 0;
const _costQueue = [];
async function acquireCost() {
  if (_costActive >= COST_MAX) await new Promise((r) => _costQueue.push(r));
  _costActive++;
}
function releaseCost() {
  _costActive--;
  const next = _costQueue.shift();
  if (next) next();
}

// groupBy: one of 'ResourceId' | 'ResourceGroupName' | 'ResourceLocation' | 'ServiceName' | 'ResourceType'
export async function queryCost({ subscriptionId, from, to, groupBy = 'ResourceId', granularity = 'None' }) {
  await ensureSubs();
  const client = new CostManagementClient(credentialForSub(subscriptionId));
  const scope = `/subscriptions/${subscriptionId}`;
  const body = {
    type: 'ActualCost',
    timeframe: 'Custom',
    timePeriod: { from: new Date(from), to: new Date(to) },
    dataset: {
      granularity, // 'None' or 'Daily'
      aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
      grouping: groupBy ? [{ type: 'Dimension', name: groupBy }] : undefined,
    },
  };
  await acquireCost();
  let result;
  try {
    result = await withCostRetry(() => client.query.usage(scope, body));
  } finally {
    releaseCost();
  }
  const cols = (result.columns || []).map((c) => c.name);
  const idx = (n) => cols.indexOf(n);
  const costIdx = idx('Cost') >= 0 ? idx('Cost') : idx('PreTaxCost');
  const groupIdx = groupBy ? idx(groupBy) : -1;
  const dateIdx = idx('UsageDate');
  const currencyIdx = idx('Currency');
  const rows = (result.rows || []).map((row) => ({
    key: groupIdx >= 0 ? row[groupIdx] : 'total',
    cost: Number(row[costIdx] || 0),
    date: dateIdx >= 0 ? String(row[dateIdx]) : null,
    currency: currencyIdx >= 0 ? row[currencyIdx] : 'USD',
  }));
  return rows;
}

// ---- Management-group ancestry for a subscription ------------------------
// Uses Resource Graph's managementGroupAncestorsChain (immediate-parent -> root).
export async function getSubscriptionMgPath(subscriptionId) {
  await ensureSubs();
  const sub = (_subs || []).find((s) => s.subscriptionId === subscriptionId);
  const query = `ResourceContainers | where type == 'microsoft.resources/subscriptions' | where subscriptionId == '${subscriptionId}' | project name, mg = properties.managementGroupAncestorsChain`;
  try {
    const client = new ResourceGraphClient(credentialForSub(subscriptionId));
    const res = await client.resources({ subscriptions: [subscriptionId], query, options: { resultFormat: 'objectArray' } });
    const row = (res.data || [])[0];
    const chain = Array.isArray(row?.mg) ? row.mg : [];
    const managementGroups = chain.slice().reverse().map((m) => ({ name: m.name, displayName: m.displayName || m.name, type: 'mg' }));
    return { managementGroups, subscription: { id: subscriptionId, name: sub?.displayName || row?.name || subscriptionId, type: 'subscription' } };
  } catch (err) {
    return { managementGroups: [], subscription: { id: subscriptionId, name: sub?.displayName || subscriptionId, type: 'subscription' }, error: err?.message || String(err) };
  }
}

// ---- Optimization / waste detection (Resource Graph) ---------------------
// Flags idle/orphaned resources that typically still incur cost:
//  - unattached managed disks, unassociated public IPs, unattached NICs
//  - empty App Service plans (0 sites), stopped-but-not-deallocated VMs (still billed)
const OPTIMIZE_QUERY = `
Resources
| extend _reason = case(
    type == 'microsoft.compute/disks' and tostring(properties.diskState) == 'Unattached', 'unattached-disk',
    type == 'microsoft.network/publicipaddresses' and isnull(properties.ipConfiguration) and isnull(properties.natGateway), 'unassociated-pip',
    type == 'microsoft.network/networkinterfaces' and isnull(properties.virtualMachine) and isnull(properties.privateEndpoint), 'unattached-nic',
    type == 'microsoft.web/serverfarms' and toint(properties.numberOfSites) == 0, 'empty-app-service-plan',
    type == 'microsoft.compute/virtualmachines' and tostring(properties.extended.instanceView.powerState.code) == 'PowerState/stopped', 'stopped-vm',
    '')
| where _reason != ''
| project id, name, type, location, resourceGroup, reason = _reason
`;

export async function getOptimizationFindings(subscriptionId) {
  await ensureSubs();
  const client = new ResourceGraphClient(credentialForSub(subscriptionId));
  const out = [];
  let skipToken;
  do {
    const res = await client.resources(
      { subscriptions: [subscriptionId], query: OPTIMIZE_QUERY, options: { resultFormat: 'objectArray', top: 1000, skipToken } },
    );
    for (const r of res.data || []) {
      out.push({
        id: r.id,
        name: r.name,
        type: (r.type || '').toLowerCase(),
        location: (r.location || 'global').toLowerCase(),
        resourceGroup: r.resourceGroup || null,
        reason: r.reason,
      });
    }
    skipToken = res.skipToken;
  } while (skipToken && out.length < 4000);
  return out;
}

// ---- Generic Resource Graph runner + per-resource insights ---------------
async function runGraph(subscriptionId, query, cap = 1000) {
  await ensureSubs();
  const client = new ResourceGraphClient(credentialForSub(subscriptionId));
  const out = [];
  let skipToken;
  do {
    const res = await client.resources(
      { subscriptions: [subscriptionId], query, options: { resultFormat: 'objectArray', top: 1000, skipToken } },
    );
    for (const r of res.data || []) out.push(r);
    skipToken = res.skipToken;
  } while (skipToken && out.length < cap);
  return out;
}
const _subOf = (resourceId) => resourceId.split('/')[2];
const _kql = (s) => String(s).replace(/'/g, "''"); // escape KQL string literal
function _sevRank(s) { return ({ high: 3, medium: 2, low: 1 })[String(s).toLowerCase()] || 0; }

// Per-resource facets for the custom-tab grid: security (unhealthy assessment count),
// health (availability state) and VM power state — each one sub-wide Resource Graph query.
// Returns plain objects keyed by lowercased resource id (JSON-friendly, best-effort).
export async function getResourceFacets(subscriptionId) {
  const sec = {}, health = {}, power = {};
  await Promise.all([
    runGraph(subscriptionId, `securityresources | where type == 'microsoft.security/assessments' | where tostring(properties.status.code) == 'Unhealthy' | extend rid = tolower(tostring(properties.resourceDetails.Id)) | where isnotempty(rid) | summarize c = count() by rid`, 5000)
      .then((rows) => { for (const r of rows) if (r.rid) sec[r.rid] = r.c; }).catch(() => {}),
    runGraph(subscriptionId, `healthresources | where type == 'microsoft.resourcehealth/availabilitystatuses' | extend rid = tolower(tostring(properties.targetResourceId)), st = tostring(properties.availabilityState) | where isnotempty(rid) | project rid, st`, 5000)
      .then((rows) => { for (const r of rows) if (r.rid) health[r.rid] = r.st; }).catch(() => {}),
    runGraph(subscriptionId, `resources | where type =~ 'microsoft.compute/virtualMachines' | extend rid = tolower(id), pw = tostring(properties.extended.instanceView.powerState.code) | where isnotempty(pw) | project rid, pw`, 5000)
      .then((rows) => { for (const r of rows) if (r.rid) power[r.rid] = String(r.pw).replace(/^PowerState\//i, '').toLowerCase(); }).catch(() => {}),
  ]);
  return { sec, health, power };
}

// Microsoft Defender for Cloud assessments scoped to one resource.
export async function getResourceSecurity(resourceId) {
  const q = `
securityresources
| where type == 'microsoft.security/assessments'
| where id startswith '${_kql(resourceId)}/providers/Microsoft.Security/assessments'
| project name = tostring(properties.displayName),
          status = tostring(properties.status.code),
          severity = tostring(properties.metadata.severity),
          description = tostring(properties.metadata.description),
          remediation = tostring(properties.metadata.remediationDescription)
`;
  try {
    const rows = await runGraph(_subOf(resourceId), q, 200);
    rows.sort((a, b) => (a.status === 'Unhealthy' ? -1 : 1) - (b.status === 'Unhealthy' ? -1 : 1) || _sevRank(b.severity) - _sevRank(a.severity));
    return { supported: true, findings: rows };
  } catch (err) {
    return { supported: false, reason: err?.message || String(err), findings: [] };
  }
}

// Azure Advisor recommendations (cost / security / reliability / performance / operational).
export async function getResourceRecommendations(resourceId) {
  const q = `
advisorresources
| where type == 'microsoft.advisor/recommendations'
| where tolower(tostring(properties.resourceMetadata.resourceId)) == tolower('${_kql(resourceId)}')
| project category = tostring(properties.category), impact = tostring(properties.impact),
          problem = tostring(properties.shortDescription.problem),
          solution = tostring(properties.shortDescription.solution)
`;
  try {
    const rows = await runGraph(_subOf(resourceId), q, 200);
    const order = { High: 3, Medium: 2, Low: 1 };
    rows.sort((a, b) => (order[b.impact] || 0) - (order[a.impact] || 0));
    return { supported: true, recommendations: rows };
  } catch (err) {
    return { supported: false, reason: err?.message || String(err), recommendations: [] };
  }
}

// Resource change history (Resource Graph resourcechanges; ~14d retention).
export async function getResourceChanges(resourceId) {
  const q = `
resourcechanges
| extend targetId = tostring(properties.targetResourceId)
| where tolower(targetId) == tolower('${_kql(resourceId)}')
| extend ts = todatetime(properties.changeAttributes.timestamp),
         changeType = tostring(properties.changeType),
         changedBy = tostring(properties.changeAttributes.changedBy)
| project ts, changeType, changedBy, changes = properties.changes
| order by ts desc
| take 50
`;
  try {
    const rows = await runGraph(_subOf(resourceId), q, 100);
    const changes = rows.map((r) => ({
      ts: r.ts,
      changeType: r.changeType,
      changedBy: r.changedBy,
      props: r.changes && typeof r.changes === 'object'
        ? Object.entries(r.changes).slice(0, 8).map(([k, v]) => ({
            name: String(k).split('.').pop(),
            from: v?.previousValue ?? v?.oldValue ?? null,
            to: v?.newValue ?? null,
          }))
        : [],
    }));
    return { supported: true, changes };
  } catch (err) {
    return { supported: false, reason: err?.message || String(err), changes: [] };
  }
}

// Resource health (Azure Resource Health availability status).
export async function getResourceHealth(resourceId) {
  const q = `
healthresources
| where type == 'microsoft.resourcehealth/availabilitystatuses'
| where tolower(tostring(properties.targetResourceId)) == tolower('${_kql(resourceId)}')
| project state = tostring(properties.availabilityState), summary = tostring(properties.summary), since = properties.occuredTime
| take 1
`;
  try {
    const rows = await runGraph(_subOf(resourceId), q, 5);
    return rows[0] || null;
  } catch { return null; }
}

// Power state for compute VMs via Resource Graph (instanceView is captured by ARG).
// Returns a normalized code like 'running' | 'stopped' | 'deallocated' | 'starting',
// or null for resource types that have no power state.
export async function getResourcePowerState(resourceId) {
  const provType = (resourceId.split('/providers/')[1] || '').toLowerCase();
  if (!provType.startsWith('microsoft.compute/virtualmachines')) return null;
  const q = `
resources
| where tolower(id) == tolower('${_kql(resourceId)}')
| where type =~ 'microsoft.compute/virtualMachines'
| project code = tostring(properties.extended.instanceView.powerState.code)
| take 1
`;
  try {
    const rows = await runGraph(_subOf(resourceId), q, 5);
    const code = rows[0]?.code || '';
    const m = /PowerState\/(.+)$/i.exec(code);
    return m ? m[1].toLowerCase() : null;
  } catch { return null; }
}

// Activity log via az CLI (best-effort; last `days` days, capped).
export async function getResourceActivity(resourceId, days = 7) {
  const sub = _subOf(resourceId);
  const start = new Date(Date.now() - days * 86400000).toISOString();
  try {
    const { stdout } = await execFileP(AZ, [
      'monitor', 'activity-log', 'list',
      '--resource-id', resourceId,
      '--subscription', sub,
      '--start-time', start,
      '--max-events', '40',
      '-o', 'json',
    ], AZ_OPTS);
    const arr = JSON.parse(stdout);
    const events = arr.map((e) => ({
      ts: e.eventTimestamp,
      operation: e.operationName?.localizedValue || e.operationName?.value || '',
      status: e.status?.localizedValue || e.status?.value || '',
      level: e.level || '',
      caller: e.caller || '',
    }));
    return { supported: true, events };
  } catch (err) {
    return { supported: false, reason: err?.message || String(err), events: [] };
  }
}

// Subscription-wide posture: Defender, Advisor, Service Health (Resource Graph aggregates).
export async function getPosture(subscriptionId) {
  const sub = subscriptionId;
  const out = {};
  try {
    const rows = await runGraph(sub, `securityresources | where type == 'microsoft.security/assessments' | extend sev=tostring(properties.metadata.severity), st=tostring(properties.status.code) | summarize c=count() by sev, st`, 500);
    out.security = rows.map((r) => ({ severity: r.sev, status: r.st, count: r.c }));
  } catch (e) { out.security = []; out.securityError = e?.message || String(e); }
  try {
    const rows = await runGraph(sub, `securityresources | where type == 'microsoft.security/securescores' | project current=toint(properties.score.current), max=toint(properties.score.max), pct=todouble(properties.score.percentage)`, 10);
    if (rows[0]) out.secureScore = rows[0];
  } catch { /* optional */ }
  try {
    const rows = await runGraph(sub, `advisorresources | where type == 'microsoft.advisor/recommendations' | extend cat=tostring(properties.category), imp=tostring(properties.impact) | summarize c=count() by cat, imp`, 500);
    out.advisor = rows.map((r) => ({ category: r.cat, impact: r.imp, count: r.c }));
  } catch (e) { out.advisor = []; out.advisorError = e?.message || String(e); }
  try {
    const rows = await runGraph(sub, `servicehealthresources | where type == 'microsoft.resourcehealth/events' | extend st=tostring(properties.Status), et=tostring(properties.EventType), ti=tostring(properties.Title), lvl=tostring(properties.EventLevel) | where st =~ 'Active' | project title=ti, eventType=et, level=lvl | take 25`, 100);
    out.serviceHealth = rows;
  } catch { out.serviceHealth = []; }
  return out;
}

// Subscription-wide operations: backup/BCDR, monitoring footprint, change tracking.
export async function getOps(subscriptionId) {
  const sub = subscriptionId;
  const out = {};
  try {
    const pi = await runGraph(sub, `recoveryservicesresources | where type =~ 'microsoft.recoveryservices/vaults/backupfabrics/protectioncontainers/protecteditems' | summarize c=count()`, 10);
    const vaults = await runGraph(sub, `resources | where type =~ 'microsoft.recoveryservices/vaults' | summarize c=count()`, 10);
    out.backup = { protectedItems: pi[0]?.c || 0, vaults: vaults[0]?.c || 0 };
  } catch (e) { out.backup = { protectedItems: 0, vaults: 0, error: e?.message || String(e) }; }
  try {
    const vms = await runGraph(sub, `resources | where type =~ 'microsoft.compute/virtualmachines' | summarize c=count()`, 10);
    out.vmCount = vms[0]?.c || 0;
  } catch { out.vmCount = 0; }
  try {
    const mon = await runGraph(sub, `resources | where type =~ 'microsoft.compute/virtualmachines/extensions' | where name has 'Monitor' or name has 'OmsAgent' or name has 'MonitoringAgent' | extend vm=tostring(split(id,'/extensions/')[0]) | summarize c=dcount(vm)`, 10);
    out.monitoredVms = mon[0]?.c || 0;
  } catch { out.monitoredVms = 0; }
  try {
    const rows = await runGraph(sub, `resourcechanges | extend ts=todatetime(properties.changeAttributes.timestamp), ct=tostring(properties.changeType), tgt=tostring(properties.targetResourceId) | where isnotempty(tgt) | project ts, changeType=ct, target=tgt | order by ts desc | take 40`, 100);
    out.changes = rows.map((r) => ({ ts: r.ts, changeType: r.changeType, target: r.target }));
  } catch (e) { out.changes = []; out.changesError = e?.message || String(e); }
  return out;
}

// ---- Service Health (active events, with impacted regions & services) ------
// Powers per-region health highlighting on the map and the drill-down panel.
export async function getServiceHealth(subscriptionId) {
  const sub = subscriptionId;
  try {
    const rows = await runGraph(sub, `servicehealthresources | where type == 'microsoft.resourcehealth/events' | extend st=tostring(properties.Status), et=tostring(properties.EventType), ti=tostring(properties.Title), lvl=tostring(properties.EventLevel), track=tostring(properties.TrackingId), lu=tostring(properties.LastUpdateTime), impact=properties.Impact | where st =~ 'Active' | project title=ti, eventType=et, level=lvl, trackingId=track, lastUpdate=lu, impact | take 150`, 300);
    const RANK = { ServiceIssue: 3, PlannedMaintenance: 2, HealthAdvisory: 1, SecurityAdvisory: 1 };
    const statusOf = (et) => et === 'ServiceIssue' ? 'issue' : et === 'PlannedMaintenance' ? 'maintenance' : 'advisory';
    const events = rows.map((r) => {
      const services = new Set();
      const regionNames = new Map(); // display name -> normalized region code
      const impactList = Array.isArray(r.impact) ? r.impact : [];
      for (const im of impactList) {
        if (im?.ImpactedService) services.add(String(im.ImpactedService));
        const regs = Array.isArray(im?.ImpactedRegions) ? im.ImpactedRegions : [];
        for (const rg of regs) {
          const name = rg?.ImpactedRegion || rg?.RegionName || rg?.RegionId || rg?.Name;
          if (!name) continue;
          const code = String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
          regionNames.set(String(name), code);
        }
      }
      return { title: r.title, eventType: r.eventType, level: r.level, trackingId: r.trackingId, lastUpdate: r.lastUpdate, status: statusOf(r.eventType), services: [...services], regions: [...regionNames.keys()], regionCodes: [...new Set(regionNames.values())] };
    });
    const byRegion = {};
    for (const e of events) {
      const rank = RANK[e.eventType] || 0;
      for (const code of e.regionCodes) {
        const cur = byRegion[code];
        if (!cur) byRegion[code] = { status: e.status, rank, count: 1 };
        else { cur.count++; if (rank > cur.rank) { cur.rank = rank; cur.status = e.status; } }
      }
    }
    return { events, byRegion, fetchedAt: Date.now() };
  } catch (e) { return { events: [], byRegion: {}, error: e?.message || String(e) }; }
}

// ---- Active Azure Monitor alerts (fired & not closed; auto-clears) ---------
// Filtering on monitorCondition=Fired means a refresh drops alerts the moment
// they are resolved/closed in Azure — so closed alerts disappear here too.
export async function getActiveAlerts(subscriptionId) {
  const sub = subscriptionId;
  try {
    const rows = await runGraph(sub, `alertsmanagementresources | where type == 'microsoft.alertsmanagement/alerts' | where tostring(properties.essentials.monitorCondition) =~ 'Fired' | where tostring(properties.essentials.alertState) !~ 'Closed' | project alertId=id, name=tostring(properties.essentials.alertRule), severity=tostring(properties.essentials.severity), alertState=tostring(properties.essentials.alertState), targetResource=tostring(properties.essentials.targetResource), targetType=tostring(properties.essentials.targetResourceType), signalType=tostring(properties.essentials.signalType), monitorService=tostring(properties.essentials.monitorService), fired=tostring(properties.essentials.startDateTime), description=tostring(properties.essentials.description) | take 300`, 500);
    const sevRank = (s) => { const m = /sev(\d)/i.exec(String(s || '')); return m ? Number(m[1]) : 9; };
    rows.sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || String(b.fired).localeCompare(String(a.fired)));
    const sevCounts = {};
    for (const r of rows) sevCounts[r.severity] = (sevCounts[r.severity] || 0) + 1;
    return { alerts: rows, total: rows.length, sevCounts, fetchedAt: Date.now() };
  } catch (e) { return { alerts: [], total: 0, sevCounts: {}, error: e?.message || String(e) }; }
}

