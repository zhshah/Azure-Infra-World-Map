export function money(n: number | undefined | null, currency = 'USD'): string {
  if (n == null || isNaN(n)) return '—';
  const opts: Intl.NumberFormatOptions = {
    style: 'currency', currency,
    minimumFractionDigits: n >= 1000 ? 0 : 2,
    maximumFractionDigits: n >= 1000 ? 0 : 2,
  };
  try { return new Intl.NumberFormat('en-US', opts).format(n); }
  catch { return `${currency} ${n.toFixed(2)}`; }
}

export function compactMoney(n: number, currency = 'USD'): string {
  if (n == null || isNaN(n)) return '—';
  if (Math.abs(n) >= 1000) {
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }).format(n);
    } catch { /* fall through */ }
  }
  return money(n, currency);
}

export function num(n: number): string {
  return new Intl.NumberFormat('en-US').format(n);
}

// Short type label, e.g. microsoft.compute/virtualmachines -> Compute / virtualMachines
export function shortType(t: string): string {
  if (!t) return '';
  const [ns, ...rest] = t.split('/');
  const provider = ns.replace(/^microsoft\./, '');
  return `${provider}/${rest.join('/')}`;
}

export function resName(id: string): string {
  const parts = id.split('/');
  return parts[parts.length - 1] || id;
}

// Map a numeric value to a blue→amber→red cost ramp (returns [r,g,b]).
export function costColor(t: number): [number, number, number] {
  const c = Math.max(0, Math.min(1, t));
  if (c < 0.5) {
    const k = c / 0.5; // blue -> amber
    return [Math.round(40 + k * 200), Math.round(150 + k * 50), Math.round(220 - k * 160)];
  }
  const k = (c - 0.5) / 0.5; // amber -> red
  return [Math.round(240), Math.round(200 - k * 160), Math.round(60 - k * 20)];
}
