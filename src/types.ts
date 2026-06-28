export interface Subscription {
  subscriptionId: string;
  displayName: string;
  state: string;
  tenantId?: string;
}

export interface ContextResp {
  subscriptions: Subscription[];
  defaultSubscriptionId: string | null;
  sqlCache: boolean;
  user?: string | null;
  tenantId?: string | null;
}

export interface RegionAgg {
  region: string;
  display: string;
  geo: string | null;
  count: number;
  cost: number;
  types: Record<string, number>;
  lat: number | null;
  lon: number | null;
}

export interface RegionsResp {
  currency: string;
  regions: RegionAgg[];
  unassignedCost?: number;
  costError?: string | null;
}

export interface ResourceNode {
  id: string;
  name: string;
  type: 'resource';
  resourceType: string;
  location: string;
  cost: number;
}

export interface RgNode {
  name: string;
  type: 'resourceGroup';
  cost: number;
  children: ResourceNode[];
}

export interface TreeResp {
  currency: string;
  tree: { id: string; name: string; type: string; cost: number; children: RgNode[] };
}

export interface LinkageEdge { from: string; to: string; }
export interface LinkageResp { count: number; edges: LinkageEdge[]; }

export interface InventoryResource {
  id: string; name: string; type: string; kind: string | null;
  location: string; resourceGroup: string | null; subscriptionId: string | null;
  sku: unknown; tags: Record<string, string> | null; managedBy: string | null;
  zones?: string[];
  references: string[];
}
export interface InventoryResp { count: number; resources: InventoryResource[]; }

// ---- Custom tabs (savable, filtered resource views) -----------------------
export interface ResourceFacetsResp {
  currency: string;
  cost: Record<string, number>;
  sec: Record<string, number>;
  health: Record<string, string>;
  power: Record<string, string>;
}
export interface TabFilter { text?: string; types?: string[]; rgs?: string[]; tagKey?: string; tagVal?: string; }
export interface SavedTab {
  id: string;
  name: string;
  position?: number;
  filter: TabFilter;
  columns: string[];
  sort?: { col: string; dir: 'asc' | 'desc' };
}
export interface TabsResp { persisted: boolean; tabs: SavedTab[]; }

// ---- Service Health + active Azure Monitor alerts -------------------------
export interface ServiceHealthEvent {
  title: string; eventType: string; level: string; trackingId: string; lastUpdate: string;
  status: 'issue' | 'maintenance' | 'advisory' | string;
  services: string[]; regions: string[]; regionCodes: string[];
}
export interface RegionHealth { status: string; rank: number; count: number; }
export interface ServiceHealthResp {
  events: ServiceHealthEvent[];
  byRegion: Record<string, RegionHealth>;
  fetchedAt?: number; error?: string;
}
export interface AlertItem {
  alertId: string; name: string; severity: string; alertState: string;
  targetResource: string; targetType: string; signalType: string;
  monitorService: string; fired: string; description: string;
}
export interface AlertsResp {
  alerts: AlertItem[]; total: number; sevCounts: Record<string, number>;
  fetchedAt?: number; error?: string;
}

export interface MetricSeries { name: string; unit: string; points: { t: string; v: number | null }[]; }
export interface MetricDetailSeries {
  name: string; unit: string;
  points: { t: string; avg: number | null; max?: number | null }[];
  last: number | null; avg: number | null; min: number | null; max: number | null;
}
export interface MetricsDetailResp {
  supported: boolean; reason?: string; available?: string[];
  duration?: string; grain?: string; series: MetricDetailSeries[];
  _stale?: boolean; _snapshotAt?: number;
}
export interface ResourceHealth { state: string; summary?: string; since?: string; }
export interface ResourceDetail {
  id: string;
  resource?: any;
  resourceError?: string;
  health?: ResourceHealth | null;
  powerState?: string | null;
  metrics?: { supported: boolean; reason?: string; available?: string[]; series: MetricSeries[] };
  cost?: { total?: number; currency?: string; series: { date: string; cost: number }[]; error?: string };
}

export interface SecurityFinding { name: string; status: string; severity: string; description?: string; remediation?: string; }
export interface SecurityResp { supported: boolean; reason?: string; findings: SecurityFinding[]; }
export interface Recommendation { category: string; impact: string; problem: string; solution: string; }
export interface RecommendationsResp { supported: boolean; reason?: string; recommendations: Recommendation[]; }
export interface ChangeProp { name: string; from: unknown; to: unknown; }
export interface ChangeItem { ts: string; changeType: string; changedBy: string; props: ChangeProp[]; }
export interface ChangesResp { supported: boolean; reason?: string; changes: ChangeItem[]; }
export interface ActivityItem { ts: string; operation: string; status: string; level: string; caller: string; }
export interface ActivityResp { supported: boolean; reason?: string; events: ActivityItem[]; }

export interface ZoneResource { id: string; name: string; type: string; resourceGroup: string | null; cost: number; zoneRedundant: boolean; subscriptionId?: string; subscriptionName?: string; tags?: Record<string, string> | null; }
export interface ZoneBucket { zone: string; count: number; cost: number; resources: ZoneResource[]; }
export interface RegionZonesResp { region: string; display: string; currency: string; total: number; count: number; zones: ZoneBucket[]; subscriptions?: { subscriptionId: string; displayName: string; count: number }[]; }

export interface PostureResp {
  security: { severity: string; status: string; count: number }[];
  securityError?: string;
  secureScore?: { current: number; max: number; pct: number };
  advisor: { category: string; impact: string; count: number }[];
  advisorError?: string;
  serviceHealth: { title: string; eventType: string; level: string }[];
  resiliency: { total: number; zonePinned: number; zoneRedundant: number };
}

export interface OpsResp {
  backup: { protectedItems: number; vaults: number; error?: string };
  vmCount: number;
  monitoredVms: number;
  changes: { ts: string; changeType: string; target: string }[];
  changesError?: string;
}

export interface WhatsNewVideo { videoId: string; title: string; published: string; thumb: string; category: string; }
export interface WhatsNewChannel { id: string; name: string; channelId?: string; event?: boolean; videos: WhatsNewVideo[]; }
export interface WhatsNewUpdate { id: string; title: string; url: string; status: string; date: string; products: string[]; description?: string; category: string; }
export interface BuildSession { code: string; title: string; type: string; level: number; topic: string; speaker: string; url: string; }
export interface BuildCatalog { event: string; url: string; sessions: BuildSession[]; videos: WhatsNewVideo[]; topics: string[]; types: string[]; levels: number[]; }
export interface WhatsNewResp {
  updates: WhatsNewUpdate[];
  channels: WhatsNewChannel[];
  build?: BuildCatalog;
  categories: { id: string; label: string }[];
  fetchedAt: number;
  _stale?: boolean;
}

export interface MgNode {
  id: string; name: string; displayName: string; type: 'mg' | 'subscription';
  descendants: number; access?: string; children: MgNode[];
}
export interface MgTreeResp { tree: MgNode | null; counts?: { mgs: number; subscriptions: number }; error?: string; }
export interface PortfolioSub {
  subscriptionId: string; displayName: string; resources: number; zonePinned: number;
  secHigh: number; secMed: number; secLow: number; advisor: number; advByCat: Record<string, number>; cost?: number;
}
export interface PortfolioResp {
  mg: string; subs: PortfolioSub[];
  totals: { subscriptions: number; resources: number; zonePinned: number; secHigh: number; secMed: number; secLow: number; advisor: number };
  errors?: Record<string, string>;
}
export interface PortfolioCostResp { byId: Record<string, number>; currency?: string; error?: string; }

export interface AppState {
  subscriptionId: string | null;
  range: string;
  showLinkage: boolean;
  currency: string;
  selectedResourceId: string | null;
}

export interface SubPathResp {
  managementGroups: { name: string; displayName: string; type: string }[];
  subscription: { id: string; name: string; type: string };
  error?: string;
}

export interface SummaryResp {
  currency: string;
  totalCost: number; prevCost: number; deltaPct: number | null;
  dailyBurn: number; forecast30: number;
  resourceCount: number; regionCount: number; rgCount: number;
  taggedCount: number; untaggedCount: number; taggedPct: number;
  topService: { name: string; cost: number } | null; days: number;
}

export interface AnalyticsResp {
  currency: string;
  trend: { date: string; cost: number }[];
  byService: { name: string; cost: number }[];
  byType: { name: string; cost: number }[];
  topResources: { id: string; name: string; type: string; location: string; resourceGroup: string; cost: number }[];
  costById?: Record<string, number>;
}

export interface CostRow { key: string; cost: number; date: string | null; currency: string; }
export interface CostResp { from: string; to: string; groupBy: string; rows: CostRow[]; }

export interface OptimizeFinding {
  id: string; label: string; count: number; monthlyCost: number;
  resources: { id: string; name: string; type?: string; location: string; resourceGroup: string; monthlyCost: number }[];
}
export interface OptimizeResp {
  currency: string;
  estimatedMonthlySavings: number;
  findings: OptimizeFinding[];
  untagged: OptimizeFinding;
  governance: { total: number; tagged: number; taggedPct: number; missingOwner: number; missingCostCenter: number; missingEnv: number };
}

export interface Insight {
  id: string;
  severity: 'opportunity' | 'warn' | 'info';
  title: string;
  detail: string;
  impact?: number;
  action?: string;
}
export interface InsightsResp { currency: string; insights: Insight[]; }
export interface AskResp { q: string; answer: string; }
