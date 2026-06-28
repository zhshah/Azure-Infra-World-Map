// Optional Azure SQL cost cache. No-ops unless SQL_SERVER + SQL_DATABASE are set.
// Auth: Entra access token from AzureCliCredential (no SQL password needed when
// the server is configured for Entra-only authentication).
import sql from 'mssql';
import { getCredential } from './azure.mjs';

const SERVER = process.env.SQL_SERVER;
const DATABASE = process.env.SQL_DATABASE;

export function isEnabled() {
  return Boolean(SERVER && DATABASE);
}

let _pool;
let _poolExp = 0;

async function getPool() {
  if (_pool && _poolExp > Date.now()) return _pool;
  if (_pool) { try { await _pool.close(); } catch { /* ignore */ } _pool = null; }
  const token = await getCredential().getToken('https://database.windows.net/.default');
  _pool = await new sql.ConnectionPool({
    server: SERVER,
    database: DATABASE,
    options: { encrypt: true, trustServerCertificate: false },
    authentication: { type: 'azure-active-directory-access-token', options: { token: token.token } },
  }).connect();
  _poolExp = Date.now() + 45 * 60 * 1000; // refresh well before the ~60min token TTL
  return _pool;
}

export async function ensureSchema() {
  if (!isEnabled()) return;
  const pool = await getPool();
  await pool.request().batch(`
IF OBJECT_ID('dbo.ResourceCostDaily','U') IS NULL
BEGIN
  CREATE TABLE dbo.ResourceCostDaily (
    Id bigint IDENTITY(1,1) PRIMARY KEY,
    SubscriptionId varchar(64) NOT NULL,
    ResourceId nvarchar(1024) NOT NULL,
    ResourceIdHash AS CONVERT(binary(32), HASHBYTES('SHA2_256', LOWER(ResourceId))) PERSISTED,
    UsageDate date NOT NULL,
    Cost float NOT NULL,
    Currency varchar(8) NULL
  );
  CREATE UNIQUE INDEX UX_RCD ON dbo.ResourceCostDaily (SubscriptionId, ResourceIdHash, UsageDate);
  CREATE INDEX IX_RCD_sub_date ON dbo.ResourceCostDaily (SubscriptionId, UsageDate);
END
IF OBJECT_ID('dbo.SyncMeta','U') IS NULL
BEGIN
  CREATE TABLE dbo.SyncMeta (
    SubscriptionId varchar(64) NOT NULL,
    FromDate date NOT NULL,
    ToDate date NOT NULL,
    SyncedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_SyncMeta PRIMARY KEY (SubscriptionId, FromDate, ToDate)
  );
END`);
}

// Returns Map<resourceId(lower), cost> for the window, or empty if not synced.
export async function getCostByResource(subscriptionId, from, to) {
  if (!isEnabled()) return new Map();
  const pool = await getPool();
  const meta = await pool.request()
    .input('sub', sql.VarChar(64), subscriptionId)
    .input('from', sql.Date, from)
    .input('to', sql.Date, to)
    .query('SELECT TOP 1 SyncedAt FROM dbo.SyncMeta WHERE SubscriptionId=@sub AND FromDate<=@from AND ToDate>=@to ORDER BY SyncedAt DESC');
  if (!meta.recordset.length) return new Map();
  const rows = await pool.request()
    .input('sub', sql.VarChar(64), subscriptionId)
    .input('from', sql.Date, from)
    .input('to', sql.Date, to)
    .query('SELECT ResourceId, SUM(Cost) AS Cost, MAX(Currency) AS Currency FROM dbo.ResourceCostDaily WHERE SubscriptionId=@sub AND UsageDate>=@from AND UsageDate<@to GROUP BY ResourceId');
  const map = new Map();
  let currency = 'USD';
  for (const r of rows.recordset) { map.set(String(r.ResourceId).toLowerCase(), Number(r.Cost)); currency = r.Currency || currency; }
  map.currency = currency;
  return map;
}

// Persist daily rows (key=ResourceId, date, cost, currency). Used after a live pull.
export async function upsertCostByResource(subscriptionId, from, to, rows) {
  if (!isEnabled() || !rows?.length) return;
  const pool = await getPool();
  const table = new sql.Table('dbo.ResourceCostDaily');
  table.create = false;
  table.columns.add('SubscriptionId', sql.VarChar(64), { nullable: false });
  table.columns.add('ResourceId', sql.NVarChar(1024), { nullable: false });
  table.columns.add('UsageDate', sql.Date, { nullable: false });
  table.columns.add('Cost', sql.Float, { nullable: false });
  table.columns.add('Currency', sql.VarChar(8), { nullable: true });
  let added = 0;
  for (const r of rows) {
    if (!r.key || !r.date) continue;
    const d = parseUsageDate(r.date);
    if (!d) continue;
    table.rows.add(subscriptionId, String(r.key), d, Number(r.cost || 0), r.currency || 'USD');
    added++;
  }
  if (!added) return;
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await new sql.Request(tx)
      .input('sub', sql.VarChar(64), subscriptionId)
      .input('from', sql.Date, from)
      .input('to', sql.Date, to)
      .query('DELETE FROM dbo.ResourceCostDaily WHERE SubscriptionId=@sub AND UsageDate>=@from AND UsageDate<@to');
    await new sql.Request(tx).bulk(table);
    await new sql.Request(tx)
      .input('sub', sql.VarChar(64), subscriptionId)
      .input('from', sql.Date, from)
      .input('to', sql.Date, to)
      .query('MERGE dbo.SyncMeta AS t USING (SELECT @sub AS S,@from AS F,@to AS T) src ON t.SubscriptionId=src.S AND t.FromDate=src.F AND t.ToDate=src.T WHEN MATCHED THEN UPDATE SET SyncedAt=SYSUTCDATETIME() WHEN NOT MATCHED THEN INSERT (SubscriptionId,FromDate,ToDate) VALUES (src.S,src.F,src.T);');
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}

// CostManagement Daily UsageDate comes back as yyyymmdd number (e.g. 20260626).
function parseUsageDate(v) {
  const s = String(v);
  if (/^\d{8}$/.test(s)) return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// ---- Generic snapshot store (metrics / detail / activity JSON) ------------
let _snapReady;
async function ensureSnapshotSchema() {
  if (!isEnabled()) return;
  if (_snapReady) return _snapReady;
  const pool = await getPool();
  _snapReady = pool.request().batch(`
IF OBJECT_ID('dbo.Snapshots','U') IS NULL
BEGIN
  CREATE TABLE dbo.Snapshots (
    Kind varchar(40) NOT NULL,
    ResourceKey nvarchar(1024) NOT NULL,
    KeyHash AS CONVERT(binary(32), HASHBYTES('SHA2_256', LOWER(ResourceKey))) PERSISTED,
    Payload nvarchar(max) NOT NULL,
    UpdatedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME()
  );
  CREATE UNIQUE INDEX UX_Snap ON dbo.Snapshots (Kind, KeyHash);
END`).then(() => {}).catch(() => {});
  return _snapReady;
}

export async function saveSnapshotSql(kind, key, payloadObj) {
  if (!isEnabled()) return;
  try {
    await ensureSnapshotSchema();
    const pool = await getPool();
    await pool.request()
      .input('kind', sql.VarChar(40), kind)
      .input('key', sql.NVarChar(1024), String(key))
      .input('payload', sql.NVarChar(sql.MAX), JSON.stringify(payloadObj))
      .query(`MERGE dbo.Snapshots AS t
        USING (SELECT @kind AS K, @key AS R) src
        ON t.Kind=src.K AND t.KeyHash=CONVERT(binary(32), HASHBYTES('SHA2_256', LOWER(src.R)))
        WHEN MATCHED THEN UPDATE SET Payload=@payload, UpdatedAt=SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT (Kind,ResourceKey,Payload) VALUES (@kind,@key,@payload);`);
  } catch { /* best-effort */ }
}

export async function loadSnapshotSql(kind, key, maxAgeMs) {
  if (!isEnabled()) return null;
  try {
    await ensureSnapshotSchema();
    const pool = await getPool();
    const r = await pool.request()
      .input('kind', sql.VarChar(40), kind)
      .input('key', sql.NVarChar(1024), String(key))
      .query(`SELECT TOP 1 Payload, UpdatedAt FROM dbo.Snapshots
        WHERE Kind=@kind AND KeyHash=CONVERT(binary(32), HASHBYTES('SHA2_256', LOWER(@key)))`);
    if (!r.recordset.length) return null;
    const row = r.recordset[0];
    if (maxAgeMs && Date.now() - new Date(row.UpdatedAt).getTime() > maxAgeMs) return null;
    return { at: new Date(row.UpdatedAt).getTime(), data: JSON.parse(row.Payload) };
  } catch { return null; }
}

// ---- Saved custom tabs (per signed-in user) -------------------------------
let _tabsReady;
async function ensureTabsSchema() {
  if (!isEnabled()) return;
  if (_tabsReady) return _tabsReady;
  const pool = await getPool();
  _tabsReady = pool.request().batch(`
IF OBJECT_ID('dbo.SavedTabs','U') IS NULL
BEGIN
  CREATE TABLE dbo.SavedTabs (
    UserKey varchar(256) NOT NULL,
    TabId varchar(64) NOT NULL,
    Name nvarchar(128) NOT NULL,
    Config nvarchar(max) NOT NULL,
    Position int NOT NULL DEFAULT 0,
    UpdatedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_SavedTabs PRIMARY KEY (UserKey, TabId)
  );
END`).then(() => {}).catch(() => {});
  return _tabsReady;
}

function safeJson(s) { try { return JSON.parse(s) || {}; } catch { return {}; } }

// Returns array of saved tabs for a user, or null when SQL isn't configured.
export async function listTabs(userKey) {
  if (!isEnabled()) return null;
  try {
    await ensureTabsSchema();
    const pool = await getPool();
    const r = await pool.request()
      .input('u', sql.VarChar(256), String(userKey))
      .query('SELECT TabId, Name, Config, Position FROM dbo.SavedTabs WHERE UserKey=@u ORDER BY Position, UpdatedAt');
    return r.recordset.map((row) => ({ id: row.TabId, name: row.Name, position: row.Position, ...safeJson(row.Config) }));
  } catch { return null; }
}

export async function saveTab(userKey, tab) {
  if (!isEnabled()) return false;
  try {
    await ensureTabsSchema();
    const pool = await getPool();
    const { id, name, position = 0, ...config } = tab;
    await pool.request()
      .input('u', sql.VarChar(256), String(userKey))
      .input('id', sql.VarChar(64), String(id))
      .input('name', sql.NVarChar(128), String(name || 'Tab'))
      .input('cfg', sql.NVarChar(sql.MAX), JSON.stringify(config))
      .input('pos', sql.Int, Number(position) || 0)
      .query(`MERGE dbo.SavedTabs AS t USING (SELECT @u AS U, @id AS I) src ON t.UserKey=src.U AND t.TabId=src.I
        WHEN MATCHED THEN UPDATE SET Name=@name, Config=@cfg, Position=@pos, UpdatedAt=SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT (UserKey,TabId,Name,Config,Position) VALUES (@u,@id,@name,@cfg,@pos);`);
    return true;
  } catch { return false; }
}

export async function deleteTab(userKey, tabId) {
  if (!isEnabled()) return false;
  try {
    await ensureTabsSchema();
    const pool = await getPool();
    await pool.request()
      .input('u', sql.VarChar(256), String(userKey))
      .input('id', sql.VarChar(64), String(tabId))
      .query('DELETE FROM dbo.SavedTabs WHERE UserKey=@u AND TabId=@id');
    return true;
  } catch { return false; }
}
