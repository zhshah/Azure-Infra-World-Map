// Savable, fully-dynamic custom tabs (WorldMonitor-style "Main +" tabs).
// Each tab is a filtered resource view: pick filters (type / resource group / tag /
// text), choose which data columns to show (cost, security, health, power, ...),
// drag to reorder columns and tabs. Persisted per signed-in user to Azure SQL
// (via /api/tabs) with a localStorage fallback when SQL isn't configured.
import { api } from './api';
import { money, shortType } from './format';
import type { InventoryResource, ResourceFacetsResp, SavedTab } from './types';

const h = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const uid = () => `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

interface ColumnDef { id: string; label: string; num?: boolean }
const ALL_COLUMNS: ColumnDef[] = [
  { id: 'name', label: 'Name' },
  { id: 'type', label: 'Type' },
  { id: 'rg', label: 'Resource group' },
  { id: 'location', label: 'Location' },
  { id: 'zones', label: 'Zones' },
  { id: 'cost', label: 'Cost', num: true },
  { id: 'security', label: 'Security', num: true },
  { id: 'health', label: 'Health' },
  { id: 'power', label: 'Power' },
  { id: 'tags', label: 'Tags' },
];
const DEFAULT_COLUMNS = ['name', 'type', 'rg', 'cost', 'security'];

export interface CustomTabsDeps {
  barHost: HTMLElement;
  viewHost: HTMLElement;
  getResources: () => InventoryResource[];
  getFacets: () => ResourceFacetsResp | null;
  ensureFacets: (then: () => void) => void;
  openResource: (id: string) => void;
  showCustomView: () => void;
  backToDashboard: () => void;
}

function normalizeTab(t: any): SavedTab {
  return {
    id: String(t?.id || uid()),
    name: String(t?.name || 'Tab'),
    filter: t?.filter && typeof t.filter === 'object' ? t.filter : {},
    columns: Array.isArray(t?.columns) && t.columns.length ? t.columns.filter((c: string) => ALL_COLUMNS.some((x) => x.id === c)) : [...DEFAULT_COLUMNS],
    sort: t?.sort,
    position: typeof t?.position === 'number' ? t.position : undefined,
  };
}

export class CustomTabs {
  private tabs: SavedTab[] = [];
  private activeId: string | null = null;
  private persisted = false;
  private dragTabId: string | null = null;
  private dragCol: string | null = null;
  private textTimer: number | undefined;
  private refreshing = false;

  constructor(private deps: CustomTabsDeps) {}

  async init() { await this.load(); this.renderBar(); }
  hasActive() { return this.activeId != null; }
  clearActive() { if (this.activeId == null) return; this.activeId = null; this.renderBar(); }
  // Period/subscription changed: re-fetch facets (cost varies by range) and show a
  // loading state meanwhile — the cost API can take ~15s, and without feedback the grid
  // looks frozen on the old values.
  refresh() {
    if (!this.activeId) return;
    this.refreshing = true;
    this.renderView();
    this.deps.ensureFacets(() => { this.refreshing = false; this.renderGridOnly(); });
  }

  // ---- persistence (Azure SQL when configured; localStorage fallback) ----
  private readonly LS = 'finops-custom-tabs-v1';
  private loadLocal(): SavedTab[] { try { const a = JSON.parse(localStorage.getItem(this.LS) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }
  private saveLocal() { try { localStorage.setItem(this.LS, JSON.stringify(this.tabs)); } catch { /* quota / private mode */ } }
  private async load() {
    try {
      const r = await api.listTabs();
      this.persisted = !!r.persisted;
      if (r.persisted && Array.isArray(r.tabs) && r.tabs.length) { this.tabs = r.tabs.map(normalizeTab); this.saveLocal(); return; }
    } catch { /* server unreachable — fall back to local */ }
    this.tabs = this.loadLocal().map(normalizeTab);
  }
  private persistTab(tab: SavedTab) { this.saveLocal(); api.saveTab(tab).catch(() => { /* best-effort */ }); }
  private persistPositions() { this.tabs.forEach((t, i) => { t.position = i; }); this.saveLocal(); for (const t of this.tabs) api.saveTab(t).catch(() => {}); }

  // ---- tab strip ----
  private renderBar() {
    const host = this.deps.barHost;
    host.innerHTML =
      this.tabs.map((t) => `<button class="ctab ${t.id === this.activeId ? 'active' : ''}" data-id="${h(t.id)}" draggable="true" title="${h(t.name)} — double-click to rename, drag to reorder"><span class="ctab-name">${h(t.name)}</span><span class="ctab-x" data-x="${h(t.id)}" title="Delete tab">✕</span></button>`).join('') +
      `<button class="ctab-add" id="ctabAdd" title="New custom tab">+ Tab</button>`;
    host.querySelectorAll<HTMLElement>('.ctab').forEach((el) => {
      const id = el.dataset.id!;
      el.addEventListener('click', (e) => { if ((e.target as HTMLElement).dataset.x) return; this.select(id); });
      el.addEventListener('dblclick', () => this.rename(id));
      el.addEventListener('dragstart', () => { this.dragTabId = id; el.classList.add('dragging'); });
      el.addEventListener('dragend', () => { this.dragTabId = null; el.classList.remove('dragging'); });
      el.addEventListener('dragover', (e) => e.preventDefault());
      el.addEventListener('drop', (e) => { e.preventDefault(); this.reorderTabs(this.dragTabId, id); });
    });
    host.querySelectorAll<HTMLElement>('.ctab-x').forEach((x) => x.addEventListener('click', (e) => { e.stopPropagation(); this.del(x.dataset.x!); }));
    host.querySelector('#ctabAdd')?.addEventListener('click', () => this.add());
  }

  private add() {
    const tab: SavedTab = { id: uid(), name: `Tab ${this.tabs.length + 1}`, filter: {}, columns: [...DEFAULT_COLUMNS], position: this.tabs.length };
    this.tabs.push(tab);
    this.persistTab(tab);
    this.select(tab.id);
  }
  private rename(id: string) {
    const t = this.tabs.find((x) => x.id === id); if (!t) return;
    const name = window.prompt('Tab name', t.name);
    if (name && name.trim()) { t.name = name.trim().slice(0, 40); this.persistTab(t); this.renderBar(); if (this.activeId === id) this.renderView(); }
  }
  private del(id: string) {
    const idx = this.tabs.findIndex((x) => x.id === id); if (idx < 0) return;
    this.tabs.splice(idx, 1);
    this.saveLocal();
    api.deleteTab(id).catch(() => {});
    if (this.activeId === id) {
      this.activeId = null;
      if (this.tabs.length) this.select(this.tabs[Math.max(0, idx - 1)].id);
      else { this.deps.viewHost.innerHTML = ''; this.deps.backToDashboard(); this.renderBar(); }
    } else {
      this.renderBar();
    }
  }
  private reorderTabs(fromId: string | null, toId: string) {
    if (!fromId || fromId === toId) return;
    const from = this.tabs.findIndex((t) => t.id === fromId), to = this.tabs.findIndex((t) => t.id === toId);
    if (from < 0 || to < 0) return;
    const [m] = this.tabs.splice(from, 1); this.tabs.splice(to, 0, m);
    this.persistPositions(); this.renderBar();
  }
  private select(id: string) {
    this.activeId = id;
    this.renderBar();
    this.deps.showCustomView();
    this.renderView();
    this.deps.ensureFacets(() => { if (this.activeId === id) this.renderGridOnly(); });
  }

  private active(): SavedTab | undefined { return this.tabs.find((t) => t.id === this.activeId); }

  // ---- filtering / sorting ----
  private filtered(tab: SavedTab): InventoryResource[] {
    const f = tab.filter || {};
    const text = (f.text || '').toLowerCase();
    const types = (f.types || []).map((t) => t.toLowerCase());
    const rgs = (f.rgs || []).map((r) => r.toLowerCase());
    const tagKey = (f.tagKey || '').toLowerCase();
    const tagVal = (f.tagVal || '').toLowerCase();
    const out = this.deps.getResources().filter((r) => {
      if (text && !`${r.name} ${r.type}`.toLowerCase().includes(text)) return false;
      if (types.length && !types.some((t) => r.type.toLowerCase().startsWith(t))) return false;
      if (rgs.length && !rgs.includes((r.resourceGroup || '').toLowerCase())) return false;
      if (tagKey) {
        const tags = r.tags || {};
        const key = Object.keys(tags).find((k) => k.toLowerCase() === tagKey);
        if (!key) return false;
        if (tagVal && String(tags[key]).toLowerCase() !== tagVal) return false;
      }
      return true;
    });
    const s = tab.sort;
    if (s) {
      const facets = this.deps.getFacets();
      const dir = s.dir === 'desc' ? -1 : 1;
      out.sort((a, b) => {
        const va = this.cellValue(s.col, a, facets), vb = this.cellValue(s.col, b, facets);
        if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
        return String(va).localeCompare(String(vb)) * dir;
      });
    }
    return out;
  }
  private cellValue(col: string, r: InventoryResource, facets: ResourceFacetsResp | null): string | number {
    const id = r.id.toLowerCase();
    switch (col) {
      case 'name': return r.name || '';
      case 'type': return shortType(r.type);
      case 'rg': return r.resourceGroup || '';
      case 'location': return r.location || '';
      case 'zones': return r.zones?.length ? 1 : 0;
      case 'cost': return facets?.cost[id] || 0;
      case 'security': return facets?.sec[id] || 0;
      case 'health': return facets?.health[id] || '';
      case 'power': return facets?.power[id] || '';
      case 'tags': return Object.keys(r.tags || {}).length;
      default: return '';
    }
  }

  // ---- view ----
  private renderView() {
    const tab = this.active(); if (!tab) return;
    this.deps.viewHost.innerHTML =
      `<div class="cv">` +
        this.configBarHtml(tab) +
        `<div class="cv-meta" id="cvMeta"></div>` +
        `<div id="cvGridHost"></div>` +
      `</div>`;
    this.wireConfigBar(tab);
    this.renderGridOnly();
  }

  private renderGridOnly() {
    const tab = this.active(); if (!tab) return;
    const host = this.deps.viewHost;
    const facets = this.deps.getFacets();
    const rows = this.filtered(tab);
    const total = this.deps.getResources().length;
    const cols = tab.columns.length ? tab.columns : DEFAULT_COLUMNS;
    const meta = host.querySelector('#cvMeta');
    const updating = !facets || this.refreshing;
    if (meta) meta.innerHTML = `<b>${rows.length}</b> of ${total} resources match${updating ? ' · <span class="cv-load">updating cost / security / health…</span>' : ''} <span class="cv-store">${this.persisted ? 'saved to Azure SQL' : 'saved locally'}</span>`;
    const gridHost = host.querySelector('#cvGridHost');
    if (gridHost) { gridHost.innerHTML = this.gridHtml(tab, rows, cols, facets); this.wireGrid(tab, rows); }
  }

  private configBarHtml(tab: SavedTab): string {
    const resources = this.deps.getResources();
    const types = [...new Set(resources.map((r) => r.type))].sort();
    const rgs = [...new Set(resources.map((r) => r.resourceGroup).filter(Boolean) as string[])].sort();
    const f = tab.filter || {};
    const typeChips = (f.types || []).map((t) => `<span class="cv-chip" data-rm-type="${h(t)}">${h(shortType(t))}<i>✕</i></span>`).join('');
    const rgChips = (f.rgs || []).map((r) => `<span class="cv-chip" data-rm-rg="${h(r)}">${h(r)}<i>✕</i></span>`).join('');
    const activeCols = tab.columns.map((cid) => {
      const c = ALL_COLUMNS.find((x) => x.id === cid); if (!c) return '';
      return `<span class="cv-col" data-col="${cid}" draggable="true" title="drag to reorder">⋮⋮ ${h(c.label)}<i data-rmcol="${cid}" title="remove column">✕</i></span>`;
    }).join('');
    const hidden = ALL_COLUMNS.filter((c) => !tab.columns.includes(c.id));
    const addCol = hidden.length ? `<select class="cv-sel" id="cvColAdd"><option value="">+ column…</option>${hidden.map((c) => `<option value="${c.id}">${h(c.label)}</option>`).join('')}</select>` : '';
    return `<div class="cv-cfg">` +
      `<div class="cv-cfg-row">` +
        `<input class="cv-in" id="cvText" placeholder="search name or type…" value="${h(f.text || '')}"/>` +
        `<select class="cv-sel" id="cvTypeAdd"><option value="">+ type…</option>${types.map((t) => `<option value="${h(t)}">${h(shortType(t))}</option>`).join('')}</select>` +
        `<select class="cv-sel" id="cvRgAdd"><option value="">+ resource group…</option>${rgs.map((r) => `<option value="${h(r)}">${h(r)}</option>`).join('')}</select>` +
        `<input class="cv-in sm" id="cvTagKey" placeholder="tag key" value="${h(f.tagKey || '')}"/>` +
        `<input class="cv-in sm" id="cvTagVal" placeholder="tag value" value="${h(f.tagVal || '')}"/>` +
      `</div>` +
      ((f.types?.length || f.rgs?.length) ? `<div class="cv-chips">${typeChips}${rgChips}</div>` : '') +
      `<div class="cv-cols" id="cvCols"><span class="cv-cols-label">COLUMNS</span>${activeCols}${addCol}</div>` +
    `</div>`;
  }

  private gridHtml(tab: SavedTab, rows: InventoryResource[], cols: string[], facets: ResourceFacetsResp | null): string {
    const head = cols.map((c) => {
      const meta = ALL_COLUMNS.find((x) => x.id === c);
      const arrow = tab.sort?.col === c ? (tab.sort.dir === 'desc' ? ' ▾' : ' ▴') : '';
      return `<th class="cvh ${meta?.num ? 'num' : ''}" data-sort="${c}">${h(meta?.label || c)}${arrow}</th>`;
    }).join('');
    const body = rows.slice(0, 500).map((r) => `<tr class="cv-row" data-id="${h(r.id)}">${cols.map((c) => this.cellHtml(c, r, facets)).join('')}</tr>`).join('');
    return `<div class="cv-grid-wrap${this.refreshing ? ' cv-updating' : ''}"><table class="cv-grid"><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td class="cv-empty" colspan="${cols.length}">no resources match these filters</td></tr>`}</tbody></table></div>` +
      (rows.length > 500 ? `<div class="cv-more">showing first 500 of ${rows.length}</div>` : '');
  }

  private cellHtml(col: string, r: InventoryResource, facets: ResourceFacetsResp | null): string {
    const id = r.id.toLowerCase();
    const cur = facets?.currency || 'USD';
    switch (col) {
      case 'name': return `<td class="cv-name">${h(r.name)}</td>`;
      case 'type': return `<td class="cv-dim">${h(shortType(r.type))}</td>`;
      case 'rg': return `<td class="cv-dim">${h(r.resourceGroup || '—')}</td>`;
      case 'location': return `<td class="cv-dim">${h(r.location || '—')}</td>`;
      case 'zones': return `<td>${r.zones?.length ? `Zone ${h(r.zones.join(','))}` : '<span class="cv-dim">Regional</span>'}</td>`;
      case 'cost': { const v = facets?.cost[id]; return `<td class="num cv-cost">${v != null ? money(v, cur) : '—'}</td>`; }
      case 'security': { const n = facets?.sec[id]; return `<td class="num">${n ? `<span class="cv-bad">${n} unhealthy</span>` : (facets ? '<span class="cv-ok">OK</span>' : '—')}</td>`; }
      case 'health': { const s = facets?.health[id]; if (!s) return '<td class="cv-dim">—</td>'; const ok = s.toLowerCase() === 'available'; return `<td><span class="${ok ? 'cv-ok' : 'cv-bad'}">${h(s)}</span></td>`; }
      case 'power': { const p = facets?.power[id]; if (!p) return '<td class="cv-dim">—</td>'; const on = p === 'running'; return `<td><span class="cv-pwr ${on ? 'on' : 'off'}"><i></i>${h(p)}</span></td>`; }
      case 'tags': { const ks = Object.keys(r.tags || {}); return `<td>${ks.length ? ks.slice(0, 3).map((k) => `<span class="cv-tag">${h(k)}</span>`).join('') : '<span class="cv-dim">—</span>'}</td>`; }
      default: return '<td>—</td>';
    }
  }

  // ---- wiring ----
  private wireConfigBar(tab: SavedTab) {
    const host = this.deps.viewHost;
    const onText = () => { clearTimeout(this.textTimer); this.textTimer = window.setTimeout(() => { tab.filter.text = (host.querySelector<HTMLInputElement>('#cvText')!).value.trim(); this.persistTab(tab); this.renderGridOnly(); }, 180); };
    host.querySelector<HTMLInputElement>('#cvText')?.addEventListener('input', onText);
    const onTag = () => { clearTimeout(this.textTimer); this.textTimer = window.setTimeout(() => { tab.filter.tagKey = host.querySelector<HTMLInputElement>('#cvTagKey')!.value.trim(); tab.filter.tagVal = host.querySelector<HTMLInputElement>('#cvTagVal')!.value.trim(); this.persistTab(tab); this.renderGridOnly(); }, 180); };
    host.querySelector<HTMLInputElement>('#cvTagKey')?.addEventListener('input', onTag);
    host.querySelector<HTMLInputElement>('#cvTagVal')?.addEventListener('input', onTag);
    host.querySelector<HTMLSelectElement>('#cvTypeAdd')?.addEventListener('change', (e) => { const v = (e.target as HTMLSelectElement).value; if (!v) return; tab.filter.types = [...new Set([...(tab.filter.types || []), v])]; this.persistTab(tab); this.renderView(); });
    host.querySelector<HTMLSelectElement>('#cvRgAdd')?.addEventListener('change', (e) => { const v = (e.target as HTMLSelectElement).value; if (!v) return; tab.filter.rgs = [...new Set([...(tab.filter.rgs || []), v])]; this.persistTab(tab); this.renderView(); });
    host.querySelectorAll<HTMLElement>('[data-rm-type]').forEach((el) => el.addEventListener('click', () => { tab.filter.types = (tab.filter.types || []).filter((t) => t !== el.dataset.rmType); this.persistTab(tab); this.renderView(); }));
    host.querySelectorAll<HTMLElement>('[data-rm-rg]').forEach((el) => el.addEventListener('click', () => { tab.filter.rgs = (tab.filter.rgs || []).filter((t) => t !== el.dataset.rmRg); this.persistTab(tab); this.renderView(); }));
    host.querySelector<HTMLSelectElement>('#cvColAdd')?.addEventListener('change', (e) => { const v = (e.target as HTMLSelectElement).value; if (!v) return; tab.columns = [...tab.columns, v]; this.persistTab(tab); this.renderView(); });
    host.querySelectorAll<HTMLElement>('.cv-col [data-rmcol]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); tab.columns = tab.columns.filter((c) => c !== el.dataset.rmcol); if (!tab.columns.length) tab.columns = [...DEFAULT_COLUMNS]; this.persistTab(tab); this.renderView(); }));
    host.querySelectorAll<HTMLElement>('.cv-col').forEach((el) => {
      const cid = el.dataset.col!;
      el.addEventListener('dragstart', () => { this.dragCol = cid; el.classList.add('dragging'); });
      el.addEventListener('dragend', () => { this.dragCol = null; el.classList.remove('dragging'); });
      el.addEventListener('dragover', (e) => e.preventDefault());
      el.addEventListener('drop', (e) => { e.preventDefault(); this.moveCol(tab, this.dragCol, cid); });
    });
  }
  private moveCol(tab: SavedTab, fromCol: string | null, toCol: string) {
    if (!fromCol || fromCol === toCol) return;
    const from = tab.columns.indexOf(fromCol), to = tab.columns.indexOf(toCol);
    if (from < 0 || to < 0) return;
    const [m] = tab.columns.splice(from, 1); tab.columns.splice(to, 0, m);
    this.persistTab(tab); this.renderView();
  }
  private wireGrid(tab: SavedTab, _rows: InventoryResource[]) {
    const host = this.deps.viewHost;
    host.querySelectorAll<HTMLElement>('.cv-row').forEach((tr) => tr.addEventListener('click', () => this.deps.openResource(tr.dataset.id!)));
    host.querySelectorAll<HTMLElement>('.cvh').forEach((th) => th.addEventListener('click', () => {
      const col = th.dataset.sort!;
      if (tab.sort?.col === col) tab.sort = { col, dir: tab.sort.dir === 'asc' ? 'desc' : 'asc' };
      else tab.sort = { col, dir: col === 'cost' || col === 'security' ? 'desc' : 'asc' };
      this.persistTab(tab); this.renderView();
    }));
  }
}
