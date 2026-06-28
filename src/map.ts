import { Deck, MapView } from '@deck.gl/core';
import { GeoJsonLayer, ScatterplotLayer, ArcLayer, TextLayer } from '@deck.gl/layers';
// @ts-ignore - bundled topojson, typed loosely
import worldTopo from 'world-atlas/countries-110m.json';
// @ts-ignore - no bundled types
import { feature } from 'topojson-client';
import type { RegionAgg } from './types';
import { costColor, compactMoney } from './format';

// @ts-ignore
const countries = feature(worldTopo, (worldTopo as any).objects.countries);

export interface RegionArc { from: [number, number]; to: [number, number]; count: number; }

export class FinOpsMap {
  private deck: Deck<any>;
  private regions: RegionAgg[] = [];
  private arcs: RegionArc[] = [];
  private showLinkage = false;
  private maxCost = 1;
  private currency = 'USD';
  private zoom = 1.3;
  private regionClickCb: (r: RegionAgg) => void = () => {};
  private tooltipEl: HTMLDivElement;

  constructor(container: HTMLElement) {
    this.tooltipEl = document.createElement('div');
    this.tooltipEl.className = 'map-tooltip';
    this.tooltipEl.style.display = 'none';
    container.appendChild(this.tooltipEl);

    this.deck = new Deck({
      parent: container as HTMLDivElement,
      views: [new MapView({ repeat: true })],
      initialViewState: { longitude: 5, latitude: 25, zoom: 1.3, minZoom: 0.5, maxZoom: 8, pitch: 0, bearing: 0 } as any,
      controller: true,
      style: { position: 'absolute', inset: '0' },
      getTooltip: () => null,
      onViewStateChange: ({ viewState }: any) => {
        const was = this.zoom >= 3;
        this.zoom = viewState.zoom ?? this.zoom;
        if (was !== (this.zoom >= 3)) this.render();
      },
      layers: [],
    });
    this.render();
  }

  onRegionClick(cb: (r: RegionAgg) => void) { this.regionClickCb = cb; }

  setRegions(regions: RegionAgg[], currency: string) {
    this.regions = regions.filter((r) => r.lat != null && r.lon != null);
    this.currency = currency;
    this.maxCost = Math.max(1, ...this.regions.map((r) => r.cost));
    this.render();
  }

  setArcs(arcs: RegionArc[]) { this.arcs = arcs; this.render(); }
  setShowLinkage(v: boolean) { this.showLinkage = v; this.render(); }

  private radius(r: RegionAgg): number {
    const base = r.cost > 0 ? r.cost / this.maxCost : 0;
    return 6 + Math.sqrt(base) * 34 + Math.min(10, Math.log2(1 + r.count));
  }

  private render() {
    const layers: any[] = [
      new GeoJsonLayer({
        id: 'countries',
        data: countries as any,
        stroked: true,
        filled: true,
        getFillColor: [22, 32, 50, 255],
        getLineColor: [54, 72, 100, 180],
        lineWidthMinPixels: 0.5,
        pickable: false,
      }),
    ];

    if (this.showLinkage && this.arcs.length) {
      layers.push(new ArcLayer({
        id: 'region-arcs',
        data: this.arcs,
        getSourcePosition: (d: RegionArc) => d.from,
        getTargetPosition: (d: RegionArc) => d.to,
        getSourceColor: [80, 170, 255, 120],
        getTargetColor: [240, 130, 60, 140],
        getWidth: (d: RegionArc) => Math.min(8, 1 + Math.log2(1 + d.count)),
        greatCircle: true,
      }));
    }

    layers.push(new ScatterplotLayer({
      id: 'region-glow',
      data: this.regions,
      getPosition: (r: RegionAgg) => [r.lon as number, r.lat as number],
      getRadius: (r: RegionAgg) => this.radius(r) * 1.9,
      radiusUnits: 'pixels',
      radiusMinPixels: 8,
      radiusMaxPixels: 110,
      filled: true,
      stroked: false,
      getFillColor: (r: RegionAgg) => {
        const [cr, cg, cb] = costColor(r.cost / this.maxCost);
        return [cr, cg, cb, 45];
      },
      pickable: false,
      updateTriggers: { getRadius: this.maxCost, getFillColor: this.maxCost },
    }));

    layers.push(new ScatterplotLayer({
      id: 'regions',
      data: this.regions,
      getPosition: (r: RegionAgg) => [r.lon as number, r.lat as number],
      getRadius: (r: RegionAgg) => this.radius(r),
      radiusUnits: 'pixels',
      radiusMinPixels: 5,
      radiusMaxPixels: 60,
      stroked: true,
      getLineColor: [255, 255, 255, 220],
      lineWidthMinPixels: 1.2,
      getFillColor: (r: RegionAgg) => {
        const [cr, cg, cb] = costColor(r.cost / this.maxCost);
        return [cr, cg, cb, 215];
      },
      pickable: true,
      onClick: (info: any) => { if (info.object) this.regionClickCb(info.object); },
      onHover: (info: any) => this.hover(info),
      updateTriggers: { getRadius: this.maxCost, getFillColor: this.maxCost },
    }));

    layers.push(new TextLayer({
      id: 'region-labels',
      data: this.regions,
      getPosition: (r: RegionAgg) => [r.lon as number, r.lat as number],
      getText: (r: RegionAgg) => r.display,
      getSize: 10,
      getColor: [210, 224, 245, 220],
      getPixelOffset: [0, -14],
      getTextAnchor: 'middle',
      fontFamily: '"Segoe UI", sans-serif',
      pickable: false,
    }));

    // 3 availability-zone markers around each region (revealed when zoomed in).
    if (this.zoom >= 3) {
      const offs: [number, number][] = [[-11, 7], [11, 7], [0, -13]];
      const zoneData: { lon: number; lat: number; off: [number, number] }[] = [];
      for (const r of this.regions) {
        if (r.lon == null || r.lat == null) continue;
        for (const off of offs) zoneData.push({ lon: r.lon as number, lat: r.lat as number, off });
      }
      layers.push(new TextLayer({
        id: 'zone-az',
        data: zoneData,
        getPosition: (d: any) => [d.lon, d.lat],
        getText: () => '\u25ad',
        getSize: 12,
        getColor: [120, 200, 255, 230],
        getPixelOffset: (d: any) => d.off,
        getTextAnchor: 'middle',
        fontFamily: '"Segoe UI", sans-serif',
        pickable: false,
      }));
    }

    this.deck.setProps({ layers });
  }

  private hover(info: any) {
    const r: RegionAgg | undefined = info.object;
    if (!r) { this.tooltipEl.style.display = 'none'; return; }
    const top = Object.entries(r.types).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([t, n]) => `${t} (${n})`).join(', ');
    this.tooltipEl.innerHTML =
      `<b>${r.display}</b><br/>${r.geo || r.region}<br/>` +
      `Cost: <b>${compactMoney(r.cost, this.currency)}</b><br/>` +
      `Resources: ${r.count}<br/><span style="opacity:.8">${top}</span>`;
    this.tooltipEl.style.display = 'block';
    this.tooltipEl.style.left = `${info.x + 12}px`;
    this.tooltipEl.style.top = `${info.y + 12}px`;
  }
}
