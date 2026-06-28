// "What's New in Azure" content catalog — aggregates REAL official Microsoft feeds:
//   1. Azure Updates  (https://www.microsoft.com/releasecommunications/api/v2/azure)
//   2. Official Microsoft YouTube channels (RSS), resolved from @handle → channelId.
// Items are tagged with a content category so the UI can map them to the
// resource type the user is viewing. Cached + disk-backed for resilience.
import { getDisk, setDisk } from './disk-cache.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function fetchText(url, { timeout = 15000, headers = {} } = {}) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', ...headers },
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  return r.text();
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&(?:rsquo|lsquo|#8217|#8216);/g, "'")
    .replace(/&(?:ldquo|rdquo|#8220|#8221);/g, '"')
    .replace(/&(?:mdash|#8212);/g, '\u2014')
    .replace(/&(?:ndash|#8211);/g, '\u2013')
    .replace(/&(?:hellip|#8230);/g, '\u2026')
    .replace(/&(?:bull|#8226);/g, '\u2022')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Strip HTML to readable text so update detail renders inside the tool (no external nav).
function stripHtml(html) {
  const txt = String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|li|h\d|br)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\u2022 ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(txt).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1600);
}

// ---- Content taxonomy (also used to map Azure resource types → category) ----
export const CATEGORIES = [
  { id: 'compute', label: 'Compute', kw: ['virtual machine', 'vm ', 'vmss', 'scale set', 'compute', 'azure batch', 'dedicated host', 'spot '] },
  { id: 'containers', label: 'Containers', kw: ['kubernetes', 'aks', 'container app', 'container instance', 'container registry', 'acr ', 'containers'] },
  { id: 'web', label: 'Web & Serverless', kw: ['app service', 'web app', 'static web', 'azure functions', 'function app', 'logic apps', 'api management', 'spring apps'] },
  { id: 'database', label: 'Databases', kw: ['azure sql', 'sql database', 'cosmos', 'postgresql', 'mysql', 'mariadb', 'database', 'azure cache for redis', 'redis'] },
  { id: 'storage', label: 'Storage', kw: ['storage', 'blob', 'azure files', 'data lake', 'netapp', 'managed disk', 'azure backup', 'archive', 'azure elastic san'] },
  { id: 'ai', label: 'AI + ML', kw: ['azure openai', 'azure ai', 'cognitive', 'machine learning', 'foundry', 'azure ai speech', 'computer vision', 'language', 'ai search', 'copilot', 'document intelligence'] },
  { id: 'networking', label: 'Networking', kw: ['virtual network', 'vnet', 'azure firewall', 'load balancer', 'front door', 'azure cdn', 'azure dns', 'vpn gateway', 'expressroute', 'bastion', 'application gateway', 'traffic manager', 'private link', 'nat gateway'] },
  { id: 'security', label: 'Security & Identity', kw: ['defender', 'sentinel', 'key vault', 'microsoft entra', 'active directory', 'managed identity', 'azure policy', 'compliance', 'security', 'confidential'] },
  { id: 'analytics', label: 'Analytics', kw: ['synapse', 'data factory', 'databricks', 'stream analytics', 'event hubs', 'data explorer', 'purview', 'microsoft fabric', 'hdinsight'] },
  { id: 'integration', label: 'Integration', kw: ['service bus', 'event grid', 'logic apps', 'api management', 'integration'] },
  { id: 'devops', label: 'DevOps & Monitor', kw: ['azure devops', 'github', 'pipeline', 'azure monitor', 'log analytics', 'application insights', 'managed grafana', 'managed prometheus'] },
  { id: 'management', label: 'Management & Cost', kw: ['cost management', 'finops', 'azure advisor', 'resource graph', 'bicep', 'governance', 'management group', 'azure blueprints', 'resource manager', 'tags'] },
];

export function categorize(text) {
  const t = (text || '').toLowerCase();
  for (const c of CATEGORIES) if (c.kw.some((k) => t.includes(k))) return c.id;
  return 'management';
}

// ---- Azure Updates ----
function azureUpdateUrl(id) { return `https://azure.microsoft.com/en-us/updates/?id=${encodeURIComponent(id)}`; }

async function fetchAzureUpdates() {
  let arr = [];
  try {
    const txt = await fetchText('https://www.microsoft.com/releasecommunications/api/v2/azure?$top=200&$skip=0&$orderby=modified%20desc');
    const j = JSON.parse(txt);
    arr = j.value || (Array.isArray(j) ? j : []);
  } catch {
    // Fallback to the classic RSS feed.
    const xml = await fetchText('https://azure.microsoft.com/en-us/updates/feed/');
    arr = xml.split('<item>').slice(1).map((blk) => ({
      id: (blk.match(/<guid[^>]*>([^<]+)<\/guid>/) || [])[1] || '',
      title: decodeEntities((blk.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || ''),
      description: (blk.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/) || [])[1] || '',
      modified: (blk.match(/<pubDate>([^<]+)<\/pubDate>/) || [])[1] || '',
      products: [], tags: [],
      _link: (blk.match(/<link>([^<]+)<\/link>/) || [])[1] || '',
    }));
  }
  return arr.map((it) => {
    const products = it.products || [];
    const tags = it.tags || [];
    const text = `${it.title} ${products.join(' ')} ${tags.join(' ')}`;
    return {
      id: it.id,
      title: decodeEntities(it.title),
      url: it._link || azureUpdateUrl(it.id),
      status: it.status || '',
      date: it.modified || it.created || '',
      products: products.slice(0, 6),
      description: stripHtml(it.description),
      category: categorize(text),
    };
  }).filter((x) => x.title)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 100);
}

// ---- Official Microsoft YouTube channels ----
// Source channels we pull uploads from. Only a curated subset is surfaced to the UI
// as catalogs (see getWhatsNew): Microsoft Build, Microsoft Ignite, Azure Update, Mechanics.
const CHANNELS = [
  { id: 'azure', name: 'Azure Update', handle: '@MicrosoftAzure' },
  { id: 'mechanics', name: 'Mechanics', handle: '@MSFTMechanics' },
  { id: 'developer', name: 'Developer', handle: '@MicrosoftDeveloper' },
  { id: 'reactor', name: 'Reactor', handle: '@MicrosoftReactor' },
  { id: 'microsoft', name: 'Microsoft', handle: '@Microsoft' },
];

// Curated event catalogs, assembled by keyword-matching across every channel's
// uploads so "Build" and "Ignite" surface real session/keynote content the user can
// pick — instead of whatever happened to be the latest random upload. The catalogs
// are always offered (even when momentarily empty) so the picker stays predictable.
const EVENT_CATALOGS = [
  { id: 'ignite', name: 'Microsoft Ignite', match: /\bmicrosoft ignite\b|\bmsignite\b|\bignite 20\d\d\b|\bignite\b/i },
];

// ---- Microsoft Build 2026 session catalog (REAL sessions from build.microsoft.com) ----
// The catalog is rendered client-side via RainFocus (no server-fetchable API), so we
// curate real on-demand sessions pulled from the live Build site and link straight to
// each session page (reliable, no fragile video embed). Filterable by topic/type/level.
const BUILD_EVENT = { name: 'Microsoft Build 2026', url: 'https://build.microsoft.com/en-US/sessions' };
const BUILD_SESSIONS = [
  { code: 'KEY01', title: 'Microsoft Build opening keynote', type: 'Keynote', level: 200, topic: 'Keynotes & Live', speaker: 'Satya Nadella' },
  { code: 'LIVE109', title: "What's real, ready, and next for developers with Scott Guthrie", type: 'Broadcast Stage', level: 0, topic: 'Keynotes & Live', speaker: 'Scott Guthrie, Seth Juarez' },
  { code: 'LIVE101', title: 'Scott and Mark learn to Vibe Check', type: 'Broadcast Stage', level: 0, topic: 'Keynotes & Live', speaker: 'Scott Hanselman, Mark Russinovich' },
  { code: 'LIVE110', title: 'Backing the future of innovation', type: 'Broadcast Stage', level: 0, topic: 'Keynotes & Live', speaker: 'Charles Lamanna' },
  { code: 'LIVESP128', title: 'From local AI PCs to Azure: The future of open-source AI development', type: 'Broadcast Stage', level: 0, topic: 'Keynotes & Live', speaker: 'Adrian Macias (AMD)' },
  { code: 'LIVE199', title: 'Imagine Cup World Championship', type: 'Broadcast Stage', level: 0, topic: 'Agents & apps', speaker: 'Patrick Brown' },
  { code: 'BRK230', title: 'Build smarter AI systems in Foundry as models and costs evolve', type: 'Breakout', level: 300, topic: 'Working with models', speaker: 'Yina Arenas' },
  { code: 'DEM321', title: 'Post-Training and Deploying Open Source Reasoning Models in Foundry', type: 'Demo', level: 200, topic: 'Working with models', speaker: 'Vijay Aski' },
  { code: 'BRK200', title: "Why your AI code doesn\u2019t ship: Closing the gap to production", type: 'Breakout', level: 300, topic: 'Developer tools & frameworks', speaker: 'Mario Rodriguez (GitHub)' },
  { code: 'BRKSP93', title: 'Build AI across client and cloud with AMD ROCm and Microsoft', type: 'Breakout', level: 300, topic: 'Developer tools & frameworks', speaker: 'Anush Elangovan (AMD)' },
  { code: 'DEMSP394', title: 'Scale enterprise .NET apps with AI-assisted cross-platform workflows', type: 'Demo', level: 200, topic: 'Developer tools & frameworks', speaker: 'Sam Basu (Uno Platform)' },
  { code: 'DEMSP388', title: 'Ship faster with Claude Code and Cowork in Microsoft Foundry', type: 'Demo', level: 200, topic: 'Developer tools & frameworks', speaker: 'Caroline Matthews (Anthropic)' },
  { code: 'DEM313', title: 'Build agentic apps in minutes with Rayfin and Microsoft Fabric', type: 'Demo', level: 300, topic: 'Cloud platform & data', speaker: 'Chris Anderson' },
  { code: 'BRK223', title: 'From rows to reasoning: Designing databases for AI apps and agents', type: 'Breakout', level: 300, topic: 'Cloud platform & data', speaker: 'Charles Feddersen' },
  { code: 'DEMSP384', title: 'Profile and optimize agentic AI on Windows', type: 'Demo', level: 300, topic: 'Cloud platform & data', speaker: 'Freddy Chiu (Intel)' },
  { code: 'BRK245', title: 'Build the thing that builds the thing', type: 'Breakout', level: 200, topic: 'Agents & apps', speaker: 'Peter Steinberger' },
  { code: 'DEMSP380', title: 'Build automated agents using optimized AI Foundry models on Snapdragon', type: 'Demo', level: 200, topic: 'Agents & apps', speaker: 'Darren Oberst (LLMware.ai)' },
  { code: 'DEMSP383', title: 'Move AI workflows from test to production on Microsoft Foundry', type: 'Demo', level: 200, topic: 'Agents & apps', speaker: 'Vignesh Sridhar (Fireworks AI)' },
  { code: 'DEMSP385', title: 'Build context-aware agents using GitHub Copilot, Elastic, and Azure AI', type: 'Demo', level: 300, topic: 'Agents & apps', speaker: 'Jeff Vestal (Elastic)' },
  { code: 'BRK261', title: 'Build and ship faster with a developer-optimized experience on Windows', type: 'Breakout', level: 300, topic: 'Windows', speaker: 'Kayla Cinnamon, Craig Loewen' },
  { code: 'DEM346', title: 'WSL improvements and the new Containers CLI and APIs', type: 'Demo', level: 400, topic: 'Windows', speaker: 'Craig Loewen' },
].map((s) => ({ ...s, url: `https://build.microsoft.com/en-US/sessions/${s.code}?source=sessions` }));

function buildSessionsCatalog(videos = []) {
  const sessions = BUILD_SESSIONS;
  return {
    event: BUILD_EVENT.name, url: BUILD_EVENT.url, sessions, videos,
    topics: [...new Set(sessions.map((s) => s.topic))].sort(),
    types: [...new Set(sessions.map((s) => s.type))],
    levels: [...new Set(sessions.map((s) => s.level).filter(Boolean))].sort((a, b) => a - b),
  };
}

// Real Microsoft Build session recordings. The Build catalog above is RainFocus-rendered
// (no server API) and the YouTube channel RSS only exposes each channel's latest ~15
// uploads, so event videos scroll off within weeks. To give the Build tab real, playable
// thumbnails year-round we scrape the official @MicrosoftDeveloper channel's in-channel
// search for "Microsoft Build" — every result is a real video with a real YouTube
// thumbnail. Disk-cached (12h) so we don't hit YouTube on each request.
async function fetchBuildVideos() {
  const cacheKey = 'buildvids:v2';
  const cached = await getDisk(cacheKey, 12 * 60 * 60 * 1000);
  if (cached) return cached;
  const videos = [];
  try {
    const html = await fetchText('https://www.youtube.com/@MicrosoftDeveloper/search?query=Microsoft%20Build');
    const re = /"videoRenderer":\{"videoId":"([\w-]{11})"[\s\S]*?"text":"([^"]{6,120})"/g;
    const seen = new Set();
    let m;
    while ((m = re.exec(html)) && videos.length < 24) {
      const videoId = m[1];
      if (seen.has(videoId)) continue;
      const title = m[2].replace(/\\u([\dA-Fa-f]{4})/g, (_, hh) => String.fromCharCode(parseInt(hh, 16))).trim();
      // Keep genuine Build content (event name or a session code); skip channel chrome.
      if (!/microsoft build|ms ?build|\bbuild 20\d\d\b|\b(?:KEY|BRK|DEM|LIVE|LAB|WRK|OD)\w*\d/i.test(title)) continue;
      seen.add(videoId);
      videos.push({ videoId, title, published: '', thumb: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, category: categorize(title) });
    }
  } catch (e) { console.warn('[whatsnew] build videos failed:', e?.message || e); }
  if (videos.length) await setDisk(cacheKey, videos);
  return videos;
}

async function resolveChannelId(handle) {
  const cacheKey = `ytid:${handle}`;
  const cached = await getDisk(cacheKey, 7 * 24 * 60 * 60 * 1000);
  if (cached) return cached;
  const html = await fetchText(`https://www.youtube.com/${handle}?hl=en&gl=US`);
  const m = html.match(/"channelId":"(UC[\w-]{22})"/) || html.match(/channel_id=(UC[\w-]{22})/);
  if (!m) throw new Error(`no channelId for ${handle}`);
  await setDisk(cacheKey, m[1]);
  return m[1];
}

async function fetchChannelVideos(channelId) {
  const xml = await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
  return xml.split('<entry>').slice(1).map((e) => {
    const videoId = (e.match(/<yt:videoId>([\w-]{11})<\/yt:videoId>/) || [])[1];
    if (!videoId) return null;
    const title = decodeEntities((e.match(/<media:title>([\s\S]*?)<\/media:title>/) || e.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
    const published = (e.match(/<published>([^<]+)<\/published>/) || [])[1] || '';
    const thumb = (e.match(/<media:thumbnail url="([^"]+)"/) || [])[1] || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    return { videoId, title, published, thumb, category: categorize(title) };
  }).filter(Boolean).slice(0, 15);
}

export async function getWhatsNew() {
  const [updates, rawChannels, buildVideos] = await Promise.all([
    fetchAzureUpdates().catch((e) => { console.warn('[whatsnew] updates failed:', e?.message || e); return []; }),
    Promise.all(CHANNELS.map(async (c) => {
      try {
        const channelId = await resolveChannelId(c.handle);
        const videos = await fetchChannelVideos(channelId);
        return { ...c, channelId, videos };
      } catch (e) { console.warn(`[whatsnew] channel ${c.handle} failed:`, e?.message || e); return { ...c, videos: [] }; }
    })),
    fetchBuildVideos().catch((e) => { console.warn('[whatsnew] build videos failed:', e?.message || e); return []; }),
  ]);
  const liveChannels = rawChannels.filter((c) => c.videos.length);
  // Dedupe the union of all fetched videos so curated catalogs don't repeat a clip.
  const seen = new Set();
  const allVideos = [];
  for (const c of liveChannels) {
    for (const v of c.videos) {
      if (seen.has(v.videoId)) continue;
      seen.add(v.videoId);
      allVideos.push(v);
    }
  }
  const eventChannels = EVENT_CATALOGS.map((e) => ({
    id: e.id,
    name: e.name,
    event: true,
    videos: allVideos
      .filter((v) => e.match.test(v.title))
      .sort((a, b) => String(b.published).localeCompare(String(a.published)))
      .slice(0, 20),
  }));
  // Surface exactly the four catalogs requested: Build, Ignite, Azure Update, Mechanics.
  // (developer / microsoft / reactor are kept only as curation sources, not shown.)
  const byId = Object.fromEntries(liveChannels.map((c) => [c.id, c]));
  const channels = [...eventChannels];
  if (byId.azure) channels.push(byId.azure);
  if (byId.mechanics) channels.push(byId.mechanics);
  return {
    updates,
    channels,
    build: buildSessionsCatalog(buildVideos),
    categories: CATEGORIES,
    fetchedAt: Date.now(),
  };
}
