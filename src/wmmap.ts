// WorldMonitor-style deck.gl map for Azure FinOps.
// Dark teal-black basemap + graticule, with three view modes (standard / heatmap /
// danger) and toggleable layers — mirroring the WorldMonitor command-center look.
import { Deck, MapView, _GlobeView as GlobeView, FlyToInterpolator, LinearInterpolator, COORDINATE_SYSTEM, AmbientLight, LightingEffect } from '@deck.gl/core';
import { GeoJsonLayer, ScatterplotLayer, ArcLayer, TextLayer, PathLayer, IconLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
// @ts-ignore - luma geometry, typed loosely
import { SphereGeometry } from '@luma.gl/engine';
import { HeatmapLayer } from '@deck.gl/aggregation-layers';
// @ts-ignore - bundled topojson, typed loosely
import worldTopo from 'world-atlas/countries-110m.json';
// @ts-ignore - no bundled types
import { feature } from 'topojson-client';
import type { RegionAgg } from './types';
import { compactMoney } from './format';
import { datacenterDataUri } from './icons';
import { regionCc, flagUrl } from './regions-meta';

function rgbLightHex(c: [number, number, number]): string {
  const m = (v: number) => Math.round(v + (255 - v) * 0.5).toString(16).padStart(2, '0');
  return `#${m(c[0])}${m(c[1])}${m(c[2])}`;
}

// @ts-ignore
const countries = feature(worldTopo, (worldTopo as any).objects.countries);

// Photoreal globe: a real Earth sphere textured with the NASA Blue Marble image
// (blue oceans, green/brown continents). The mesh radius is a hair under the deck.gl
// globe radius so coastlines, bubbles and labels render on top without z-fighting.
const SINGLE = [0];
const EARTH_RADIUS_M = 6371000;
const EARTH_MESH = new SphereGeometry({ radius: EARTH_RADIUS_M * 0.999, nlat: 48, nlong: 96 });
const EARTH_TEXTURE = '/textures/earth-blue-marble.jpg';
// Even, full-intensity ambient so the whole planet is lit (no day/night terminator
// hiding cost data on the far side); the texture already has its own shading.
const EARTH_LIGHTING = new LightingEffect({ ambient: new AmbientLight({ color: [255, 255, 255], intensity: 1.0 }) });

export interface RegionArc { from: [number, number]; to: [number, number]; count: number; }
export type MapMode = 'standard' | 'heatmap' | 'danger';
export interface LayerState {
  bubbles: boolean; heatmap: boolean; danger: boolean;
  linkage: boolean; zones: boolean; labels: boolean; graticule: boolean; countries: boolean;
  waste: boolean; untagged: boolean; flags: boolean; health: boolean;
}

// Heat palette (cool -> hot), WorldMonitor-style.
const HEAT_RANGE: [number, number, number][] = [
  [12, 32, 28], [16, 90, 72], [60, 180, 120], [250, 210, 60], [255, 136, 0], [255, 68, 68],
];

function makeGraticule(): { path: [number, number][] }[] {
  const lines: { path: [number, number][] }[] = [];
  for (let lon = -180; lon <= 180; lon += 30) {
    const p: [number, number][] = [];
    for (let lat = -80; lat <= 80; lat += 4) p.push([lon, lat]);
    lines.push({ path: p });
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const p: [number, number][] = [];
    for (let lon = -180; lon <= 180; lon += 4) p.push([lon, lat]);
    lines.push({ path: p });
  }
  return lines;
}
const GRATICULE = makeGraticule();

// Great-circle path between two [lon,lat] points for globe linkage. Points are
// interpolated by spherical-linear interpolation and given a sinusoidal altitude so the
// connection arcs gently above the sphere. Returns [lon, lat, elevation(m)] vertices.
// (deck's ArcLayer is unreliable on a GlobeView, so we render these via PathLayer.)
function gcArc(a: [number, number], b: [number, number], n = 48, bulge = 700000): [number, number, number][] {
  const R = Math.PI / 180, D = 180 / Math.PI;
  const lo1 = a[0] * R, la1 = a[1] * R, lo2 = b[0] * R, la2 = b[1] * R;
  const v1 = [Math.cos(la1) * Math.cos(lo1), Math.cos(la1) * Math.sin(lo1), Math.sin(la1)];
  const v2 = [Math.cos(la2) * Math.cos(lo2), Math.cos(la2) * Math.sin(lo2), Math.sin(la2)];
  const dot = Math.max(-1, Math.min(1, v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]));
  const om = Math.acos(dot), sO = Math.sin(om);
  const out: [number, number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    let x: number, y: number, z: number;
    if (sO < 1e-6) { x = v1[0]; y = v1[1]; z = v1[2]; }
    else {
      const s1 = Math.sin((1 - t) * om) / sO, s2 = Math.sin(t * om) / sO;
      x = s1 * v1[0] + s2 * v2[0]; y = s1 * v1[1] + s2 * v2[1]; z = s1 * v1[2] + s2 * v2[2];
    }
    const lat = Math.atan2(z, Math.hypot(x, y)) * D;
    const lon = Math.atan2(y, x) * D;
    out.push([lon, lat, bulge * Math.sin(t * Math.PI)]);
  }
  return out;
}

// Country name labels — centroid of each country's largest ring (from bundled TopoJSON).
function ringArea(ring: number[][]): number {
  let a = 0;
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return Math.abs(a / 2);
}
function ringCentroid(ring: number[][]): [number, number] {
  let x = 0, y = 0; for (const p of ring) { x += p[0]; y += p[1]; } return [x / ring.length, y / ring.length];
}
interface CountryLabel { name: string; lon: number; lat: number; area: number; }
const COUNTRY_LABELS: CountryLabel[] = (() => {
  const out: CountryLabel[] = [];
  for (const f of ((countries as any).features || [])) {
    const name = f.properties?.name; const g = f.geometry; if (!name || !g) continue;
    let best: number[][] | null = null, bestA = 0;
    const consider = (ring: number[][]) => { const a = ringArea(ring); if (a > bestA) { bestA = a; best = ring; } };
    if (g.type === 'Polygon') consider(g.coordinates[0]);
    else if (g.type === 'MultiPolygon') for (const poly of g.coordinates) consider(poly[0]);
    if (!best) continue;
    const [lon, lat] = ringCentroid(best);
    out.push({ name, lon, lat, area: bestA });
  }
  return out;
})();

function escHtml(s: string): string { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string)); }

export class WMMap {
  private deck: Deck<any>;
  private regions: RegionAgg[] = [];
  private arcs: RegionArc[] = [];
  private mode: MapMode = 'standard';
  private projection: 'flat' | 'globe' = 'globe';
  private layers: LayerState = {
    bubbles: true, heatmap: false, danger: false,
    linkage: false, zones: false, labels: true, graticule: true, countries: true,
    waste: false, untagged: false, flags: true, health: true,
  };
  private wastePts: { lon: number; lat: number; count: number }[] = [];
  private untaggedPts: { lon: number; lat: number; count: number }[] = [];
  private regionHealth: Record<string, { status: string; count: number }> = {};
  private maxCost = 1;
  private totalCost = 1;
  private currency = 'USD';
  private zoom = 1.9;
  private viewState: any = { longitude: 10, latitude: 28, zoom: 1.9, minZoom: 0, maxZoom: 7, pitch: 0, bearing: 0 };
  private focused: RegionAgg | null = null;
  private zoneCounts: Record<string, number> | null = null;
  private regionClickCb: (r: RegionAgg) => void = () => {};
  private zoneClickCb: (zone: string) => void = () => {};
  private tooltipEl: HTMLDivElement;
  private labelOverlay!: HTMLDivElement;
  private ctryLayer!: HTMLDivElement;
  private chipLayer!: HTMLDivElement;
  private chipEls = new Map<string, HTMLDivElement>();
  private chipSig = '';
  private overlayRaf = 0;
  private overlayRetry = 0;

  constructor(container: HTMLElement) {
    this.tooltipEl = document.createElement('div');
    this.tooltipEl.className = 'wm-map-tooltip';
    this.tooltipEl.style.display = 'none';
    container.appendChild(this.tooltipEl);

    this.deck = new Deck({
      parent: container as HTMLDivElement,
      views: [new GlobeView({ resolution: 10 } as any)],
      viewState: this.viewState,
      controller: true,
      effects: [EARTH_LIGHTING],
      style: { position: 'absolute', inset: '0' },
      getTooltip: () => null,
      onViewStateChange: ({ viewState }: any) => {
        const old = this.zoomBucket();
        this.viewState = viewState;
        this.zoom = viewState.zoom ?? this.zoom;
        this.deck.setProps({ viewState });
        this.scheduleOverlay();
        if (old !== this.zoomBucket()) this.render();
      },
      layers: [],
    });
    this.labelOverlay = document.createElement('div');
    this.labelOverlay.className = 'wm-globe-labels';
    this.ctryLayer = document.createElement('div');
    this.ctryLayer.className = 'wm-gctry-layer';
    this.chipLayer = document.createElement('div');
    this.chipLayer.className = 'wm-gchip-layer';
    this.labelOverlay.appendChild(this.ctryLayer);
    this.labelOverlay.appendChild(this.chipLayer);
    container.appendChild(this.labelOverlay);
    this.render();
  }

  onRegionClick(cb: (r: RegionAgg) => void) { this.regionClickCb = cb; }
  onZoneClick(cb: (zone: string) => void) { this.zoneClickCb = cb; }
  isFocused(): boolean { return !!this.focused; }
  getFocused(): RegionAgg | null { return this.focused; }
  // Fly into a region and render its 3 availability-zone datacenters on the map.
  focusRegion(r: RegionAgg, counts: Record<string, number> | null = null) {
    if (r.lon == null || r.lat == null) return;
    this.focused = r;
    this.zoneCounts = counts;
    const g = this.projection === 'globe';
    this.viewState = { ...this.viewState, longitude: r.lon, latitude: r.lat, zoom: g ? 3.6 : 6.0, transitionDuration: 1200, transitionInterpolator: g ? new LinearInterpolator({ transitionProps: ['longitude', 'latitude', 'zoom'] }) : new FlyToInterpolator({ speed: 1.6 }) };
    this.render();
  }
  setZoneCounts(counts: Record<string, number> | null) { this.zoneCounts = counts; if (this.focused) this.render(); }
  clearFocus() {
    if (!this.focused) return;
    this.focused = null; this.zoneCounts = null;
    const g = this.projection === 'globe';
    this.viewState = { ...this.viewState, longitude: 10, latitude: g ? 28 : 30, zoom: g ? 1.9 : 1.4, transitionDuration: 1000, transitionInterpolator: g ? new LinearInterpolator({ transitionProps: ['longitude', 'latitude', 'zoom'] }) : new FlyToInterpolator({ speed: 1.4 }) };
    this.render();
  }

  setRegions(regions: RegionAgg[], currency: string) {
    this.regions = regions.filter((r) => r.lat != null && r.lon != null);
    this.currency = currency;
    this.maxCost = Math.max(1, ...this.regions.map((r) => r.cost));
    this.totalCost = Math.max(1, this.regions.reduce((s, r) => s + r.cost, 0));
    this.render();
  }

  setArcs(arcs: RegionArc[]) { this.arcs = arcs; this.render(); }
  setWaste(pts: { lon: number; lat: number; count: number }[]) { this.wastePts = pts; this.render(); }
  setUntagged(pts: { lon: number; lat: number; count: number }[]) { this.untaggedPts = pts; this.render(); }
  // Per-region Azure Service Health status: { '<regionCode>': { status, count } }.
  setRegionHealth(byRegion: Record<string, { status: string; count: number }>) { this.regionHealth = byRegion || {}; this.render(); }
  setMode(mode: MapMode) {
    this.mode = mode;
    // Mode implies a sensible default layer set, but explicit toggles still win afterwards.
    this.layers.heatmap = mode === 'heatmap';
    this.layers.danger = mode === 'danger';
    this.layers.bubbles = mode === 'standard';
    this.render();
  }
  getMode(): MapMode { return this.mode; }
  // Toggle between the flat (Web-Mercator) map and an interactive drag-rotate 3D globe.
  // Reuses every existing layer; only the deck.gl View + camera differ.
  setProjection(p: 'flat' | 'globe') {
    if (p === this.projection) return;
    this.projection = p;
    this.focused = null; this.zoneCounts = null;
    if (p === 'globe') {
      this.viewState = { longitude: this.viewState.longitude ?? 10, latitude: 28, zoom: 1.9, minZoom: 0, maxZoom: 7, pitch: 0, bearing: 0 };
      this.deck.setProps({ views: [new GlobeView({ resolution: 10 } as any)], viewState: this.viewState });
    } else {
      this.viewState = { longitude: 10, latitude: 30, zoom: 1.4, minZoom: 0.6, maxZoom: 9, pitch: 0, bearing: 0 };
      this.deck.setProps({ views: [new MapView({ repeat: false })], viewState: this.viewState });
    }
    this.zoom = this.viewState.zoom;
    this.render();
  }
  getProjection(): 'flat' | 'globe' { return this.projection; }
  setLayer(name: keyof LayerState, on: boolean) { this.layers[name] = on; this.render(); }
  getLayers(): LayerState { return { ...this.layers }; }

  private radius(r: RegionAgg): number {
    const base = r.cost > 0 ? r.cost / this.maxCost : 0;
    return 6 + Math.sqrt(base) * 34 + Math.min(10, Math.log2(1 + r.count));
  }
  // Per-region operational risk from REAL signals: active Azure service-health events,
  // idle/orphaned waste, and untagged resources in the region (NOT just how much it costs).
  private riskLevel(r: RegionAgg): { sev: string; color: [number, number, number]; t: number; reasons: string[] } {
    const hs = this.regionHealth[(r.region || '').toLowerCase()];
    const idle = this.wastePts.find((p) => p.lon === r.lon && p.lat === r.lat)?.count || 0;
    const untag = this.untaggedPts.find((p) => p.lon === r.lon && p.lat === r.lat)?.count || 0;
    let score = 0; const reasons: string[] = [];
    if (hs) {
      if (hs.status === 'issue') { score += 60; reasons.push(`${hs.count} service issue${hs.count > 1 ? 's' : ''}`); }
      else if (hs.status === 'maintenance') { score += 25; reasons.push('planned maintenance'); }
      else { score += 10; reasons.push('health advisory'); }
    }
    if (idle) { score += Math.min(55, idle * 11); reasons.push(`${idle} idle/orphaned`); }
    if (untag) { score += Math.min(22, Math.log2(1 + untag) * 7); reasons.push(`${untag} untagged`); }
    const sev = score >= 60 ? 'CRITICAL' : score >= 30 ? 'HIGH' : score >= 12 ? 'ELEVATED' : score > 0 ? 'LOW' : 'OK';
    const color: [number, number, number] = score >= 60 ? [255, 68, 68] : score >= 30 ? [255, 136, 0] : score >= 12 ? [255, 170, 0] : score > 0 ? [120, 190, 90] : [70, 150, 110];
    return { sev, color, t: Math.min(1, score / 80), reasons };
  }
  // Progressive reveal thresholds — like WorldMonitor: base map + dots first, then
  // region labels, then country flags, then per-region availability-zone markers.
  private static readonly Z_LABELS = 2.2;
  private static readonly Z_FLAGS = 3.2;
  private static readonly Z_ZONES = 4.2;
  // Re-render only when zoom crosses a threshold that changes which layers show.
  // True when (lon,lat) is on the camera-facing hemisphere within maxDeg of the view
  // centre. On the globe we only label the front hemisphere so labels stay upright and
  // legible instead of warping / mirroring around the limb and far side.
  private frontFacing(lon: number, lat: number, maxDeg = 62): boolean {
    if (this.projection !== 'globe') return true;
    const D = Math.PI / 180;
    const clon = (this.viewState.longitude ?? 0) * D, clat = (this.viewState.latitude ?? 0) * D;
    const plon = lon * D, plat = lat * D;
    const cosC = Math.sin(clat) * Math.sin(plat) + Math.cos(clat) * Math.cos(plat) * Math.cos(plon - clon);
    return cosC >= Math.cos(maxDeg * D);
  }
  private zoomBucket(): string {
    const z = this.zoom;
    const lbl = z >= WMMap.Z_LABELS ? 1 : 0;
    const flag = z >= WMMap.Z_FLAGS ? 1 : 0;
    const az = z >= WMMap.Z_ZONES ? 1 : 0;
    const ctry = z < 2 ? 'a' : z < 3.5 ? 'b' : 'c';
    const rot = this.projection === 'globe' ? `-${Math.round((this.viewState.longitude ?? 0) / 14)}-${Math.round((this.viewState.latitude ?? 0) / 14)}` : '';
    return `${lbl}${flag}${az}-${ctry}-${Math.min(9, Math.round(z))}${rot}`;
  }

  private scheduleOverlay() {
    if (this.overlayRaf) return;
    this.overlayRaf = requestAnimationFrame(() => { this.overlayRaf = 0; this.updateOverlay(); });
  }
  // HTML label overlay for the globe: crisp, upright flag chips + region names + country
  // names projected from the deck viewport and culled to the front hemisphere. (deck's own
  // SDF TextLayer warps/mirrors on a sphere, so on the globe we render these as DOM.)
  private updateOverlay() {
    if (!this.labelOverlay) return;
    if (this.projection !== 'globe') { this.ctryLayer.innerHTML = ''; for (const el of this.chipEls.values()) el.style.display = 'none'; return; }
    // getViewports() asserts if deck hasn't finished its first render yet (early load /
    // projection switch); swallow that and retry on the next frames until it's ready.
    let vp: any;
    try { const vps = (this.deck as any).getViewports?.(); vp = vps && vps[0]; } catch { if (this.overlayRetry++ < 60) setTimeout(() => this.scheduleOverlay(), 90); return; }
    if (!vp) { if (this.overlayRetry++ < 60) setTimeout(() => this.scheduleOverlay(), 90); return; }
    this.overlayRetry = 0;
    const L = this.layers;
    if (L.countries) {
      const minArea = this.zoom < 2.4 ? 7 : this.zoom < 3.4 ? 2.5 : 0.7;
      const cp: string[] = [];
      for (const c of COUNTRY_LABELS) {
        if (c.area < minArea || !this.frontFacing(c.lon, c.lat, 78)) continue;
        const p = vp.project([c.lon, c.lat]);
        if (!isFinite(p[0]) || !isFinite(p[1])) continue;
        cp.push(`<div class="gctry" style="transform:translate(calc(${p[0].toFixed(1)}px - 50%),calc(${p[1].toFixed(1)}px - 50%))">${escHtml(c.name)}</div>`);
      }
      this.ctryLayer.innerHTML = cp.join('');
    } else this.ctryLayer.innerHTML = '';
    const sig = `${L.flags ? 1 : 0}${L.labels ? 1 : 0}`;
    if (sig !== this.chipSig) { this.chipSig = sig; this.chipLayer.innerHTML = ''; this.chipEls.clear(); }
    const seen = new Set<string>();
    if (L.flags || L.labels) for (const r of this.regions) {
      if (r.lon == null || r.lat == null || !this.frontFacing(r.lon as number, r.lat as number, 86)) continue;
      const p = vp.project([r.lon as number, r.lat as number]);
      if (!isFinite(p[0]) || !isFinite(p[1])) continue;
      seen.add(r.region);
      let el = this.chipEls.get(r.region);
      if (!el) {
        el = document.createElement('div'); el.className = 'gchip';
        const cc = regionCc(r.region);
        const flag = (L.flags && cc) ? `<img class="gchip-flag" src="${flagUrl(cc, 40)}" alt="">` : '';
        const name = L.labels ? `<span class="gchip-name">${escHtml(r.display)}</span>` : '';
        el.innerHTML = flag + name;
        this.chipLayer.appendChild(el); this.chipEls.set(r.region, el);
      }
      const rad = this.radius(r);
      el.style.display = '';
      el.style.transform = `translate(calc(${p[0].toFixed(1)}px - 50%),calc(${(p[1] - rad - 6).toFixed(1)}px - 100%))`;
    }
    for (const [k, el] of this.chipEls) if (!seen.has(k)) el.style.display = 'none';
  }

  private render() {
    const L = this.layers;
    const layers: any[] = [];
    const globe = this.projection === 'globe';
    if (globe) {
      // Photoreal Earth — a real textured sphere (NASA Blue Marble: blue oceans, green/
      // brown land), replacing the old flat fake-ocean polygon that looked like a puck.
      layers.push(new SimpleMeshLayer({
        id: 'globe-earth',
        data: SINGLE,
        mesh: EARTH_MESH,
        coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
        getPosition: () => [0, 0, 0],
        getColor: [255, 255, 255],
        getOrientation: [0, 120, 90],
        texture: EARTH_TEXTURE,
        material: { ambient: 1, diffuse: 0, shininess: 1, specularColor: [0, 0, 0] },
        pickable: false,
      } as any));
    }

    // Basemap. Flat map = deep teal land + glowing coastline (command-center look).
    // Globe = the Blue Marble texture already shows the land, so we add only a faint
    // coastline plus a fully-transparent (but still pickable) fill for country hover.
    if (!globe) {
      layers.push(new GeoJsonLayer({
        id: 'countries-glow',
        data: countries as any,
        stroked: true,
        filled: false,
        getLineColor: [46, 188, 142, 72],
        lineWidthMinPixels: 3,
        lineWidthMaxPixels: 7,
        pickable: false,
      }));
    }
    layers.push(new GeoJsonLayer({
      id: 'countries',
      data: countries as any,
      stroked: true,
      filled: true,
      getFillColor: globe ? [0, 0, 0, 0] : [13, 38, 31, 255],
      getLineColor: globe ? [150, 205, 230, 75] : [54, 182, 140, 230],
      lineWidthMinPixels: globe ? 0.4 : 0.8,
      lineWidthMaxPixels: globe ? 1 : 2,
      pickable: true,
      autoHighlight: true,
      highlightColor: [120, 220, 255, 90],
      onHover: (info: any) => this.countryHover(info),
    }));

    if (L.graticule) {
      layers.push(new PathLayer({
        id: 'graticule',
        data: GRATICULE,
        getPath: (d: any) => d.path,
        getColor: globe ? [150, 195, 220, 38] : [10, 42, 32, 170],
        getWidth: 1,
        widthUnits: 'pixels',
        widthMinPixels: 0.5,
        pickable: false,
      }));
    }

    // Country names — deck text on the flat map; on the globe the HTML overlay renders
    // crisp upright country labels instead (deck SDF text warps on the sphere).
    if (L.countries && !globe) {
      const minArea = globe ? (this.zoom < 1.5 ? 2 : 0.4) : (this.zoom < 2 ? 6 : this.zoom < 3.5 ? 1.5 : 0);
      // Country labels grow as you zoom in, so a small country (e.g. Qatar) stays
      // readable when its fill expands to fill the viewport.
      const cScale = this.zoom <= 2.2 ? 1 : Math.min(3.4, 1 + (this.zoom - 2.2) * 0.42);
      const _cl = COUNTRY_LABELS.filter((c) => c.area >= minArea && (!globe || this.frontFacing(c.lon, c.lat, 58)));
      layers.push(new TextLayer({
        id: 'country-labels',
        data: _cl,
        getPosition: (d: any) => [d.lon, d.lat, globe ? 60000 : 0],
        getText: (d: any) => d.name,
        getSize: (d: any) => Math.round((d.area > 80 ? 15 : d.area > 24 ? 13 : 12) * cScale),
        sizeMaxPixels: 48,
        getColor: [232, 245, 239, 255],
        getTextAnchor: 'middle',
        billboard: !globe,
        fontFamily: '"Segoe UI", "SF Pro Text", system-ui, sans-serif',
        fontWeight: 600,
        fontSettings: { sdf: true },
        outlineWidth: 3,
        outlineColor: [4, 12, 10, 235],
        characterSet: 'auto',
        pickable: false,
        parameters: globe ? ({ depthCompare: 'always' } as any) : undefined,
        updateTriggers: { getSize: this.zoom, getPosition: globe },
      }));
    }

    if (L.heatmap && !globe && this.regions.length) {
      layers.push(new HeatmapLayer({
        id: 'cost-heat',
        data: this.regions,
        getPosition: (r: RegionAgg) => [r.lon as number, r.lat as number],
        getWeight: (r: RegionAgg) => r.cost,
        radiusPixels: 70,
        intensity: 1.4,
        threshold: 0.03,
        colorRange: HEAT_RANGE as any,
        updateTriggers: { getWeight: this.maxCost },
      }));
    }

    if (L.linkage && this.arcs.length) {
      if (globe) {
        // deck's ArcLayer great-circle arcs collapse/occlude unpredictably on a GlobeView
        // (low arcs wrap behind the sphere and get culled; tall ones fly off-screen), so on
        // the globe we draw each connection as an explicit great-circle PathLayer that
        // bulges above the surface and ignores depth — reliable and always visible.
        layers.push(new PathLayer({
          id: 'region-arcs-globe',
          data: this.arcs,
          getPath: (d: RegionArc) => gcArc(d.from, d.to),
          getColor: [86, 224, 255, 215],
          getWidth: (d: RegionArc) => Math.min(8, 1 + Math.log2(1 + d.count)),
          widthUnits: 'pixels', widthMinPixels: 1.5, widthMaxPixels: 8,
          capRounded: true, jointRounded: true,
          parameters: { depthTest: false },
          updateTriggers: { getPath: this.arcs },
        }));
      } else {
        layers.push(new ArcLayer({
          id: 'region-arcs',
          data: this.arcs,
          getSourcePosition: (d: RegionArc) => d.from,
          getTargetPosition: (d: RegionArc) => d.to,
          getSourceColor: [68, 255, 136, 110],
          getTargetColor: [60, 200, 255, 150],
          getWidth: (d: RegionArc) => Math.min(8, 1 + Math.log2(1 + d.count)),
          greatCircle: true,
        }));
      }
    }

    // Danger mode — red risk halos + pulsing rings + severity labels.
    if (L.danger && this.regions.length) {
      layers.push(new ScatterplotLayer({
        id: 'danger-glow',
        data: this.regions,
        getPosition: (r: RegionAgg) => [r.lon as number, r.lat as number],
        getRadius: (r: RegionAgg) => this.radius(r) * 2.4,
        radiusUnits: 'pixels', radiusMinPixels: 10, radiusMaxPixels: 140,
        filled: true, stroked: false,
        getFillColor: (r: RegionAgg) => { const rl = this.riskLevel(r); return [...rl.color, rl.reasons.length ? 60 : 22] as any; },
        pickable: false,
        updateTriggers: { getRadius: this.maxCost, getFillColor: [this.regionHealth, this.wastePts, this.untaggedPts] },
      }));
      layers.push(new ScatterplotLayer({
        id: 'danger-ring',
        data: this.regions,
        getPosition: (r: RegionAgg) => [r.lon as number, r.lat as number],
        getRadius: (r: RegionAgg) => this.radius(r) * 1.5,
        radiusUnits: 'pixels', radiusMinPixels: 8, radiusMaxPixels: 90,
        filled: false, stroked: true, lineWidthMinPixels: 1.4,
        getLineColor: (r: RegionAgg) => { const { color } = this.riskLevel(r); return [...color, 230] as any; },
        pickable: true,
        onClick: (info: any) => { if (info.object) this.regionClickCb(info.object); },
        onHover: (info: any) => this.hover(info),
        updateTriggers: { getRadius: this.maxCost, getLineColor: [this.regionHealth, this.wastePts, this.untaggedPts] },
      }));
      layers.push(new TextLayer({
        id: 'danger-labels',
        data: this.regions.filter((r) => this.riskLevel(r).reasons.length),
        getPosition: (r: RegionAgg) => [r.lon as number, r.lat as number, globe ? 60000 : 0],
        getText: (r: RegionAgg) => { const rl = this.riskLevel(r); return `${rl.sev} · ${rl.reasons[0]}`; },
        getSize: 10,
        getColor: (r: RegionAgg) => { const { color } = this.riskLevel(r); return [...color, 255] as any; },
        getPixelOffset: [0, -16],
        getTextAnchor: 'middle',
        billboard: !globe,
        fontFamily: '"SF Mono", "Cascadia Code", monospace',
        fontWeight: 700,
        characterSet: 'auto',
        pickable: false,
        background: true,
        getBackgroundColor: [5, 12, 10, 200],
        backgroundPadding: [4, 2],
        parameters: globe ? ({ depthCompare: 'always' } as any) : undefined,
        updateTriggers: { getText: [this.regionHealth, this.wastePts, this.untaggedPts], getColor: [this.regionHealth, this.wastePts, this.untaggedPts], getPosition: globe },
      }));
    }

    // Standard mode — cost-weighted bubbles with glow.
    if ((L.bubbles || (globe && L.heatmap)) && this.regions.length) {
      layers.push(new ScatterplotLayer({
        id: 'region-glow',
        data: this.regions,
        getPosition: (r: RegionAgg) => [r.lon as number, r.lat as number],
        getRadius: (r: RegionAgg) => this.radius(r) * 1.9,
        radiusUnits: 'pixels', radiusMinPixels: 8, radiusMaxPixels: 110,
        filled: true, stroked: false,
        getFillColor: [68, 255, 136, 38],
        pickable: false,
        updateTriggers: { getRadius: this.maxCost },
      }));
      layers.push(new ScatterplotLayer({
        id: 'regions',
        data: this.regions,
        getPosition: (r: RegionAgg) => [r.lon as number, r.lat as number],
        getRadius: (r: RegionAgg) => this.radius(r),
        radiusUnits: 'pixels', radiusMinPixels: 4, radiusMaxPixels: 60,
        stroked: true, getLineColor: [68, 255, 136, 230], lineWidthMinPixels: 1.2,
        getFillColor: [68, 255, 136, 70],
        pickable: true,
        onClick: (info: any) => { if (info.object) this.regionClickCb(info.object); },
        onHover: (info: any) => this.hover(info),
        updateTriggers: { getRadius: this.maxCost },
      }));
    }

    // Service-health status rings — highlight regions with an active Azure service event.
    if (L.health && this.regions.length) {
      const HC: Record<string, [number, number, number]> = { issue: [255, 68, 68], maintenance: [255, 170, 0], advisory: [60, 200, 255] };
      const hr = this.regions
        .map((r) => { const st = this.regionHealth[(r.region || '').toLowerCase()]; return st ? { r, st } : null; })
        .filter(Boolean) as { r: RegionAgg; st: { status: string; count: number } }[];
      if (hr.length) layers.push(new ScatterplotLayer({
        id: 'region-health',
        data: hr,
        getPosition: (d: any) => [d.r.lon, d.r.lat],
        getRadius: (d: any) => this.radius(d.r) * 1.5 + 7,
        radiusUnits: 'pixels', radiusMinPixels: 11, radiusMaxPixels: 80,
        filled: false, stroked: true, lineWidthMinPixels: 2.6,
        getLineColor: (d: any) => { const c = HC[d.st.status] || HC.advisory; return [...c, 240] as any; },
        pickable: true,
        onClick: (info: any) => { if (info.object) this.regionClickCb(info.object.r); },
        onHover: (info: any) => this.healthHover(info),
        updateTriggers: { getLineColor: this.regionHealth, getRadius: this.maxCost },
      }));
    }

    // Waste overlay (red rings sized by orphaned/idle resource count per region).
    if (L.waste && this.wastePts.length) {
      layers.push(new ScatterplotLayer({
        id: 'waste-overlay', data: this.wastePts,
        getPosition: (d: any) => [d.lon, d.lat],
        getRadius: (d: any) => 9 + Math.min(22, d.count * 2.2),
        radiusUnits: 'pixels', radiusMinPixels: 7, radiusMaxPixels: 40,
        filled: false, stroked: true, lineWidthMinPixels: 2,
        getLineColor: [255, 68, 68, 235], pickable: false,
      }));
    }

    // Untagged overlay (amber halos sized by untagged resource count per region).
    if (L.untagged && this.untaggedPts.length) {
      layers.push(new ScatterplotLayer({
        id: 'untagged-overlay', data: this.untaggedPts,
        getPosition: (d: any) => [d.lon, d.lat],
        getRadius: (d: any) => 7 + Math.min(20, Math.log2(1 + d.count) * 4.5),
        radiusUnits: 'pixels', radiusMinPixels: 6, radiusMaxPixels: 34,
        filled: true, stroked: false, getFillColor: [255, 170, 0, 55], pickable: false,
      }));
    }

    // Country flags floating above each region bubble (revealed once zoomed in).
    if (L.flags && !globe && L.bubbles && this.regions.length && this.zoom >= WMMap.Z_FLAGS) {
      const flagged = this.regions.filter((r: any) => regionCc(r.region) && (!globe || (r.lon != null && r.lat != null && this.frontFacing(r.lon, r.lat, 72))));
      if (flagged.length) layers.push(new IconLayer({
        id: 'region-flags', data: flagged,
        getPosition: (r: any) => [r.lon, r.lat, globe ? 80000 : 0],
        getIcon: (r: any) => { const cc = regionCc(r.region)!; return { id: cc, url: flagUrl(cc, 40), width: 40, height: 30, anchorX: 20, anchorY: 30, mask: false }; },
        getSize: globe ? 22 : 17, sizeUnits: 'pixels', getPixelOffset: [0, -15], pickable: false,
        billboard: !globe,
        parameters: globe ? ({ depthCompare: 'always' } as any) : undefined,
        updateTriggers: { getPosition: globe, getSize: globe },
      }));
    }

    // Region labels — prominent regions are labeled even at world view; all show once
    // zoomed past the threshold. An SDF halo keeps them legible over land and bubbles.
    if (L.labels && !globe && this.regions.length) {
      let labelRegions = (globe || this.zoom >= WMMap.Z_LABELS) ? this.regions : this.regions.filter((r) => this.radius(r) >= 15);
      if (globe) labelRegions = labelRegions.filter((r) => r.lon != null && r.lat != null && this.frontFacing(r.lon as number, r.lat as number, 72));
      const rScale = this.zoom <= 2.2 ? 1 : Math.min(2.2, 1 + (this.zoom - 2.2) * 0.26);
      layers.push(new TextLayer({
        id: 'region-labels',
        data: labelRegions,
        getPosition: (r: RegionAgg) => [r.lon as number, r.lat as number, globe ? 60000 : 0],
        getText: (r: RegionAgg) => r.display.toUpperCase(),
        getSize: Math.round((globe ? 13 : 11) * rScale),
        getColor: [206, 242, 224, 245],
        getPixelOffset: [0, 16],
        getTextAnchor: 'middle',
        billboard: true,
        fontFamily: '"SF Mono", "Cascadia Code", monospace',
        fontWeight: 600,
        fontSettings: { sdf: true },
        outlineWidth: 3.5,
        outlineColor: [2, 12, 9, 235],
        characterSet: 'auto',
        pickable: false,        parameters: globe ? ({ depthCompare: 'always' } as any) : undefined,        updateTriggers: { getSize: this.zoom, getPosition: globe },
      }));
    }

    // 3 availability-zone markers per region when zoomed in (after flags). Hidden while a
    // region is focused — the drill-in datacenter nodes below take over there.
    if (L.zones && !this.focused && this.zoom >= (globe ? 3.0 : WMMap.Z_ZONES) && this.regions.length) {
      const offs: [number, number][] = [[-11, -7], [11, -7], [0, 12]];
      const zoneData: { lon: number; lat: number; off: [number, number] }[] = [];
      for (const r of this.regions) {
        if (r.lon == null || r.lat == null) continue;
        for (const off of offs) zoneData.push({ lon: r.lon as number, lat: r.lat as number, off });
      }
      layers.push(new TextLayer({
        id: 'zone-az',
        data: zoneData,
        getPosition: (d: any) => [d.lon, d.lat, globe ? 60000 : 0],
        getText: () => '\u25ad',
        getSize: 12,
        getColor: [120, 220, 255, 230],
        getPixelOffset: (d: any) => d.off,
        getTextAnchor: 'middle',
        billboard: !globe,
        fontFamily: '"SF Mono", "Cascadia Code", monospace',
        pickable: false,
        parameters: globe ? ({ depthCompare: 'always' } as any) : undefined,
        updateTriggers: { getPosition: globe },
      }));
    }

    // Availability-zone detail is rendered in the side panel (clean hub-spoke topology +
    // clickable zone cards), so the map stays uncluttered when a region is focused.

    this.deck.setProps({ viewState: this.viewState, layers });
    this.scheduleOverlay();
  }

  private showTip(kind: string, html: string, x: number, y: number) {
    this.tooltipEl.dataset.kind = kind;
    this.tooltipEl.innerHTML = html;
    this.tooltipEl.style.display = 'block';
    this.tooltipEl.style.left = `${x + 14}px`;
    this.tooltipEl.style.top = `${y + 14}px`;
  }
  // Only the handler that currently owns the tooltip may hide it, so the country
  // hover (fired over empty land) can't clobber a richer region/zone/health tooltip.
  private hideTip(kind: string) {
    if (this.tooltipEl.dataset.kind && this.tooltipEl.dataset.kind !== kind) return;
    this.tooltipEl.style.display = 'none';
  }
  private countryHover(info: any) {
    const f = info.object;
    if (!f || !f.properties?.name) { this.hideTip('country'); return; }
    this.showTip('country', `<b>${f.properties.name}</b><br/><span class="t-hint">Azure cost shown as region bubbles \u2192 hover one</span>`, info.x, info.y);
  }

  private zoneHover(info: any) {
    const d = info.object;
    if (!d) { this.hideTip('zone'); return; }
    const n = this.zoneCounts ? (this.zoneCounts[d.zone] ?? 0) : '\u2026';
    this.showTip('zone', `<b>${d.label}</b><br/>${n} resources<br/><span class="t-hint">click \u2192 drill into this zone</span>`, info.x, info.y);
  }

  private hover(info: any) {
    const r: RegionAgg | undefined = info.object;
    if (!r) { this.hideTip('region'); return; }
    const share = ((r.cost / this.totalCost) * 100).toFixed(1);
    const top = Object.entries(r.types).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([t, n]) => `${t} (${n})`).join(', ');
    const rl = this.riskLevel(r);
    const idle = this.wastePts.find((p) => p.lon === r.lon && p.lat === r.lat)?.count || 0;
    const untag = this.untaggedPts.find((p) => p.lon === r.lon && p.lat === r.lat)?.count || 0;
    const hyg: string[] = [];
    if (idle) hyg.push(`${idle} idle/orphaned`);
    if (untag) hyg.push(`${untag} untagged`);
    const hygLine = hyg.length ? `<br/><span class="t-warn">\u26a0 ${hyg.join(' \u00b7 ')}</span>` : '';
    const hs = this.regionHealth[(r.region || '').toLowerCase()];
    const healthLine = hs
      ? `<br/><span class="t-sev">${hs.status === 'issue' ? '\u26d4 SERVICE ISSUE' : hs.status === 'maintenance' ? '\u2699 MAINTENANCE' : '\u24d8 ADVISORY'}</span> ${hs.count} event(s)`
      : `<br/><span class="t-ok">\u2714 Service health OK</span>`;
    this.showTip('region',
      `<b>${r.display}</b><span class="${rl.reasons.length ? 't-sev' : 't-ok'}">${rl.sev}</span><br/>${r.geo || r.region}<br/>` +
      `COST <b>${compactMoney(r.cost, this.currency)}</b> \u00b7 ${share}% \u00b7 ${r.count} res${healthLine}${hygLine}<br/>` +
      `<span class="t-dim">${top}</span><br/><span class="t-hint">click \u2192 availability zones</span>`,
      info.x, info.y);
  }

  private healthHover(info: any) {
    const d = info.object;
    if (!d) { this.hideTip('health'); return; }
    const lbl = d.st.status === 'issue' ? 'SERVICE ISSUE' : d.st.status === 'maintenance' ? 'PLANNED MAINTENANCE' : 'HEALTH ADVISORY';
    this.showTip('health', `<b>${d.r.display}</b><span class="t-sev">${lbl}</span><br/>${d.st.count} active Azure service-health event(s)<br/><span class="t-hint">click \u2192 region detail</span>`, info.x, info.y);
  }
}
