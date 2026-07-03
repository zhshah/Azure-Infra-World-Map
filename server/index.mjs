// Azure FinOps Map — API server (read-only Azure data via AzureCliCredential).
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  listSubscriptions,
  getDefaultSubscriptionId,
  getSignedInContext,
  getManagementGroupTree,
  getManagementGroupHierarchy,
  getPortfolio,
  getPortfolioCost,
  getSubscriptionMgPath,
  getInventory,
  buildLinkage,
  getResourceById,
  getResourceMetrics,
  getResourceMetricsDetailed,
  getResourceSecurity,
  getResourceRecommendations,
  getResourceChanges,
  getResourceActivity,
  getResourceHealth,
  getResourcePowerState,
  getResourceFacets,
  getPosture,
  getOps,
  getServiceHealth,
  getActiveAlerts,
  getOptimizationFindings,
  queryCost,
} from './azure.mjs';
import * as sqlCache from './sql.mjs';
import { getDisk, setDisk } from './disk-cache.mjs';
import { withSnapshot, storeStatus } from './store.mjs';
import { getWhatsNew } from './whatsnew.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8085;

const regions = JSON.parse(await readFile(join(__dirname, '..', 'data', 'azure-regions.json'), 'utf8'));
const costLocationMap = JSON.parse(await readFile(join(__dirname, '..', 'data', 'cost-location-map.json'), 'utf8'));

const app = express();
app.use(cors());
app.use(compression());
app.use(express.json());

// In production (Azure App Service / container) the built SPA in ../dist is served
// by this same Express process, so the UI and API share one origin and one port.
// In local dev this is skipped (no dist/) — Vite serves the UI on :8084 and proxies
// /api to this server.
const distDir = join(__dirname, '..', 'dist');
const serveStatic = existsSync(distDir);
if (serveStatic) {
  app.use(express.static(distDir));
  console.log('[api] serving built SPA from', distDir);
}

// ---- tiny TTL cache ------------------------------------------------------
const cache = new Map();
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  const val = Promise.resolve(fn()).then(
    (v) => { cache.set(key, { val: Promise.resolve(v), exp: Date.now() + ttlMs }); return v; },
    (e) => { cache.delete(key); throw e; },
  );
  cache.set(key, { val, exp: Date.now() + ttlMs });
  return val;
}

function rangeToDates(range, from, to) {
  if (from && to) return { from: new Date(from), to: new Date(to) };
  const end = new Date();
  const start = new Date();
  const days = { '1d': 1, '7d': 7, '14d': 14, '30d': 30, '60d': 60, '90d': 90 }[range] ?? 30;
  start.setUTCDate(start.getUTCDate() - days);
  return { from: start, to: end };
}

// Cost grouped by ResourceId (lowercased) -> number. Cached + SQL-backed.
async function costByResource(subscriptionId, from, to) {
  const key = `cost:${subscriptionId}:${from.toISOString().slice(0, 10)}:${to.toISOString().slice(0, 10)}`;
  return cached(key, 30 * 60 * 1000, async () => {
    // 1) Azure SQL cache (if configured)
    if (sqlCache.isEnabled()) {
      const cachedRows = await sqlCache.getCostByResource(subscriptionId, from, to).catch(() => null);
      if (cachedRows && cachedRows.size) return cachedRows;
    }
    // 2) persistent disk cache (throttle resilience across restarts)
    const disk = await getDisk(key, 24 * 60 * 60 * 1000);
    if (disk && disk.entries) {
      const m = new Map(disk.entries);
      m.currency = disk.currency || 'USD';
      return m;
    }
    // 3) live Cost Management API
    const rows = await queryCost({ subscriptionId, from, to, groupBy: 'ResourceId', granularity: 'None' });
    const map = new Map();
    let currency = 'USD';
    for (const r of rows) {
      if (!r.key) continue;
      currency = r.currency || currency;
      const k = String(r.key).toLowerCase();
      map.set(k, (map.get(k) || 0) + r.cost);
    }
    map.currency = currency;
    setDisk(key, { currency, entries: [...map.entries()] });
    if (sqlCache.isEnabled()) sqlCache.upsertCostByResource(subscriptionId, from, to, rows).catch(() => {});
    return map;
  });
}

// Roll cost line items up to the owning inventory resource: exact id match, else
// longest-prefix parent (e.g. a file-share cost rolls into its storage account).
// Costs that match no inventory resource (marketplace, deleted, bandwidth) go to
// `unattributed`. Returns { byInv: Map<invId(lower), cost>, unattributed }.
function attributeCostToInventory(costMap, inventory) {
  const ids = inventory.map((r) => r.id.toLowerCase()).sort((a, b) => b.length - a.length);
  const idSet = new Set(ids);
  const resolve = (key) => {
    if (idSet.has(key)) return key;
    for (const id of ids) if (key.startsWith(id + '/')) return id;
    return null;
  };
  const byInv = new Map();
  let unattributed = 0;
  for (const [key, cost] of costMap.entries()) {
    if (typeof key !== 'string') continue;
    const inv = resolve(key);
    if (inv) byInv.set(inv, (byInv.get(inv) || 0) + cost);
    else unattributed += cost;
  }
  return { byInv, unattributed };
}

// ---- routes --------------------------------------------------------------
// The web UI is served by Vite on :8084. This is the API server (:8085); a bare
// browser hit to "/" would otherwise 404, so send people to the app.
const WEB_URL = process.env.WEB_URL || 'http://localhost:8084';
app.get('/', (_req, res) => {
  res.set('Content-Type', 'text/html').send(
    `<!doctype html><meta charset="utf-8"><title>Azure FinOps Map API</title>` +
    `<meta http-equiv="refresh" content="0;url=${WEB_URL}/">` +
    `<body style="font-family:Segoe UI,system-ui,sans-serif;padding:40px;color:#323130">` +
    `<h2>Azure FinOps Map — API server</h2>` +
    `<p>This is the backend API (port 8085). The app is at <a href="${WEB_URL}/">${WEB_URL}</a> — redirecting…</p>` +
    `<p style="color:#605e5c">Health: <a href="/api/health">/api/health</a></p></body>`,
  );
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', sqlCache: sqlCache.isEnabled(), time: new Date().toISOString() });
});

app.get('/api/context', async (_req, res) => {
  try {
    const subs = await cached('subs', 5 * 60 * 1000, listSubscriptions);
    const def = process.env.AZURE_SUBSCRIPTION_ID || getDefaultSubscriptionId() || subs[0]?.subscriptionId || null;
    const ctx = getSignedInContext();
    res.json({ subscriptions: subs, defaultSubscriptionId: def, sqlCache: sqlCache.isEnabled(), user: ctx.user, tenantId: ctx.tenantId });
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  }
});

// Per-resource facets (cost + security + health + power) powering custom tab grids.
app.get('/api/resource-facets', async (req, res) => {
  const sub = req.query.sub;
  if (!sub) return res.status(400).json({ error: 'sub query param required' });
  const { from, to } = rangeToDates(req.query.range, req.query.from, req.query.to);
  try {
    const fromIso = from.toISOString().slice(0, 10), toIso = to.toISOString().slice(0, 10);
    const data = await cached(`facets:${sub}:${fromIso}:${toIso}`, 15 * 60 * 1000, async () => {
      const [invResp, costMap, facets] = await Promise.all([
        getInventory(sub).catch(() => ({ resources: [] })),
        costByResource(sub, from, to).catch(() => new Map()),
        getResourceFacets(sub).catch(() => ({ sec: {}, health: {}, power: {} })),
      ]);
      const invArr = Array.isArray(invResp) ? invResp : (invResp.resources || []);
      const { byInv } = attributeCostToInventory(costMap, invArr);
      const cost = {};
      for (const [id, c] of byInv) cost[id] = c;
      return { currency: costMap.currency || 'USD', cost, sec: facets.sec, health: facets.health, power: facets.power };
    });
    res.json(data);
  } catch (err) { res.status(500).json({ error: errMsg(err) }); }
});

// ---- Saved custom tabs (persisted per signed-in user; Azure SQL when configured) --
function tabUserKey() { try { return getSignedInContext().user || 'local'; } catch { return 'local'; } }
app.get('/api/tabs', async (_req, res) => {
  try {
    const tabs = await sqlCache.listTabs(tabUserKey());
    res.json({ persisted: sqlCache.isEnabled(), tabs: tabs || [] });
  } catch (err) { res.status(500).json({ error: errMsg(err) }); }
});
app.put('/api/tabs', async (req, res) => {
  const tab = req.body;
  if (!tab || !tab.id) return res.status(400).json({ error: 'tab.id required' });
  try {
    const ok = await sqlCache.saveTab(tabUserKey(), tab);
    res.json({ ok, persisted: sqlCache.isEnabled() });
  } catch (err) { res.status(500).json({ error: errMsg(err) }); }
});
app.delete('/api/tabs', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'id query param required' });
  try {
    const ok = await sqlCache.deleteTab(tabUserKey(), id);
    res.json({ ok, persisted: sqlCache.isEnabled() });
  } catch (err) { res.status(500).json({ error: errMsg(err) }); }
});

// Active Service Health events (with impacted regions/services) for the map + drill-down.
app.get('/api/service-health', async (req, res) => {
  const sub = req.query.sub;
  if (!sub) return res.status(400).json({ error: 'sub query param required' });
  try { res.json(await cached(`svchealth:${sub}`, 3 * 60 * 1000, () => getServiceHealth(sub))); }
  catch (err) { res.status(500).json({ error: errMsg(err) }); }
});

// Active (fired, not closed) Azure Monitor alerts for the selected subscription.
app.get('/api/alerts', async (req, res) => {
  const sub = req.query.sub;
  if (!sub) return res.status(400).json({ error: 'sub query param required' });
  try { res.json(await cached(`alerts:${sub}`, 60 * 1000, () => getActiveAlerts(sub))); }
  catch (err) { res.status(500).json({ error: errMsg(err) }); }
});

app.get('/api/management-groups', async (_req, res) => {
  const mg = await cached('mg', 10 * 60 * 1000, getManagementGroupTree);
  res.json(mg);
});

// Full management-group hierarchy (MGs + subscriptions) for the enterprise navigator.
app.get('/api/mg-tree', async (_req, res) => {
  try {
    res.json(await cached('mgtree', 10 * 60 * 1000, getManagementGroupHierarchy));
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  }
});

// Cross-subscription portfolio rollup (resources / resiliency / security / advisor) for a management group.
app.get('/api/portfolio', async (req, res) => {
  const mg = req.query.mg;
  if (!mg) return res.status(400).json({ error: 'mg query param required' });
  try {
    res.json(await cached(`portfolio:${mg}`, 5 * 60 * 1000, () => getPortfolio(mg)));
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  }
});

// Best-effort management-group-scoped cost grouped by subscription.
app.get('/api/portfolio-cost', async (req, res) => {
  const mg = req.query.mg;
  if (!mg) return res.status(400).json({ error: 'mg query param required' });
  const { from, to } = rangeToDates(req.query.range, req.query.from, req.query.to);
  try {
    res.json(await cached(`pcost:${mg}:${req.query.range || '30d'}`, 30 * 60 * 1000, () => getPortfolioCost(mg, from, to)));
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  }
});

// Management-group ancestry (MG -> ... -> Subscription) for the breadcrumb.
app.get('/api/sub-path', async (req, res) => {
  const sub = req.query.sub;
  if (!sub) return res.status(400).json({ error: 'sub query param required' });
  try {
    const path = await cached(`subpath:${sub}`, 10 * 60 * 1000, () => getSubscriptionMgPath(sub));
    res.json(path);
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  }
});

app.get('/api/inventory', async (req, res) => {
  const sub = req.query.sub;
  if (!sub) return res.status(400).json({ error: 'sub query param required' });
  try {
    const inv = await cached(`inv:${sub}`, 5 * 60 * 1000, () => getInventory(sub));
    res.json({ count: inv.length, resources: inv });
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  }
});

// Aggregated by region for the map: count + cost per region with coords.
app.get('/api/regions', async (req, res) => {
  const sub = req.query.sub;
  if (!sub) return res.status(400).json({ error: 'sub query param required' });
  const { from, to } = rangeToDates(req.query.range, req.query.from, req.query.to);
  const fast = req.query.fast === '1';
  try {
    const inv = await cached(`inv:${sub}`, 5 * 60 * 1000, () => getInventory(sub));
    // Resource counts per region from inventory.
    const counts = new Map();
    for (const r of inv) {
      const loc = r.location || 'global';
      if (!counts.has(loc)) counts.set(loc, { count: 0, types: {} });
      const c = counts.get(loc);
      c.count += 1;
      const t = r.type.split('/')[0];
      c.types[t] = (c.types[t] || 0) + 1;
    }
    // Accurate per-region cost from Cost Management's ResourceLocation dimension
    // (captures sub-resource & non-ARM spend the inventory map would miss).
    let costError = null, currency = 'USD';
    const costByRegion = new Map();
    let unassignedCost = 0;
    if (!fast) try {
      const rows = await costQueryCached(sub, from, to, 'ResourceLocation');
      for (const row of rows) {
        currency = row.currency || currency;
        const raw = String(row.key || '').toLowerCase();
        const key = costLocationMap[raw] || (regions[raw] ? raw : null);
        if (key && regions[key]) costByRegion.set(key, (costByRegion.get(key) || 0) + row.cost);
        else unassignedCost += row.cost;
      }
    } catch (e) { costError = errMsg(e); }

    const allKeys = new Set([...counts.keys(), ...costByRegion.keys()]);
    const out = [];
    for (const key of allKeys) {
      const geo = regions[key] || null;
      out.push({
        region: key,
        display: geo?.display || key,
        geo: geo?.geo || null,
        lat: geo?.lat ?? null,
        lon: geo?.lon ?? null,
        count: counts.get(key)?.count || 0,
        cost: costByRegion.get(key) || 0,
        types: counts.get(key)?.types || {},
      });
    }
    out.sort((a, b) => b.cost - a.cost || b.count - a.count);
    res.json({ currency, from, to, regions: out, unassignedCost, costError });
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  }
});

// Availability-zone topology for a region: resources grouped into AZ datacenters.
app.get('/api/region-zones', async (req, res) => {
  const region = String(req.query.region || '').toLowerCase();
  // Accept a single `sub` (back-compat) or a comma-separated `subs` list so one
  // region can aggregate resources across every subscription the user owns.
  const subsParam = String(req.query.subs || req.query.sub || '');
  const subList = [...new Set(subsParam.split(',').map((s) => s.trim()).filter(Boolean))];
  if (!subList.length || !region) return res.status(400).json({ error: 'sub(s) and region query params required' });
  const { from, to } = rangeToDates(req.query.range, req.query.from, req.query.to);
  try {
    const subsMeta = await cached('subs', 5 * 60 * 1000, listSubscriptions);
    const subName = (id) => subsMeta.find((s) => s.subscriptionId === id)?.displayName || id;
    // Gather inventory + cost for each subscription, keeping only this region.
    const here = [];
    let currency = 'USD';
    const subCounts = new Map();
    for (const sub of subList) {
      let inv;
      try { inv = await cached(`inv:${sub}`, 5 * 60 * 1000, () => getInventory(sub)); } catch { continue; }
      let costMap = new Map();
      try { costMap = await costByResource(sub, from, to); currency = costMap.currency || currency; } catch { /* cost optional */ }
      const { byInv } = attributeCostToInventory(costMap, inv);
      for (const r of inv) {
        if ((r.location || 'global') !== region) continue;
        here.push({ r, sub, cost: byInv.get(r.id.toLowerCase()) || 0 });
        subCounts.set(sub, (subCounts.get(sub) || 0) + 1);
      }
    }
    const buckets = new Map();
    const ensure = (z) => { if (!buckets.has(z)) buckets.set(z, { zone: z, count: 0, cost: 0, resources: [] }); return buckets.get(z); };
    for (const z of ['1', '2', '3', 'none']) ensure(z);
    let total = 0;
    for (const { r, sub, cost } of here) {
      total += cost;
      const zs = (Array.isArray(r.zones) ? r.zones : []).map(String).filter((z) => ['1', '2', '3'].includes(z));
      const item = {
        id: r.id, name: r.name, type: r.type, resourceGroup: r.resourceGroup, cost,
        zoneRedundant: zs.length > 1, subscriptionId: sub, subscriptionName: subName(sub), tags: r.tags || null,
      };
      if (zs.length) {
        for (const z of zs) { const b = ensure(z); b.count++; b.cost += cost / zs.length; b.resources.push(item); }
      } else {
        const b = ensure('none'); b.count++; b.cost += cost; b.resources.push(item);
      }
    }
    const zones = ['1', '2', '3', 'none'].map((z) => {
      const b = buckets.get(z);
      b.resources.sort((a, c) => c.cost - a.cost);
      return { zone: z, count: b.count, cost: b.cost, resources: b.resources.slice(0, 4000) };
    });
    const geo = regions[region] || null;
    const subscriptions = [...subCounts.entries()]
      .map(([id, count]) => ({ subscriptionId: id, displayName: subName(id), count }))
      .sort((a, b) => b.count - a.count);
    res.json({ region, display: geo?.display || region, currency, total, count: here.length, zones, subscriptions });
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  }
});

// Hierarchy: subscription -> resourceGroup -> resource, each annotated with cost.
app.get('/api/tree', async (req, res) => {
  const sub = req.query.sub;
  if (!sub) return res.status(400).json({ error: 'sub query param required' });
  const { from, to } = rangeToDates(req.query.range, req.query.from, req.query.to);
  try {
    const [inv, subs] = await Promise.all([
      cached(`inv:${sub}`, 5 * 60 * 1000, () => getInventory(sub)),
      cached('subs', 5 * 60 * 1000, listSubscriptions),
    ]);
    let costMap = new Map();
    try { costMap = await costByResource(sub, from, to); } catch { /* cost optional */ }
    const subName = subs.find((s) => s.subscriptionId === sub)?.displayName || sub;
    const { byInv, unattributed } = attributeCostToInventory(costMap, inv);

    const rgs = new Map();
    for (const r of inv) {
      const rg = r.resourceGroup || '(none)';
      if (!rgs.has(rg)) rgs.set(rg, { name: rg, type: 'resourceGroup', cost: 0, children: [] });
      const node = rgs.get(rg);
      const cost = byInv.get(r.id.toLowerCase()) || 0;
      node.cost += cost;
      node.children.push({ id: r.id, name: r.name, type: 'resource', resourceType: r.type, location: r.location, cost });
    }
    const rgList = [...rgs.values()];
    if (unattributed > 0.005) {
      rgList.push({ name: '(unassigned / shared cost)', type: 'resourceGroup', cost: unattributed, unassigned: true, children: [] });
    }
    rgList.sort((a, b) => b.cost - a.cost);
    for (const rg of rgList) rg.children.sort((a, b) => b.cost - a.cost);
    const total = rgList.reduce((s, rg) => s + rg.cost, 0);
    res.json({
      currency: costMap.currency || 'USD',
      tree: { id: `/subscriptions/${sub}`, name: subName, type: 'subscription', cost: total, children: rgList },
    });
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  }
});

app.get('/api/linkage', async (req, res) => {
  const sub = req.query.sub;
  if (!sub) return res.status(400).json({ error: 'sub query param required' });
  try {
    const inv = await cached(`inv:${sub}`, 5 * 60 * 1000, () => getInventory(sub));
    const edges = buildLinkage(inv);
    res.json({ count: edges.length, edges });
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  }
});

// Resource detail: properties + metrics + cost (total + daily series).
app.get('/api/resource', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'id query param required' });
  const { from, to } = rangeToDates(req.query.range, req.query.from, req.query.to);
  const sub = id.split('/')[2];
  const out = { id };
  await Promise.all([
    getResourceById(id).then((r) => { out.resource = r; }).catch((e) => { out.resourceError = errMsg(e); }),
    getResourceMetrics(id).then((m) => { out.metrics = m; }).catch((e) => { out.metrics = { supported: false, reason: errMsg(e), series: [] }; }),
    getResourceHealth(id).then((h) => { out.health = h; }).catch(() => { out.health = null; }),
    getResourcePowerState(id).then((p) => { out.powerState = p; }).catch(() => { out.powerState = null; }),
    (async () => {
      try {
        const daily = await queryCost({ subscriptionId: sub, from, to, groupBy: 'ResourceId', granularity: 'Daily' });
        const idl = id.toLowerCase();
        const series = daily.filter((r) => String(r.key).toLowerCase() === idl)
          .map((r) => ({ date: r.date, cost: r.cost }))
          .sort((a, b) => String(a.date).localeCompare(String(b.date)));
        out.cost = { total: series.reduce((s, p) => s + p.cost, 0), currency: daily[0]?.currency || 'USD', series };
      } catch (e) { out.cost = { error: errMsg(e), series: [] }; }
    })(),
  ]);
  res.json(out);
});

// ---- Per-resource insights (Resource Graph + Activity Log) ---------------
function reqId(req, res) {
  const id = req.query.id;
  if (!id) { res.status(400).json({ error: 'id query param required' }); return null; }
  return id;
}
app.get('/api/resource-security', async (req, res) => {
  const id = reqId(req, res); if (!id) return;
  try { res.json(await cached(`sec:${id}`, 5 * 60 * 1000, () => getResourceSecurity(id))); }
  catch (err) { res.status(500).json({ error: errMsg(err) }); }
});
app.get('/api/resource-recommendations', async (req, res) => {
  const id = reqId(req, res); if (!id) return;
  try { res.json(await cached(`adv:${id}`, 5 * 60 * 1000, () => getResourceRecommendations(id))); }
  catch (err) { res.status(500).json({ error: errMsg(err) }); }
});
app.get('/api/resource-changes', async (req, res) => {
  const id = reqId(req, res); if (!id) return;
  try { res.json(await cached(`chg:${id}`, 5 * 60 * 1000, () => getResourceChanges(id))); }
  catch (err) { res.status(500).json({ error: errMsg(err) }); }
});
app.get('/api/resource-activity', async (req, res) => {
  const id = reqId(req, res); if (!id) return;
  try { res.json(await cached(`act:${id}`, 3 * 60 * 1000, () => getResourceActivity(id))); }
  catch (err) { res.status(500).json({ error: errMsg(err) }); }
});

// Detailed performance metrics (avg + max, type-aware selection) with selectable
// time window. Falls back to the last stored snapshot when Monitor throttles.
const METRIC_WINDOWS = {
  '1h': { dur: 'PT1H', grain: 'PT1M' },
  '6h': { dur: 'PT6H', grain: 'PT5M' },
  '24h': { dur: 'P1D', grain: 'PT15M' },
  '7d': { dur: 'P7D', grain: 'PT1H' },
};
app.get('/api/resource-metrics', async (req, res) => {
  const id = reqId(req, res); if (!id) return;
  const win = METRIC_WINDOWS[req.query.window] || METRIC_WINDOWS['6h'];
  try {
    const out = await cached(`metrics:${id}:${req.query.window || '6h'}`, 2 * 60 * 1000, () =>
      withSnapshot('metrics', `${id}|${req.query.window || '6h'}`,
        () => getResourceMetricsDetailed(id, win.dur, win.grain),
        { maxAgeMs: 24 * 60 * 60 * 1000, isEmpty: (m) => !m || !m.supported || !m.series?.length }));
    res.json(out);
  } catch (err) { res.status(500).json({ error: errMsg(err) }); }
});

// Storage backend status (disk / SQL / Cosmos) for diagnostics.
app.get('/api/store-status', (_req, res) => res.json(storeStatus()));

// "What's New in Azure" catalog: Azure Updates + official Microsoft YouTube
// channels, tagged by content category. Disk-backed so it survives feed outages.
app.get('/api/whats-new', async (_req, res) => {
  try {
    const data = await cached('whatsnew', 60 * 60 * 1000, async () => {
      const d = await getWhatsNew();
      if (d.updates.length || d.channels.length) await setDisk('whatsnew:last', d);
      return d;
    });
    res.json(data);
  } catch (e) {
    const last = await getDisk('whatsnew:last', 7 * 24 * 60 * 60 * 1000);
    if (last) return res.json({ ...last, _stale: true });
    res.status(500).json({ error: errMsg(e) });
  }
});

// Subscription-wide posture: Defender, Advisor, Service Health + resiliency (zone redundancy).
app.get('/api/posture', async (req, res) => {
  const sub = req.query.sub;
  if (!sub) return res.status(400).json({ error: 'sub query param required' });
  try {
    const [p, inv] = await Promise.all([
      cached(`posture:${sub}`, 10 * 60 * 1000, () => getPosture(sub)),
      cached(`inv:${sub}`, 5 * 60 * 1000, () => getInventory(sub)),
    ]);
    let zonePinned = 0, zoneRedundant = 0;
    for (const r of inv) {
      const z = (r.zones || []).map(String).filter((x) => ['1', '2', '3'].includes(x));
      if (z.length >= 1) zonePinned++;
      if (z.length >= 2) zoneRedundant++;
    }
    res.json({ ...p, resiliency: { total: inv.length, zonePinned, zoneRedundant } });
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  }
});

// Subscription-wide operations: backup/BCDR, monitoring footprint, change tracking.
app.get('/api/ops', async (req, res) => {
  const sub = req.query.sub;
  if (!sub) return res.status(400).json({ error: 'sub query param required' });
  try {
    res.json(await cached(`ops:${sub}`, 10 * 60 * 1000, () => getOps(sub)));
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  }
});

// Raw cost query passthrough (groupBy ServiceName / ResourceType / etc.)
app.get('/api/cost', async (req, res) => {
  const sub = req.query.sub;
  if (!sub) return res.status(400).json({ error: 'sub query param required' });
  const { from, to } = rangeToDates(req.query.range, req.query.from, req.query.to);
  const groupBy = req.query.groupBy || 'ServiceName';
  const granularity = req.query.granularity || 'None';
  try {
    const rows = await costQueryCached(sub, from, to, groupBy, granularity);
    res.json({ from, to, groupBy, rows });
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  }
});

// ---- FinOps analytics ----------------------------------------------------
const dkey = (d) => d.toISOString().slice(0, 10);
const resName = (id) => String(id).split('/').pop();
const daysOf = (from, to) => Math.max(1, Math.round((to - from) / 86400000));

async function costQueryCached(sub, from, to, groupBy, granularity = 'None') {
  const key = `costq:${sub}:${groupBy}:${granularity}:${dkey(from)}:${dkey(to)}`;
  return cached(key, 30 * 60 * 1000, async () => {
    const disk = await getDisk(key, 24 * 60 * 60 * 1000);
    if (disk) return disk;
    const rows = await queryCost({ subscriptionId: sub, from, to, groupBy, granularity });
    setDisk(key, rows);
    return rows;
  });
}
function aggTop(rows, n) {
  const m = new Map();
  for (const r of rows) { if (!r.key) continue; m.set(r.key, (m.get(r.key) || 0) + r.cost); }
  return [...m.entries()].map(([name, cost]) => ({ name, cost })).sort((a, b) => b.cost - a.cost).slice(0, n);
}

// KPI summary: spend, delta vs previous equal period, burn rate, forecast, counts, tags, top service.
app.get('/api/summary', async (req, res) => {
  const sub = req.query.sub;
  if (!sub) return res.status(400).json({ error: 'sub query param required' });
  const { from, to } = rangeToDates(req.query.range, req.query.from, req.query.to);
  try {
    const inv = await cached(`inv:${sub}`, 5 * 60 * 1000, () => getInventory(sub));
    const costMap = await costByResource(sub, from, to).catch(() => new Map());
    let total = 0; for (const v of costMap.values()) total += v;

    const span = to - from;
    const prevFrom = new Date(from.getTime() - span);
    const prevTo = new Date(from.getTime());
    let prevTotal = 0;
    try { const pm = await costByResource(sub, prevFrom, prevTo); for (const v of pm.values()) prevTotal += v; } catch { /* optional */ }

    let topService = null;
    try { topService = aggTop(await costQueryCached(sub, from, to, 'ServiceName'), 1)[0] || null; } catch { /* optional */ }

    const regions = new Set(), rgs = new Set();
    let tagged = 0;
    for (const r of inv) {
      regions.add(r.location);
      if (r.resourceGroup) rgs.add(r.resourceGroup);
      if (r.tags && Object.keys(r.tags).length) tagged++;
    }
    const days = daysOf(from, to);
    const dailyBurn = total / days;
    res.json({
      currency: costMap.currency || 'USD',
      totalCost: total, prevCost: prevTotal,
      deltaPct: prevTotal > 0 ? ((total - prevTotal) / prevTotal) * 100 : null,
      dailyBurn, forecast30: dailyBurn * 30,
      resourceCount: inv.length, regionCount: regions.size, rgCount: rgs.size,
      taggedCount: tagged, untaggedCount: inv.length - tagged,
      taggedPct: inv.length ? (tagged / inv.length) * 100 : 0,
      topService, days,
    });
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  }
});

// Charts: daily trend + cost by service + cost by resource type + top resources.
app.get('/api/analytics', async (req, res) => {
  const sub = req.query.sub;
  if (!sub) return res.status(400).json({ error: 'sub query param required' });
  const { from, to } = rangeToDates(req.query.range, req.query.from, req.query.to);
  try {
    const inv = await cached(`inv:${sub}`, 5 * 60 * 1000, () => getInventory(sub));
    const costMap = await costByResource(sub, from, to).catch(() => new Map());
    // Run Cost Management breakdowns sequentially — concurrent calls get 429-throttled.
    const byServiceRows = await costQueryCached(sub, from, to, 'ServiceName').catch(() => []);
    const byTypeRows = await costQueryCached(sub, from, to, 'ResourceType').catch(() => []);
    const trendRows = await costQueryCached(sub, from, to, '', 'Daily').catch(() => []);
    const trend = trendRows
      .map((r) => ({ date: normalizeDate(r.date), cost: r.cost }))
      .filter((r) => r.date)
      .sort((a, b) => a.date.localeCompare(b.date));
    const invById = new Map(inv.map((r) => [r.id.toLowerCase(), r]));
    const { byInv } = attributeCostToInventory(costMap, inv);
    const topResources = [...byInv.entries()]
      .map(([id, cost]) => {
        const r = invById.get(id);
        return { id: r?.id || id, name: r?.name || resName(id), type: r?.type || '', location: r?.location || '', resourceGroup: r?.resourceGroup || '', cost };
      })
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 15);
    res.json({ currency: costMap.currency || 'USD', trend, byService: aggTop(byServiceRows, 12), byType: aggTop(byTypeRows, 12), topResources, costById: Object.fromEntries(byInv) });
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  }
});

function normalizeDate(v) {
  const s = String(v);
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// Optimization: orphaned/idle waste + tag governance, with estimated monthly savings.
app.get('/api/optimize', async (req, res) => {
  const sub = req.query.sub;
  if (!sub) return res.status(400).json({ error: 'sub query param required' });
  const { from, to } = rangeToDates(req.query.range, req.query.from, req.query.to);
  try {
    const [findings, inv] = await Promise.all([
      cached(`opt:${sub}`, 5 * 60 * 1000, () => getOptimizationFindings(sub)),
      cached(`inv:${sub}`, 5 * 60 * 1000, () => getInventory(sub)),
    ]);
    const costMap = await costByResource(sub, from, to).catch(() => new Map());
    const days = daysOf(from, to);
    const monthly = (cost) => (cost / days) * 30;

    const labels = {
      'unattached-disk': 'Unattached managed disks',
      'unassociated-pip': 'Unassociated public IPs',
      'unattached-nic': 'Unattached network interfaces',
      'empty-app-service-plan': 'Empty App Service plans',
      'stopped-vm': 'Stopped (still billed) VMs',
    };
    const groups = new Map();
    for (const f of findings) {
      if (!groups.has(f.reason)) groups.set(f.reason, { id: f.reason, label: labels[f.reason] || f.reason, count: 0, monthlyCost: 0, resources: [] });
      const g = groups.get(f.reason);
      const m = monthly(costMap.get(f.id.toLowerCase()) || 0);
      g.count++; g.monthlyCost += m;
      if (g.resources.length < 60) g.resources.push({ id: f.id, name: f.name, type: f.type, location: f.location, resourceGroup: f.resourceGroup, monthlyCost: m });
    }
    const findingGroups = [...groups.values()].sort((a, b) => b.monthlyCost - a.monthlyCost || b.count - a.count);
    const estimatedMonthlySavings = findingGroups.reduce((s, g) => s + g.monthlyCost, 0);

    const untaggedList = inv
      .filter((r) => !r.tags || Object.keys(r.tags).length === 0)
      .map((r) => ({ id: r.id, name: r.name, type: r.type, location: r.location, resourceGroup: r.resourceGroup, monthlyCost: monthly(costMap.get(r.id.toLowerCase()) || 0) }))
      .sort((a, b) => b.monthlyCost - a.monthlyCost);
    const untagged = { id: 'untagged', label: 'Untagged resources', count: untaggedList.length, monthlyCost: untaggedList.reduce((s, r) => s + r.monthlyCost, 0), resources: untaggedList.slice(0, 60) };

    let tagged = 0, missingOwner = 0, missingCC = 0, missingEnv = 0;
    for (const r of inv) {
      const keys = new Set(Object.keys(r.tags || {}).map((k) => k.toLowerCase()));
      if (keys.size) tagged++;
      if (!keys.has('owner')) missingOwner++;
      if (!keys.has('costcenter') && !keys.has('cost-center') && !keys.has('cost_center')) missingCC++;
      if (!keys.has('environment') && !keys.has('env')) missingEnv++;
    }
    res.json({
      currency: costMap.currency || 'USD',
      estimatedMonthlySavings,
      findings: findingGroups,
      untagged,
      governance: { total: inv.length, tagged, taggedPct: inv.length ? (tagged / inv.length) * 100 : 0, missingOwner, missingCostCenter: missingCC, missingEnv },
    });
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  }
});

// ---- AI Insights + Analyst (rule-based; LLM-pluggable) -------------------
function fmtMoney(n, cur = 'USD') {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: Math.abs(n) >= 100 ? 0 : 2 }).format(n); }
  catch { return `$${Number(n || 0).toFixed(2)}`; }
}

async function buildFinopsContext(sub, from, to) {
  const inv = await cached(`inv:${sub}`, 5 * 60 * 1000, () => getInventory(sub));
  const costMap = await costByResource(sub, from, to).catch(() => new Map());
  const { byInv } = attributeCostToInventory(costMap, inv);
  let total = 0; for (const v of costMap.values()) total += v;
  const span = to - from;
  const days = daysOf(from, to);
  const prevFrom = new Date(from.getTime() - span);
  const prevTo = new Date(from.getTime());
  let prevTotal = 0;
  try { const pm = await costByResource(sub, prevFrom, prevTo); for (const v of pm.values()) prevTotal += v; } catch { /* optional */ }
  const byService = aggTop(await costQueryCached(sub, from, to, 'ServiceName').catch(() => []), 100);
  const trendRows = await costQueryCached(sub, from, to, '', 'Daily').catch(() => []);
  const trend = trendRows.map((r) => ({ date: normalizeDate(r.date), cost: r.cost })).filter((r) => r.date).sort((a, b) => a.date.localeCompare(b.date));
  const findings = await cached(`opt:${sub}`, 5 * 60 * 1000, () => getOptimizationFindings(sub)).catch(() => []);
  let tagged = 0; for (const r of inv) if (r.tags && Object.keys(r.tags).length) tagged++;
  return { sub, from, to, days, currency: costMap.currency || 'USD', inv, costMap, byInv, total, prevTotal, byService, trend, findings, tagged, untagged: inv.length - tagged };
}

function computeInsights(ctx) {
  const cur = ctx.currency;
  const m = (n) => fmtMoney(n, cur);
  const monthly = (c) => (c / ctx.days) * 30;
  const out = [];

  if (ctx.prevTotal > 0) {
    const pct = ((ctx.total - ctx.prevTotal) / ctx.prevTotal) * 100;
    out.push({ id: 'trend', severity: Math.abs(pct) >= 25 ? 'warn' : 'info', title: `Spend ${pct >= 0 ? 'up' : 'down'} ${Math.abs(pct).toFixed(0)}% vs previous ${ctx.days}d`, detail: `${m(ctx.total)} this period vs ${m(ctx.prevTotal)} prior.`, impact: ctx.total - ctx.prevTotal });
  }
  if (ctx.trend.length >= 5) {
    const vals = ctx.trend.map((t) => t.cost);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const std = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
    let peak = null;
    for (const t of ctx.trend) if (t.cost > mean + 2 * std && t.cost > mean * 1.5 && (!peak || t.cost > peak.cost)) peak = t;
    if (peak) out.push({ id: 'anomaly', severity: 'warn', title: `Cost spike on ${peak.date}`, detail: `${m(peak.cost)} that day — ${(peak.cost / (mean || 1)).toFixed(1)}× the ${m(mean)} daily average. Investigate what was deployed/scaled.`, impact: peak.cost - mean });
  }
  const burn = ctx.total / ctx.days;
  out.push({ id: 'forecast', severity: 'info', title: `Projected ~${m(burn * 30)} / 30 days`, detail: `At the current run-rate of ${m(burn)}/day; ≈ ${m(burn * 7)} over the next 7 days.` });

  const top = ctx.byService[0];
  if (top && ctx.total > 0) {
    const pct = (top.cost / ctx.total) * 100;
    if (pct >= 35) {
      const isStorage = /storage/i.test(top.name);
      out.push({ id: 'concentration', severity: 'opportunity', title: `${top.name} is ${pct.toFixed(0)}% of spend`, detail: isStorage ? `Move cold blob/file data to Cool/Archive tiers and enable lifecycle management to cut storage cost.` : `Largest cost driver at ${m(top.cost)} — review SKU/tier and usage.`, action: isStorage ? 'Storage lifecycle / tiering' : 'Review SKU' });
    }
  }
  const vm = ctx.byService.find((s) => /virtual machines|^compute/i.test(s.name));
  if (vm && monthly(vm.cost) >= 30) {
    const est = monthly(vm.cost) * 0.35;
    out.push({ id: 'reserved', severity: 'opportunity', title: 'Buy Reserved Instances / Savings Plan', detail: `Compute ≈ ${m(monthly(vm.cost))}/mo. A 1-yr RI or Savings Plan typically saves ~30–40% on steady workloads (est. ${m(est)}/mo).`, impact: -est, action: 'Reservations' });
  }
  let orphanMonthly = 0, orphanCount = 0;
  for (const f of ctx.findings) { orphanMonthly += monthly(ctx.costMap.get(f.id.toLowerCase()) || 0); orphanCount++; }
  if (orphanCount) out.push({ id: 'waste', severity: orphanMonthly > 1 ? 'opportunity' : 'info', title: `${orphanCount} orphaned / idle resources`, detail: `≈ ${m(orphanMonthly)}/mo in unattached disks/IPs/NICs, empty plans or stopped-but-billed VMs. See the Optimize tab.`, impact: -orphanMonthly, action: 'Optimize' });
  if (ctx.untagged > 0) {
    let untaggedMonthly = 0;
    for (const r of ctx.inv) if (!r.tags || !Object.keys(r.tags).length) untaggedMonthly += monthly(ctx.costMap.get(r.id.toLowerCase()) || 0);
    out.push({ id: 'untagged', severity: 'warn', title: `${ctx.untagged} untagged resources`, detail: `≈ ${m(untaggedMonthly)}/mo of spend can't be allocated. Enforce owner/cost-center tags via Azure Policy.`, action: 'Azure Policy: require tags' });
  }
  const rank = { opportunity: 0, warn: 1, info: 2 };
  out.sort((a, b) => (rank[a.severity] - rank[b.severity]) || (Math.abs(b.impact || 0) - Math.abs(a.impact || 0)));
  return out;
}

function answerQuestion(ctx, q) {
  const cur = ctx.currency;
  const m = (n) => fmtMoney(n, cur);
  const monthly = (c) => (c / ctx.days) * 30;
  const ql = String(q || '').toLowerCase();
  const invById = new Map(ctx.inv.map((r) => [r.id.toLowerCase(), r]));
  if (/untag/.test(ql)) {
    let mm = 0, c = 0;
    for (const r of ctx.inv) if (!r.tags || !Object.keys(r.tags).length) { c++; mm += monthly(ctx.costMap.get(r.id.toLowerCase()) || 0); }
    return { answer: `${c} resources are untagged (≈ ${m(mm)}/mo of unallocatable spend). Enforce owner/cost-center tags with Azure Policy.` };
  }
  if (/sav|waste|orphan|idle|optimi|reserv/.test(ql)) {
    let mm = 0, c = 0;
    for (const f of ctx.findings) { c++; mm += monthly(ctx.costMap.get(f.id.toLowerCase()) || 0); }
    const vm = ctx.byService.find((s) => /virtual machines|^compute/i.test(s.name));
    const ri = vm ? ` Compute is ${m(monthly(vm.cost))}/mo — an RI/Savings Plan could save ~30–40%.` : '';
    return { answer: `${c} orphaned/idle resources ≈ ${m(mm)}/mo.${ri} See the Optimize tab for the list.` };
  }
  if (/forecast|predict|project|run.?rate|next/.test(ql)) {
    const b = ctx.total / ctx.days;
    return { answer: `At ${m(b)}/day, expect ~${m(b * 30)}/30d and ${m(b * 7)} over the next 7 days.` };
  }
  if (/region|location|where/.test(ql)) {
    const byR = new Map();
    for (const r of ctx.inv) byR.set(r.location, (byR.get(r.location) || 0) + (ctx.byInv.get(r.id.toLowerCase()) || 0));
    const top = [...byR.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    return { answer: `Top regions by attributed cost: ${top.map(([k, v]) => `${k} ${m(v)}`).join(', ')}.` };
  }
  if (/service/.test(ql)) {
    return { answer: `Top services: ${ctx.byService.slice(0, 5).map((s) => `${s.name} ${m(s.cost)}`).join(', ')}.` };
  }
  if (/top|expensive|biggest|highest|driver/.test(ql)) {
    const top = [...ctx.byInv.entries()].map(([id, c]) => ({ r: invById.get(id), c })).filter((x) => x.r).sort((a, b) => b.c - a.c).slice(0, 5);
    const svc = ctx.byService[0];
    return { answer: `Biggest driver: ${svc ? `${svc.name} (${m(svc.cost)})` : 'n/a'}. Top resources: ${top.map((x) => `${x.r.name} ${m(x.c)}`).join(', ')}.` };
  }
  if (/increase|why|spike|grow|anomal|change|up\b/.test(ql)) {
    const pct = ctx.prevTotal > 0 ? ((ctx.total - ctx.prevTotal) / ctx.prevTotal) * 100 : null;
    return { answer: pct == null ? 'No prior-period baseline to compare.' : `Spend is ${pct >= 0 ? 'up' : 'down'} ${Math.abs(pct).toFixed(0)}% vs the previous ${ctx.days} days (${m(ctx.total)} vs ${m(ctx.prevTotal)}). ${ctx.byService[0] ? `${ctx.byService[0].name} is the largest driver.` : ''}` };
  }
  if (/total|spend|cost|bill|how much/.test(ql)) {
    return { answer: `Total spend is ${m(ctx.total)} over the last ${ctx.days} days across ${ctx.inv.length} resources.` };
  }
  return { answer: `Over ${ctx.days}d: ${m(ctx.total)} total · top service ${ctx.byService[0]?.name || 'n/a'} · ${ctx.untagged} untagged · ${ctx.findings.length} orphaned/idle. Try: "top costs", "untagged", "savings", "forecast", "why did spend change", "by region".` };
}

app.get('/api/insights', async (req, res) => {
  const sub = req.query.sub;
  if (!sub) return res.status(400).json({ error: 'sub query param required' });
  const { from, to } = rangeToDates(req.query.range, req.query.from, req.query.to);
  try {
    const ctx = await buildFinopsContext(sub, from, to);
    res.json({ currency: ctx.currency, insights: computeInsights(ctx) });
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  }
});

app.get('/api/ask', async (req, res) => {
  const sub = req.query.sub;
  if (!sub) return res.status(400).json({ error: 'sub query param required' });
  const { from, to } = rangeToDates(req.query.range, req.query.from, req.query.to);
  try {
    const ctx = await buildFinopsContext(sub, from, to);
    res.json({ q: req.query.q || '', ...answerQuestion(ctx, req.query.q || '') });
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  }
});

// MCP-style manifest: lets Copilot/LLMs discover the FinOps tools (REST endpoints).
app.get('/api/mcp', (_req, res) => {
  res.json({
    name: 'azure-finops-map',
    version: '0.2.0',
    description: 'Azure FinOps Map — cost, inventory, optimization and insights across your Azure subscriptions.',
    tools: [
      { name: 'list_subscriptions', method: 'GET', path: '/api/context', params: [], description: 'List accessible subscriptions.' },
      { name: 'cost_summary', method: 'GET', path: '/api/summary', params: ['sub', 'range'], description: 'KPI summary: spend, Δ vs prev, burn, forecast, counts, tags.' },
      { name: 'analytics', method: 'GET', path: '/api/analytics', params: ['sub', 'range'], description: 'Daily trend, cost by service & type, top resources.' },
      { name: 'optimize', method: 'GET', path: '/api/optimize', params: ['sub', 'range'], description: 'Orphaned/idle waste + tag governance + estimated savings.' },
      { name: 'insights', method: 'GET', path: '/api/insights', params: ['sub', 'range'], description: 'AI recommendations: anomalies, forecast, RI/Savings Plan, tiering, tagging.' },
      { name: 'ask', method: 'GET', path: '/api/ask', params: ['sub', 'q'], description: 'Ask a natural-language FinOps question.' },
      { name: 'resource_detail', method: 'GET', path: '/api/resource', params: ['id', 'range'], description: 'Properties + metrics + daily cost for a resource.' },
    ],
  });
});

function errMsg(err) {
  const m = err?.message || String(err);
  if (/AzureCliCredential|az login|not logged in|ENOENT/.test(m)) {
    return 'Azure CLI auth failed — run `az login` in a terminal, then retry. (' + m + ')';
  }
  return m;
}

if (sqlCache.isEnabled()) {
  sqlCache.ensureSchema().then(() => console.log('[sql] cost cache schema ready')).catch((e) => console.warn('[sql] schema init failed:', e.message));
}

// Marketing deck: short link that forces a download with a friendly filename.
// (The raw file is also served statically at /downloads/azure-infra-world-map-deck.pdf.)
if (serveStatic) {
  app.get('/deck', (_req, res) =>
    res.download(join(distDir, 'downloads', 'azure-infra-world-map-deck.pdf'), 'Azure Infra World Map - Deck.pdf'));
}

// SPA fallback: when serving the built UI, return index.html for any non-API GET
// so browser refreshes and deep links resolve to the app.
if (serveStatic) {
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(distDir, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`[api] listening on :${PORT}  (static=${serveStatic}, sqlCache=${sqlCache.isEnabled()})`);
});
