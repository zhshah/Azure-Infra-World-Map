import type {
  ContextResp, RegionsResp, TreeResp, LinkageResp, InventoryResp, ResourceDetail, SubPathResp,
  SummaryResp, AnalyticsResp, OptimizeResp, InsightsResp, AskResp,
  SecurityResp, RecommendationsResp, ChangesResp, ActivityResp, RegionZonesResp, PostureResp, OpsResp,
  MetricsDetailResp, WhatsNewResp, MgTreeResp, PortfolioResp, PortfolioCostResp,
  ResourceFacetsResp, TabsResp, SavedTab, ServiceHealthResp, AlertsResp, CostResp,
} from './types';

async function get<T>(url: string): Promise<T> {
  const resp = await fetch(url);
  if (!resp.ok) {
    let msg = `${resp.status} ${resp.statusText}`;
    try { const j = await resp.json(); if (j.error) msg = j.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return resp.json() as Promise<T>;
}

async function send<T>(method: string, url: string, body?: unknown): Promise<T> {
  const resp = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    let msg = `${resp.status} ${resp.statusText}`;
    try { const j = await resp.json(); if (j.error) msg = j.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return resp.json() as Promise<T>;
}

export const api = {
  context: () => get<ContextResp>('/api/context'),
  regions: (sub: string, range: string, fast = false) =>
    get<RegionsResp>(`/api/regions?sub=${encodeURIComponent(sub)}&range=${range}${fast ? '&fast=1' : ''}`),
  tree: (sub: string, range: string) =>
    get<TreeResp>(`/api/tree?sub=${encodeURIComponent(sub)}&range=${range}`),
  linkage: (sub: string) => get<LinkageResp>(`/api/linkage?sub=${encodeURIComponent(sub)}`),
  subPath: (sub: string) => get<SubPathResp>(`/api/sub-path?sub=${encodeURIComponent(sub)}`),
  summary: (sub: string, range: string) => get<SummaryResp>(`/api/summary?sub=${encodeURIComponent(sub)}&range=${range}`),
  analytics: (sub: string, range: string) => get<AnalyticsResp>(`/api/analytics?sub=${encodeURIComponent(sub)}&range=${range}`),
  cost: (sub: string, groupBy: string, granularity: string, range: string, from?: string, to?: string) =>
    get<CostResp>(`/api/cost?sub=${encodeURIComponent(sub)}&groupBy=${encodeURIComponent(groupBy)}&granularity=${granularity}${from && to ? `&from=${from}&to=${to}` : `&range=${range}`}`),
  optimize: (sub: string, range: string) => get<OptimizeResp>(`/api/optimize?sub=${encodeURIComponent(sub)}&range=${range}`),
  insights: (sub: string, range: string) => get<InsightsResp>(`/api/insights?sub=${encodeURIComponent(sub)}&range=${range}`),
  ask: (sub: string, range: string, q: string) =>
    get<AskResp>(`/api/ask?sub=${encodeURIComponent(sub)}&range=${range}&q=${encodeURIComponent(q)}`),
  inventory: (sub: string) => get<InventoryResp>(`/api/inventory?sub=${encodeURIComponent(sub)}`),
  resource: (id: string, range: string) =>
    get<ResourceDetail>(`/api/resource?id=${encodeURIComponent(id)}&range=${range}`),
  resourceSecurity: (id: string) => get<SecurityResp>(`/api/resource-security?id=${encodeURIComponent(id)}`),
  resourceRecommendations: (id: string) => get<RecommendationsResp>(`/api/resource-recommendations?id=${encodeURIComponent(id)}`),
  resourceChanges: (id: string) => get<ChangesResp>(`/api/resource-changes?id=${encodeURIComponent(id)}`),
  resourceActivity: (id: string) => get<ActivityResp>(`/api/resource-activity?id=${encodeURIComponent(id)}`),
  resourceMetrics: (id: string, window = '6h') => get<MetricsDetailResp>(`/api/resource-metrics?id=${encodeURIComponent(id)}&window=${encodeURIComponent(window)}`),
  regionZones: (subs: string | string[], region: string, range: string) =>
    get<RegionZonesResp>(`/api/region-zones?subs=${encodeURIComponent(Array.isArray(subs) ? subs.join(',') : subs)}&region=${encodeURIComponent(region)}&range=${range}`),
  posture: (sub: string) => get<PostureResp>(`/api/posture?sub=${encodeURIComponent(sub)}`),
  ops: (sub: string) => get<OpsResp>(`/api/ops?sub=${encodeURIComponent(sub)}`),
  serviceHealth: (sub: string) => get<ServiceHealthResp>(`/api/service-health?sub=${encodeURIComponent(sub)}`),
  alerts: (sub: string) => get<AlertsResp>(`/api/alerts?sub=${encodeURIComponent(sub)}`),
  whatsNew: () => get<WhatsNewResp>('/api/whats-new'),
  mgTree: () => get<MgTreeResp>('/api/mg-tree'),
  portfolio: (mg: string) => get<PortfolioResp>(`/api/portfolio?mg=${encodeURIComponent(mg)}`),
  portfolioCost: (mg: string, range: string) => get<PortfolioCostResp>(`/api/portfolio-cost?mg=${encodeURIComponent(mg)}&range=${range}`),
  resourceFacets: (sub: string, range: string) => get<ResourceFacetsResp>(`/api/resource-facets?sub=${encodeURIComponent(sub)}&range=${range}`),
  listTabs: () => get<TabsResp>('/api/tabs'),
  saveTab: (tab: SavedTab) => send<{ ok: boolean; persisted: boolean }>('PUT', '/api/tabs', tab),
  deleteTab: (id: string) => send<{ ok: boolean; persisted: boolean }>('DELETE', `/api/tabs?id=${encodeURIComponent(id)}`),
};
