import { drizzle, type SQLJsDatabase } from "drizzle-orm/sql-js";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import fs from "node:fs";
import { fields, alerts, appSettings, users, type Field, type InsertField, type Alert, type InsertAlert, type User } from "@shared/schema";
import { eq } from "drizzle-orm";

// ─── Database driver: sql.js (pure-WASM SQLite) ─────────────────────────────
// Replaces the native `better-sqlite3` addon so there is NO node-gyp / native
// compilation step at install time. That native build was the suspected cause
// of the production sandbox never binding to its port (npm ci / module load
// crash before `httpServer.listen`). sql.js runs the same SQLite engine in
// WebAssembly and needs zero build tools in the container.
//
// sql.js is in-memory, so we load the on-disk `data.db` into memory at startup
// and flush the full database image back to disk after every write (see
// `persist()`). The file stays named `data.db` for the hosting platform's
// data-persistence convention.

// Use /data/data.db on Render (persistent disk), fallback to local for dev.
// Defensive: never let a missing/unwritable /data mount crash the process
// (this runs before the HTTP server binds to its port).
function resolveDbPath(): string {
  try {
    if (process.env.NODE_ENV === "production" && fs.existsSync("/data")) {
      // Confirm /data is actually usable (writable directory), not just present.
      fs.accessSync("/data", fs.constants.W_OK);
      return "/data/data.db";
    }
  } catch (err) {
    console.warn("[storage] /data exists but is not usable, falling back to local data.db:", err);
  }
  return "data.db";
}

let sqlite: SqlJsDatabase;
let dbFilePath = "data.db";

// `db` is assigned during initStorage(). Route handlers only run after the HTTP
// server starts, which is after initStorage() completes, so it is always set
// by the time any query executes.
export let db: SQLJsDatabase;

// Flush the in-memory database image to disk atomically (write to a temp file
// then rename) so a crash mid-write can't corrupt data.db.
function persist(): void {
  if (!sqlite) return;
  try {
    const data = Buffer.from(sqlite.export());
    const tmp = `${dbFilePath}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, dbFilePath);
  } catch (err) {
    console.error("[storage] Failed to persist database to disk:", err);
  }
}

function loadFileBuffer(path: string): Uint8Array | undefined {
  try {
    if (fs.existsSync(path)) return new Uint8Array(fs.readFileSync(path));
  } catch (err) {
    console.warn(`[storage] Could not read existing database at ${path}, starting fresh:`, err);
  }
  return undefined;
}

// Must be awaited before the HTTP server starts serving requests.
export async function initStorage(): Promise<void> {
  const SQL = await initSqlJs();

  dbFilePath = resolveDbPath();
  try {
    sqlite = new SQL.Database(loadFileBuffer(dbFilePath));
  } catch (err) {
    console.error(`[storage] Failed to open database at ${dbFilePath}, falling back to local data.db:`, err);
    dbFilePath = "data.db";
    sqlite = new SQL.Database(loadFileBuffer(dbFilePath));
  }
  db = drizzle(sqlite);

  sqlite.run(`
    CREATE TABLE IF NOT EXISTS fields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      region TEXT NOT NULL DEFAULT '',
      crop_type TEXT NOT NULL DEFAULT '',
      coordinates TEXT NOT NULL,
      geometry TEXT,
      ndvi REAL,
      ndwi REAL,
      evi REAL,
      health_score INTEGER,
      status TEXT DEFAULT 'pending',
      time_series_data TEXT,
      date_from TEXT,
      date_to TEXT,
      cloud_cover_max INTEGER DEFAULT 20,
      analyzed_at TEXT,
      notes TEXT DEFAULT '',
      last_notified_at TEXT,
      notifications_enabled INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      field_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      severity TEXT NOT NULL,
      created_at TEXT NOT NULL,
      acknowledged INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'farmer',
      created_at TEXT NOT NULL
    );
  `);

  // Migration guards — also add users table to old DBs
  try { sqlite.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'farmer', created_at TEXT NOT NULL)`); } catch (_) {}

  // Migration guards: add new columns to existing databases (SQLite doesn't support IF NOT EXISTS on ALTER TABLE)
  const migrateColumns = [
    "ALTER TABLE fields ADD COLUMN time_series_data TEXT",
    "ALTER TABLE fields ADD COLUMN date_from TEXT",
    "ALTER TABLE fields ADD COLUMN date_to TEXT",
    "ALTER TABLE fields ADD COLUMN cloud_cover_max INTEGER DEFAULT 20",
    "ALTER TABLE fields ADD COLUMN last_notified_at TEXT",
    "ALTER TABLE fields ADD COLUMN notifications_enabled INTEGER DEFAULT 1",
    "ALTER TABLE fields ADD COLUMN evi REAL",
    "ALTER TABLE fields ADD COLUMN geometry TEXT",
  ];
  for (const stmt of migrateColumns) {
    try { sqlite.run(stmt); } catch (_) { /* column already exists — safe to ignore */ }
  }

  // One-time migration: ensure the app owner's account has admin rights. Public registration
  // is now disabled, so this guarantees the owner can still log in with full access even if
  // their account was originally created as a non-admin ("farmer") role.
  try {
    sqlite.run(`UPDATE users SET role = 'admin' WHERE email = 'kabenlaramson@gmail.com' AND role != 'admin'`);
  } catch (_) { /* users table may not exist yet on first boot — safe to ignore */ }

  // One-time seed migration: on a fresh/reset database (e.g. Render free-tier disk wipe on
  // restart), guarantee the owner's account exists with admin rights, and remove the specific
  // stray test account created while diagnosing this deploy. Idempotent — a no-op once the
  // owner account already exists correctly. Safe to leave in place long-term.
  try {
    const ownerEmail = "kabenlaramson@gmail.com";
    const ownerRow = db.select({ id: users.id }).from(users).where(eq(users.email, ownerEmail)).get();
    if (!ownerRow) {
      sqlite.run(
        `INSERT INTO users (name, email, password_hash, role, created_at)
         VALUES ('Ramson Kabenla', ?, '$2b$10$DIeFizIFsEA5x03UoSorJ.kYSDPe/xI9sdVCV81q3w3JqaxqVbLSu', 'admin', datetime('now'))`,
        [ownerEmail],
      );
    }
    // Remove the throwaway test account created while diagnosing the empty-DB-after-deploy issue.
    sqlite.run(`DELETE FROM users WHERE email = 'randomtest@example.com'`);
  } catch (err) {
    console.warn("[storage] owner seed migration skipped/failed (non-fatal):", err);
  }

  // Persist schema/migration/seed results and register flush-on-exit hooks so
  // in-memory writes always reach disk.
  persist();
  const flush = () => persist();
  process.on("exit", flush);
  process.on("SIGINT", () => { flush(); process.exit(0); });
  process.on("SIGTERM", () => { flush(); process.exit(0); });
}

export interface IStorage {
  getFields(): Field[];
  getField(id: number): Field | undefined;
  createField(data: InsertField): Field;
  updateField(id: number, data: Partial<InsertField>): Field | undefined;
  deleteField(id: number): void;
  getAlerts(): Alert[];
  getAlertsByField(fieldId: number): Alert[];
  createAlert(data: InsertAlert): Alert;
  acknowledgeAlert(id: number): void;
  deleteAlertsByField(fieldId: number): void;
  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;
  // Users
  getUserById(id: number): User | undefined;
  getUserByEmail(email: string): User | undefined;
  createUser(data: { name: string; email: string; passwordHash: string; role?: string }): User;
  countUsers(): number;
}

export class Storage implements IStorage {
  getFields() { return db.select().from(fields).all(); }
  getField(id: number) { return db.select().from(fields).where(eq(fields.id, id)).get(); }
  createField(data: InsertField) { const r = db.insert(fields).values(data).returning().get(); persist(); return r; }
  updateField(id: number, data: Partial<InsertField>) {
    const r = db.update(fields).set(data).where(eq(fields.id, id)).returning().get();
    persist();
    return r;
  }
  deleteField(id: number) { db.delete(fields).where(eq(fields.id, id)).run(); persist(); }
  getAlerts() { return db.select().from(alerts).all(); }
  getAlertsByField(fieldId: number) { return db.select().from(alerts).where(eq(alerts.fieldId, fieldId)).all(); }
  createAlert(data: InsertAlert) { const r = db.insert(alerts).values(data).returning().get(); persist(); return r; }
  acknowledgeAlert(id: number) { db.update(alerts).set({ acknowledged: 1 }).where(eq(alerts.id, id)).run(); persist(); }
  deleteAlertsByField(fieldId: number) { db.delete(alerts).where(eq(alerts.fieldId, fieldId)).run(); persist(); }
  getSetting(key: string) { return db.select().from(appSettings).where(eq(appSettings.key, key)).get()?.value; }
  setSetting(key: string, value: string) {
    const existing = db.select().from(appSettings).where(eq(appSettings.key, key)).get();
    if (existing) {
      db.update(appSettings).set({ value }).where(eq(appSettings.key, key)).run();
    } else {
      db.insert(appSettings).values({ key, value }).run();
    }
    persist();
  }
  // Users
  getUserById(id: number) { return db.select().from(users).where(eq(users.id, id)).get(); }
  getUserByEmail(email: string) { return db.select().from(users).where(eq(users.email, email.toLowerCase())).get(); }
  createUser(data: { name: string; email: string; passwordHash: string; role?: string }) {
    const r = db.insert(users).values({
      name: data.name,
      email: data.email.toLowerCase(),
      passwordHash: data.passwordHash,
      role: data.role || "farmer",
      createdAt: new Date().toISOString(),
    }).returning().get();
    persist();
    return r;
  }
  countUsers() { return (db.select().from(users).all()).length; }
}

export const storage = new Storage();
