// Self-contained SVG chart toolkit (no external deps) — command-center theme.
// All functions return HTML strings to drop into innerHTML.

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export const PALETTE = [
  '#44ff88', '#3bd6ff', '#ffaa00', '#ff6b9d', '#a78bfa', '#ff8800',
  '#4ade80', '#38bdf8', '#facc15', '#fb7185', '#c084fc', '#2dd4bf',
  '#f97316', '#22d3ee', '#e879f9', '#84cc16',
];

export function compact(n: number): string {
  if (n == null || isNaN(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  if (a >= 10) return n.toFixed(0);
  if (a >= 1) return n.toFixed(1);
  if (a === 0) return '0';
  return n.toFixed(2);
}

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}
function arcPath(cx: number, cy: number, r: number, start: number, end: number): string {
  const [sx, sy] = polar(cx, cy, r, end);
  const [ex, ey] = polar(cx, cy, r, start);
  const large = end - start <= 180 ? 0 : 1;
  return `M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${r} ${r} 0 ${large} 0 ${ex.toFixed(2)} ${ey.toFixed(2)}`;
}

export interface Segment { label: string; value: number; color?: string; }

// Donut chart with side legend. `center`/`centerSub` show in the hole.
export function donut(
  segments: Segment[],
  opts: { size?: number; thickness?: number; center?: string; centerSub?: string; fmt?: (v: number) => string; max?: number } = {},
): string {
  const size = opts.size ?? 132;
  const th = opts.thickness ?? 18;
  const fmt = opts.fmt ?? compact;
  const segs = segments.filter((s) => s.value > 0);
  const total = segs.reduce((s, x) => s + x.value, 0);
  const r = (size - th) / 2;
  const cx = size / 2, cy = size / 2;
  let html = `<div class="chart-donut">`;
  html += `<svg viewBox="0 0 ${size} ${size}" class="donut-svg" width="${size}" height="${size}">`;
  html += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(255,255,255,.05)" stroke-width="${th}"/>`;
  if (total > 0) {
    let acc = 0;
    segs.forEach((s, i) => {
      const frac = s.value / total;
      const start = acc * 360, end = (acc + frac) * 360;
      acc += frac;
      const col = s.color || PALETTE[i % PALETTE.length];
      // tiny gap between segments
      const a0 = start + 1.2, a1 = Math.max(start + 1.4, end - 1.2);
      html += `<path d="${arcPath(cx, cy, r, a0, a1)}" fill="none" stroke="${col}" stroke-width="${th}" stroke-linecap="butt"><title>${esc(s.label)}: ${esc(fmt(s.value))} (${(frac * 100).toFixed(0)}%)</title></path>`;
    });
  }
  if (opts.center != null) {
    html += `<text x="${cx}" y="${cy - 2}" text-anchor="middle" class="donut-center">${esc(opts.center)}</text>`;
    if (opts.centerSub) html += `<text x="${cx}" y="${cy + 13}" text-anchor="middle" class="donut-center-sub">${esc(opts.centerSub)}</text>`;
  }
  html += `</svg>`;
  // legend
  html += `<div class="chart-legend">` + segs.slice(0, 8).map((s, i) => {
    const col = s.color || PALETTE[i % PALETTE.length];
    const pct = total > 0 ? ((s.value / total) * 100).toFixed(0) : '0';
    return `<div class="leg-row"><span class="leg-sw" style="background:${col}"></span><span class="leg-name" title="${esc(s.label)}">${esc(s.label)}</span><span class="leg-val">${esc(fmt(s.value))}</span><span class="leg-pct">${pct}%</span></div>`;
  }).join('') + `</div></div>`;
  return html;
}

// 270° ring gauge for a 0..100 percentage (score / coverage).
export function gauge(
  pct: number,
  opts: { size?: number; label?: string; sub?: string; color?: string; sweep?: number } = {},
): string {
  const size = opts.size ?? 120;
  const sweep = opts.sweep ?? 270;
  const th = 12;
  const r = (size - th) / 2;
  const cx = size / 2, cy = size / 2;
  const p = Math.max(0, Math.min(100, pct || 0));
  const start = -sweep / 2, end = sweep / 2;
  const valEnd = start + (p / 100) * sweep;
  const col = opts.color || (p >= 75 ? '#44ff88' : p >= 40 ? '#ffaa00' : '#ff6b4a');
  // rotate so the gap is at the bottom
  const rot = 180;
  let html = `<div class="chart-gauge"><svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" style="transform:rotate(${rot}deg)">`;
  html += `<path d="${arcPath(cx, cy, r, start, end)}" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="${th}" stroke-linecap="round"/>`;
  if (p > 0) html += `<path d="${arcPath(cx, cy, r, start, valEnd)}" fill="none" stroke="${col}" stroke-width="${th}" stroke-linecap="round"/>`;
  html += `</svg><div class="gauge-center"><div class="gauge-big" style="color:${col}">${Math.round(p)}<span class="gauge-pct">%</span></div>${opts.label ? `<div class="gauge-label">${esc(opts.label)}</div>` : ''}</div></div>`;
  if (opts.sub) html += `<div class="gauge-sub">${esc(opts.sub)}</div>`;
  return `<div class="gauge-wrap">${html}</div>`;
}

export interface MetricPoint { t: string; avg: number | null; max?: number | null; }

function fmtTimeLabel(iso: string, span: number): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  if (span <= 26 * 3600 * 1000) return d.toUTCString().slice(17, 22); // HH:MM
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

// Detailed metric line chart: avg area + line, optional faint max line, grid, axes, stat chips.
export function metricChart(
  series: { name: string; unit?: string; points: MetricPoint[]; color?: string },
  opts: { height?: number; width?: number } = {},
): string {
  const pts = (series.points || []).filter((p) => p.avg != null);
  if (!pts.length) return `<div class="mchart empty"><span class="muted">no data</span></div>`;
  const W = opts.width ?? 560, H = opts.height ?? 150;
  const padL = 38, padR = 8, padT = 10, padB = 18;
  const col = series.color || '#44ff88';
  const avgs = pts.map((p) => p.avg as number);
  const maxs = pts.map((p) => (p.max ?? p.avg) as number);
  const dataMax = Math.max(...maxs, 0.0001);
  const dataMin = Math.min(...avgs, 0);
  const lo = dataMin > 0 ? 0 : dataMin;
  const hi = dataMax * 1.08 || 1;
  const n = pts.length;
  const x = (i: number) => padL + (i / (n - 1 || 1)) * (W - padL - padR);
  const y = (v: number) => padT + (1 - (v - lo) / (hi - lo || 1)) * (H - padT - padB);
  const lineFor = (vals: number[]) => vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const avgLine = lineFor(avgs);
  const area = `${padL},${(H - padB).toFixed(1)} ${avgLine} ${(W - padR).toFixed(1)},${(H - padB).toFixed(1)}`;
  // gridlines + y labels (3 bands)
  let grid = '';
  for (let g = 0; g <= 3; g++) {
    const v = lo + ((hi - lo) * g) / 3;
    const yy = y(v);
    grid += `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}" stroke="rgba(255,255,255,.06)" stroke-width="1"/>`;
    grid += `<text x="${padL - 4}" y="${(yy + 3).toFixed(1)}" text-anchor="end" class="ax-lab">${compact(v)}</text>`;
  }
  const span = new Date(pts[n - 1].t).getTime() - new Date(pts[0].t).getTime();
  const xLabs = [0, Math.floor(n / 2), n - 1].map((i) =>
    `<text x="${x(i).toFixed(1)}" y="${H - 5}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}" class="ax-lab">${esc(fmtTimeLabel(pts[i].t, span))}</text>`).join('');
  const showMax = pts.some((p) => p.max != null && p.max !== p.avg);
  const maxLine = showMax ? `<polyline points="${lineFor(maxs)}" fill="none" stroke="${col}" stroke-width="1" stroke-dasharray="3 3" opacity=".45"/>` : '';
  const lastX = x(n - 1), lastY = y(avgs[n - 1]);
  const gid = 'g' + Math.random().toString(36).slice(2, 8);
  const avg = avgs.reduce((s, v) => s + v, 0) / n;
  const unit = series.unit && series.unit !== 'Count' ? ` ${series.unit}` : '';
  const chips = `<div class="mstats">` +
    `<span class="mstat"><i>last</i>${compact(avgs[n - 1])}${esc(unit)}</span>` +
    `<span class="mstat"><i>avg</i>${compact(avg)}${esc(unit)}</span>` +
    `<span class="mstat"><i>max</i>${compact(Math.max(...maxs))}${esc(unit)}</span>` +
    `<span class="mstat"><i>min</i>${compact(Math.min(...avgs))}${esc(unit)}</span></div>`;
  return `<div class="mchart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="mchart-svg">` +
    `<defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="${col}" stop-opacity=".28"/><stop offset="100%" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>` +
    grid +
    `<polygon points="${area}" fill="url(#${gid})"/>` +
    maxLine +
    `<polyline points="${avgLine}" fill="none" stroke="${col}" stroke-width="1.6"/>` +
    `<circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="2.6" fill="${col}"/>` +
    xLabs +
    `</svg>${chips}</div>`;
}

// Vertical column chart with value labels + baseline.
export function columns(
  items: { label: string; value: number; color?: string }[],
  opts: { height?: number; fmt?: (v: number) => string } = {},
): string {
  if (!items.length) return '<span class="muted">no data</span>';
  const H = opts.height ?? 90, fmt = opts.fmt ?? compact;
  const max = Math.max(...items.map((i) => i.value), 0.0001);
  return `<div class="chart-cols" style="height:${H + 30}px">` + items.map((it, i) => {
    const bh = Math.max(2, (it.value / max) * H);
    const col = it.color || PALETTE[i % PALETTE.length];
    return `<div class="col-item"><div class="col-val">${esc(fmt(it.value))}</div><div class="col-bar" style="height:${bh.toFixed(0)}px;background:linear-gradient(${col},${col}55)"></div><div class="col-lab" title="${esc(it.label)}">${esc(it.label)}</div></div>`;
  }).join('') + `</div>`;
}

// Improved sparkline with gradient fill + endpoint dot.
export function sparkline(values: number[], color = '#3bd6ff', opts: { width?: number; height?: number } = {}): string {
  const vals = values.filter((v) => v != null && !isNaN(v));
  if (!vals.length) return '<span class="muted small">—</span>';
  const W = opts.width ?? 320, H = opts.height ?? 42, n = vals.length;
  const max = Math.max(...vals), min = Math.min(...vals), rng = max - min || 1;
  const x = (i: number) => (i / (n - 1 || 1)) * W;
  const y = (v: number) => H - 3 - ((v - min) / rng) * (H - 8);
  const line = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `0,${H} ${line} ${W},${H}`;
  const gid = 'sp' + Math.random().toString(36).slice(2, 8);
  return `<svg class="spark-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
    `<defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity=".25"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>` +
    `<polygon points="${area}" fill="url(#${gid})"/>` +
    `<polyline points="${line}" fill="none" stroke="${color}" stroke-width="1.4"/>` +
    `<circle cx="${x(n - 1).toFixed(1)}" cy="${y(vals[n - 1]).toFixed(1)}" r="2.2" fill="${color}"/></svg>`;
}

// Horizontal labelled progress bar (single value vs total).
export function progressRow(label: string, value: number, total: number, opts: { color?: string; fmt?: (v: number) => string } = {}): string {
  const fmt = opts.fmt ?? compact;
  const pct = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  const col = opts.color || '#44ff88';
  return `<div class="prow"><div class="prow-top"><span class="prow-name">${esc(label)}</span><span class="prow-val">${esc(fmt(value))} / ${esc(fmt(total))}</span></div>` +
    `<div class="prow-track"><div class="prow-fill" style="width:${pct.toFixed(1)}%;background:${col}"></div></div></div>`;
}
