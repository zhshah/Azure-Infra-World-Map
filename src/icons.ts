// Inline SVG icon set for Azure resource types (stroke = currentColor, no deps).
// typeIcon(type) returns an <svg> string sized for inline use.

function wrap(inner: string, cls = 'rty-ico'): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

// Each entry: keyword match → [svg inner, tint color].
const ICONS: { test: RegExp; svg: string; color: string }[] = [
  // Virtual machines
  { test: /virtualmachines\/extensions/, color: '#7aa2ff', svg: '<rect x="3" y="5" width="18" height="12" rx="1.5"/><path d="M8 21h8M12 17v4"/><circle cx="17" cy="11" r="1.4"/>' },
  { test: /virtualmachinescalesets|\/scalesets/, color: '#3bd6ff', svg: '<rect x="3" y="4" width="13" height="9" rx="1"/><rect x="8" y="11" width="13" height="9" rx="1"/>' },
  { test: /microsoft\.compute\/virtualmachines|\/virtualmachines$/, color: '#3bd6ff', svg: '<rect x="3" y="5" width="18" height="12" rx="1.5"/><path d="M8 21h8M12 17v4"/><path d="M7 9h6M7 12h4"/>' },
  { test: /\/disks|\/snapshots/, color: '#9aa7ff', svg: '<ellipse cx="12" cy="6" rx="7" ry="2.6"/><path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6"/>' },
  // Containers
  { test: /managedclusters|kubernetes|\/aks/, color: '#3b82f6', svg: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><circle cx="12" cy="12" r="2.4"/><path d="M12 3v6.6M19 7.5l-5 3M5 7.5l5 3M12 21v-6.4"/>' },
  { test: /containerapps|\/managedenvironments/, color: '#34d399', svg: '<rect x="3" y="7" width="8" height="6" rx="1"/><rect x="13" y="7" width="8" height="6" rx="1"/><rect x="8" y="14" width="8" height="6" rx="1"/>' },
  { test: /containerinstance|\/containergroups/, color: '#34d399', svg: '<rect x="4" y="8" width="7" height="8" rx="1"/><rect x="13" y="8" width="7" height="8" rx="1"/>' },
  { test: /registries|\/acr/, color: '#60a5fa', svg: '<rect x="4" y="9" width="6" height="6"/><rect x="14" y="9" width="6" height="6"/><path d="M10 12h4"/>' },
  // Functions / web
  { test: /\/sites.*function|functionapp|microsoft\.web\/sites.*func/, color: '#facc15', svg: '<path d="M13 3L5 13h6l-2 8 10-12h-7z"/>' },
  { test: /microsoft\.web\/sites|\/serverfarms|appservice/, color: '#38bdf8', svg: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.3 2.6 14.7 0 17M12 3.5c-2.6 2.3-2.6 14.7 0 17"/>' },
  { test: /staticsites/, color: '#38bdf8', svg: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M3 9h18M7 7h.01"/>' },
  // Data
  { test: /documentdb|cosmos/, color: '#22d3ee', svg: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17M5 7c4 3 10 3 14 0M5 17c4-3 10-3 14 0"/>' },
  { test: /microsoft\.sql|\/servers\/databases|sqlserver|managedinstances/, color: '#4ade80', svg: '<ellipse cx="12" cy="6" rx="7" ry="2.6"/><path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6"/>' },
  { test: /dbforpostgresql|dbformysql|dbformariadb/, color: '#4ade80', svg: '<ellipse cx="12" cy="6" rx="7" ry="2.6"/><path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6"/>' },
  { test: /\/redis|redisenterprise/, color: '#f87171', svg: '<path d="M3 8l9-4 9 4-9 4z"/><path d="M3 12l9 4 9-4M3 16l9 4 9-4"/>' },
  { test: /storageaccounts|\/storage/, color: '#60a5fa', svg: '<rect x="3" y="6" width="18" height="4" rx="1"/><rect x="3" y="14" width="18" height="4" rx="1"/><path d="M7 8h.01M7 16h.01"/>' },
  { test: /datalake|datafactory|synapse/, color: '#818cf8', svg: '<path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z"/><path d="M4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7"/>' },
  // Security / identity
  { test: /vaults.*secret|keyvault|microsoft\.keyvault/, color: '#fbbf24', svg: '<rect x="5" y="10" width="14" height="10" rx="1.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15" r="1.3"/>' },
  { test: /recoveryservices|\/vaults\/backup|protecteditems|backupvault/, color: '#a3e635', svg: '<path d="M12 3l7 3v5c0 4.4-3 8-7 10-4-2-7-5.6-7-10V6z"/><path d="M9 12l2 2 4-4"/>' },
  { test: /managedidentity|\/identities/, color: '#f0abfc', svg: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6"/>' },
  // Networking
  { test: /virtualnetworks|\/vnet|subnets/, color: '#5eead4', svg: '<circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="6" r="2.2"/><circle cx="12" cy="18" r="2.2"/><path d="M7.6 7.6L11 16M16.4 7.6L13 16M8 6h8"/>' },
  { test: /networkinterfaces|\/nic/, color: '#5eead4', svg: '<rect x="3" y="8" width="18" height="8" rx="1"/><path d="M7 16v2M11 16v2M15 16v2"/>' },
  { test: /publicipaddresses|\/publicip/, color: '#67e8f9', svg: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5v17"/>' },
  { test: /loadbalancers|\/applicationgateways|trafficmanager|frontdoor/, color: '#22d3ee', svg: '<circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="12" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 7v4M12 11H5v6M12 11v6M12 11h7v6"/>' },
  { test: /bastionhosts|\/bastion/, color: '#7dd3fc', svg: '<path d="M4 9l8-5 8 5"/><path d="M6 9v9h12V9M10 18v-5h4v5"/>' },
  { test: /azurefirewall|\/firewall|\/networksecuritygroups|\/nsg/, color: '#fb923c', svg: '<path d="M4 4h16v6c0 5-3.5 8-8 10C7.5 18 4 15 4 10z"/><path d="M4 9h16"/>' },
  { test: /dnszones|\/privatedns|\/dnsresolver/, color: '#93c5fd', svg: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.3 2.6 14.7 0 17M12 3.5c-2.6 2.3-2.6 14.7 0 17"/>' },
  { test: /\/connections|\/vpngateways|\/expressroute|virtualnetworkgateways/, color: '#5eead4', svg: '<path d="M7 8a4 4 0 0 1 0 8M17 16a4 4 0 0 1 0-8"/><path d="M9 12h6"/>' },
  { test: /natgateways/, color: '#22d3ee', svg: '<rect x="3" y="9" width="18" height="6" rx="1"/><path d="M7 9V6M17 9V6M7 18v-3M17 18v-3"/>' },
  // AI / cognitive
  { test: /cognitiveservices|\/openai|\/accounts.*(ai|cognitive)/, color: '#c084fc', svg: '<path d="M9 3a4 4 0 0 0-4 4 3.5 3.5 0 0 0-1 6 3.5 3.5 0 0 0 5 4V3z"/><path d="M15 3a4 4 0 0 1 4 4 3.5 3.5 0 0 1 1 6 3.5 3.5 0 0 1-5 4V3z"/>' },
  { test: /\/searchservices|\/searchmanagement/, color: '#a78bfa', svg: '<circle cx="10" cy="10" r="6"/><path d="M14.5 14.5L20 20"/>' },
  { test: /machinelearningservices|\/workspaces.*ml/, color: '#c084fc', svg: '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="9" r="2"/><circle cx="9" cy="18" r="2"/><path d="M7.7 7.2L16.3 8M7.8 16.5L16.4 10"/>' },
  // Observability / messaging
  { test: /operationalinsights|loganalytics|\/workspaces/, color: '#a3e635', svg: '<path d="M4 19V5M4 19h16M8 16l3-4 3 3 4-6"/>' },
  { test: /insights\/components|applicationinsights|microsoft\.insights/, color: '#34d399', svg: '<path d="M4 14a8 8 0 1 1 16 0"/><path d="M12 14l4-3"/><circle cx="12" cy="14" r="1.3"/>' },
  { test: /servicebus|\/eventhub|\/eventgrid|\/notificationhubs|\/relay/, color: '#f472b6', svg: '<rect x="3" y="6" width="18" height="12" rx="1.5"/><path d="M3 7l9 6 9-6"/>' },
  { test: /\/workflows|logic/, color: '#60a5fa', svg: '<rect x="3" y="4" width="6" height="6" rx="1"/><rect x="15" y="14" width="6" height="6" rx="1"/><path d="M6 10v4h12"/>' },
  // Management / groups
  { test: /resourcegroups|\/managementgroups/, color: '#94a3b8', svg: '<rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="3 2.5"/>' },
];

const GENERIC = { svg: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 9h8M8 12h8M8 15h5"/>', color: '#8aa0b4' };

function lookup(type: string): { svg: string; color: string } {
  const t = (type || '').toLowerCase();
  for (const e of ICONS) if (e.test.test(t)) return { svg: e.svg, color: e.color };
  return GENERIC;
}

// Official Azure service icons (SVGs in public/azure-icons/). First match wins;
// anything unmapped falls back to the generic Azure "all resources" glyph.
const ICON_BASE = '/azure-icons/';
const FILE_ICONS: { test: RegExp; file: string }[] = [
  // Compute
  { test: /virtualmachinescalesets|\/scalesets/, file: 'vm-scale-set.svg' },
  { test: /hybridcompute\/machines/, file: 'arc-machine.svg' },
  { test: /virtualmachines\/extensions/, file: 'virtual-machine.svg' },
  { test: /microsoft\.compute\/virtualmachines|\/virtualmachines$/, file: 'virtual-machine.svg' },
  { test: /\/disks|\/snapshots/, file: 'disks.svg' },
  { test: /servicefabric/, file: 'service-fabric.svg' },
  { test: /batchaccounts/, file: 'batch-account.svg' },
  // Containers
  { test: /managedclusters|kubernetes|\/aks/, file: 'kubernetes-service.svg' },
  { test: /containerapps|\/managedenvironments/, file: 'container-instances.svg' },
  { test: /containerinstance|\/containergroups/, file: 'container-instances.svg' },
  { test: /\/registries/, file: 'container-registry.svg' },
  // Web / functions
  { test: /\/sites.*function|functionapp/, file: 'function-app.svg' },
  { test: /staticsites/, file: 'static-app.svg' },
  { test: /\/serverfarms/, file: 'app-service-plan.svg' },
  { test: /microsoft\.web\/sites|appservice/, file: 'app-service.svg' },
  { test: /apimanagement/, file: 'api-management.svg' },
  { test: /signalrservice|\/signalr/, file: 'signalr.svg' },
  // Databases / analytics
  { test: /documentdb|cosmos/, file: 'cosmos-db.svg' },
  { test: /managedinstances/, file: 'sql-managed-instance.svg' },
  { test: /microsoft\.sql|\/servers\/databases|sqlserver|sqlvirtualmachines/, file: 'sql-database.svg' },
  { test: /dbforpostgresql/, file: 'postgresql.svg' },
  { test: /dbformysql/, file: 'mysql.svg' },
  { test: /dbformariadb/, file: 'mariadb.svg' },
  { test: /\/redis|redisenterprise/, file: 'cache-redis.svg' },
  { test: /datafactory/, file: 'data-factory.svg' },
  { test: /synapse/, file: 'synapse.svg' },
  { test: /kusto|dataexplorer/, file: 'data-explorer.svg' },
  { test: /datalake/, file: 'data-lake.svg' },
  { test: /netapp/, file: 'netapp-files.svg' },
  { test: /storageaccounts|\/storage/, file: 'storage-account.svg' },
  // Security / identity
  { test: /vaults.*secret|keyvault|microsoft\.keyvault/, file: 'key-vault.svg' },
  { test: /recoveryservices|\/vaults\/backup|protecteditems|backupvault|dataprotection/, file: 'recovery-services-vault.svg' },
  { test: /microsoft\.security|\/defender|\/assessments/, file: 'defender.svg' },
  { test: /managedidentity|userassignedidentities|\/identities/, file: 'managed-identity.svg' },
  // Networking
  { test: /virtualnetworks|\/subnets/, file: 'virtual-network.svg' },
  { test: /networkinterfaces/, file: 'network-interface.svg' },
  { test: /publicipaddresses|\/publicip/, file: 'public-ip.svg' },
  { test: /applicationgateways/, file: 'application-gateway.svg' },
  { test: /frontdoor|microsoft\.cdn/, file: 'front-door.svg' },
  { test: /trafficmanager/, file: 'traffic-manager.svg' },
  { test: /loadbalancers/, file: 'load-balancer.svg' },
  { test: /bastionhosts|\/bastion/, file: 'bastion.svg' },
  { test: /azurefirewalls|\/firewall/, file: 'firewall.svg' },
  { test: /networksecuritygroups/, file: 'nsg.svg' },
  { test: /privateendpoints|privatelinkservices/, file: 'private-endpoint.svg' },
  { test: /dnszones|privatednszones|dnsresolvers/, file: 'dns-zone.svg' },
  { test: /expressroute/, file: 'expressroute.svg' },
  { test: /virtualnetworkgateways|vpngateways|localnetworkgateways/, file: 'vnet-gateway.svg' },
  { test: /\/connections/, file: 'connection.svg' },
  { test: /natgateways/, file: 'nat-gateway.svg' },
  { test: /routetables/, file: 'route-table.svg' },
  // AI
  { test: /\/openai/, file: 'openai.svg' },
  { test: /searchservices/, file: 'cognitive-search.svg' },
  { test: /machinelearningservices/, file: 'machine-learning.svg' },
  { test: /cognitiveservices/, file: 'cognitive-services.svg' },
  // Observability / integration / management
  { test: /operationalinsights|loganalytics/, file: 'log-analytics.svg' },
  { test: /insights\/components|applicationinsights|microsoft\.insights/, file: 'application-insights.svg' },
  { test: /servicebus/, file: 'service-bus.svg' },
  { test: /eventgrid/, file: 'event-grid.svg' },
  { test: /eventhub|\/notificationhubs|\/relay/, file: 'service-bus.svg' },
  { test: /\/workflows|microsoft\.logic/, file: 'logic-app.svg' },
  { test: /appconfiguration/, file: 'app-configuration.svg' },
  { test: /automationaccounts/, file: 'automation-account.svg' },
  { test: /\/managementgroups/, file: 'management-group.svg' },
  { test: /resourcegroups/, file: 'resource-group.svg' },
  { test: /\/subscriptions/, file: 'subscription.svg' },
];

function iconFile(type: string): string {
  const t = (type || '').toLowerCase();
  for (const e of FILE_ICONS) if (e.test.test(t)) return e.file;
  return 'generic.svg';
}

// Official Azure icon for a resource type, as an inline <img>. `cls` controls size
// ("rty-ico" default, or "rty-ico lg" for the detail dock). `tinted` is accepted for
// backwards-compatibility but ignored — the official icons carry their own colours.
export function typeIcon(type: string, opts: { tinted?: boolean; cls?: string } = {}): string {
  const cls = opts.cls || 'rty-ico';
  return `<span class="rty-wrap"><img class="${cls}" src="${ICON_BASE}${iconFile(type)}" alt="" loading="lazy" decoding="async" /></span>`;
}

export function typeColor(type: string): string {
  return lookup(type).color;
}

// Datacenter / availability-zone rack icon — returned as an SVG data URI for deck.gl IconLayer.
export function datacenterDataUri(color: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">` +
    `<g fill="none" stroke="${color}" stroke-width="2.4" stroke-linejoin="round">` +
    `<rect x="12" y="8" width="24" height="10" rx="1.5"/>` +
    `<rect x="12" y="20" width="24" height="10" rx="1.5"/>` +
    `<rect x="12" y="32" width="24" height="8" rx="1.5"/>` +
    `</g>` +
    `<g fill="${color}">` +
    `<circle cx="17" cy="13" r="1.6"/><circle cx="17" cy="25" r="1.6"/><circle cx="17" cy="36" r="1.5"/>` +
    `<rect x="22" y="11.5" width="10" height="2" rx="1" opacity="0.7"/>` +
    `<rect x="22" y="23.5" width="10" height="2" rx="1" opacity="0.7"/>` +
    `<rect x="22" y="35" width="8" height="2" rx="1" opacity="0.7"/>` +
    `</g></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// Health / severity dot glyphs (CSS-styled span).
export function healthIcon(state: string): string {
  const s = (state || '').toLowerCase();
  const cls = s === 'available' ? 'ok' : s === 'unavailable' ? 'bad' : s ? 'warn' : 'unknown';
  return `<span class="health-ico ${cls}"></span>`;
}
