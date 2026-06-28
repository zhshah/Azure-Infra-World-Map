// Azure region → ISO 3166-1 alpha-2 country code, plus flag image helpers.
// Flags are served from flagcdn.com (CORS-enabled, cached static PNGs).

export const REGION_CC: Record<string, string> = {
  // Americas
  eastus: 'us', eastus2: 'us', eastus3: 'us', centralus: 'us', northcentralus: 'us',
  southcentralus: 'us', westcentralus: 'us', westus: 'us', westus2: 'us', westus3: 'us',
  canadacentral: 'ca', canadaeast: 'ca',
  brazilsouth: 'br', brazilsoutheast: 'br', brazilus: 'us',
  mexicocentral: 'mx', chilecentral: 'cl',
  // Europe
  northeurope: 'ie', westeurope: 'nl',
  uksouth: 'gb', ukwest: 'gb',
  francecentral: 'fr', francesouth: 'fr',
  germanywestcentral: 'de', germanynorth: 'de',
  switzerlandnorth: 'ch', switzerlandwest: 'ch',
  norwayeast: 'no', norwaywest: 'no',
  swedencentral: 'se', swedensouth: 'se',
  polandcentral: 'pl', italynorth: 'it', spaincentral: 'es', austriaeast: 'at',
  // Middle East & Africa
  uaenorth: 'ae', uaecentral: 'ae', qatarcentral: 'qa', israelcentral: 'il',
  southafricanorth: 'za', southafricawest: 'za',
  // Asia Pacific
  eastasia: 'hk', southeastasia: 'sg',
  japaneast: 'jp', japanwest: 'jp', koreacentral: 'kr', koreasouth: 'kr',
  centralindia: 'in', southindia: 'in', westindia: 'in', jioindiawest: 'in', jioindiacentral: 'in',
  australiaeast: 'au', australiasoutheast: 'au', australiacentral: 'au', australiacentral2: 'au',
  indonesiacentral: 'id', malaysiawest: 'my', malaysiasouth: 'my', newzealandnorth: 'nz',
  chinaeast: 'cn', chinaeast2: 'cn', chinaeast3: 'cn', chinanorth: 'cn', chinanorth2: 'cn', chinanorth3: 'cn',
  taiwannorth: 'tw', taiwannorthwest: 'tw',
};

export function regionCc(region: string): string | undefined {
  return REGION_CC[(region || '').toLowerCase()];
}

// Flag PNG URL for the deck.gl IconLayer.
export function flagUrl(cc: string, w = 40): string {
  return `https://flagcdn.com/w${w}/${cc}.png`;
}

// Inline <img> flag for HTML panels (SVG scales to any size; hides itself on error).
export function flagImg(region: string, opts: { w?: number; cls?: string } = {}): string {
  const cc = regionCc(region);
  if (!cc) return '';
  const w = opts.w ?? 20;
  const ht = Math.round(w * 0.75);
  return `<img class="cflag ${opts.cls || ''}" src="https://flagcdn.com/${cc}.svg" width="${w}" height="${ht}" alt="${cc.toUpperCase()}" loading="lazy" onerror="this.style.display='none'"/>`;
}
