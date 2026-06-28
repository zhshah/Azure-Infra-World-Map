// Pluggable snapshot store: persists resource metric/detail/activity JSON so the
// UI stays populated when live Azure Monitor / Cost APIs throttle or rate-limit.
//
// Backends (in priority order on read, fan-out on write):
//   1. Disk (.cache) — always on, zero config.
//   2. Azure SQL    — when SQL_SERVER + SQL_DATABASE are set (Entra-only auth).
//   3. Azure Cosmos — when COSMOS_ENDPOINT + COSMOS_DATABASE are set (optional).
//
// No cloud resources are provisioned here; backends 2/3 are opt-in via env.
import { getDisk, setDisk } from './disk-cache.mjs';
import { saveSnapshotSql, loadSnapshotSql, isEnabled as sqlEnabled } from './sql.mjs';

const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT;
const COSMOS_DATABASE = process.env.COSMOS_DATABASE;
const COSMOS_CONTAINER = process.env.COSMOS_CONTAINER || 'snapshots';
const cosmosOn = Boolean(COSMOS_ENDPOINT && COSMOS_DATABASE);

let _cosmosContainer;
async function cosmosContainer() {
  if (!cosmosOn) return null;
  if (_cosmosContainer !== undefined) return _cosmosContainer;
  try {
    const { CosmosClient } = await import('@azure/cosmos');
    const { getCredential } = await import('./azure.mjs');
    const client = new CosmosClient({ endpoint: COSMOS_ENDPOINT, aadCredentials: getCredential() });
    const { database } = await client.databases.createIfNotExists({ id: COSMOS_DATABASE });
    const { container } = await database.containers.createIfNotExists({ id: COSMOS_CONTAINER, partitionKey: { paths: ['/kind'] } });
    _cosmosContainer = container;
  } catch (err) {
    console.warn('[store] Cosmos disabled:', err?.message || err);
    _cosmosContainer = null;
  }
  return _cosmosContainer;
}

const diskKey = (kind, key) => `snap:${kind}:${String(key).toLowerCase()}`;
const cosmosId = (kind, key) => `${kind}::${String(key).toLowerCase()}`.replace(/[/#?\\]/g, '_');

export function storeStatus() {
  return { disk: true, sql: sqlEnabled(), cosmos: cosmosOn };
}

// Persist a snapshot to every configured backend (best-effort, non-blocking failures).
export async function saveSnapshot(kind, key, data) {
  const envelope = { at: Date.now(), data };
  await setDisk(diskKey(kind, key), envelope);
  const tasks = [];
  if (sqlEnabled()) tasks.push(saveSnapshotSql(kind, key, envelope));
  if (cosmosOn) tasks.push((async () => {
    const c = await cosmosContainer();
    if (c) { try { await c.items.upsert({ id: cosmosId(kind, key), kind, key: String(key), at: envelope.at, data }); } catch { /* ignore */ } }
  })());
  if (tasks.length) await Promise.allSettled(tasks);
  return envelope;
}

// Load the freshest snapshot within maxAgeMs (disk → SQL → Cosmos).
export async function loadSnapshot(kind, key, maxAgeMs = 24 * 60 * 60 * 1000) {
  const d = await getDisk(diskKey(kind, key), maxAgeMs);
  if (d) return d;
  if (sqlEnabled()) {
    const s = await loadSnapshotSql(kind, key, maxAgeMs);
    if (s) { await setDisk(diskKey(kind, key), s); return s; }
  }
  if (cosmosOn) {
    try {
      const c = await cosmosContainer();
      if (c) {
        const { resource } = await c.item(cosmosId(kind, key), kind).read();
        if (resource && (!maxAgeMs || Date.now() - resource.at <= maxAgeMs)) {
          const env = { at: resource.at, data: resource.data };
          await setDisk(diskKey(kind, key), env);
          return env;
        }
      }
    } catch { /* ignore */ }
  }
  return null;
}

// Wrap a live fetch: try live; on failure/empty, fall back to the last snapshot
// (flagged stale). `isEmpty` decides whether a live result is worth keeping.
export async function withSnapshot(kind, key, liveFn, { maxAgeMs, isEmpty } = {}) {
  try {
    const live = await liveFn();
    const empty = isEmpty ? isEmpty(live) : (live == null);
    if (!empty) { await saveSnapshot(kind, key, live); return { ...live, _stale: false }; }
    const snap = await loadSnapshot(kind, key, maxAgeMs);
    if (snap) return { ...snap.data, _stale: true, _snapshotAt: snap.at };
    return live;
  } catch (err) {
    const snap = await loadSnapshot(kind, key, maxAgeMs);
    if (snap) return { ...snap.data, _stale: true, _snapshotAt: snap.at, _liveError: err?.message || String(err) };
    throw err;
  }
}
