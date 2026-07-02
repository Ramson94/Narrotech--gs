import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { fields, alerts, appSettings, users, type Field, type InsertField, type Alert, type InsertAlert, type User } from "@shared/schema";
import { eq } from "drizzle-orm";

// Use /data/data.db on Render (persistent disk), fallback to local for dev
const DB_PATH = process.env.NODE_ENV === "production" && require("fs").existsSync("/data")
  ? "/data/data.db"
  : "data.db";
const sqlite = new Database(DB_PATH);
export const db = drizzle(sqlite);

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS fields (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    region TEXT NOT NULL DEFAULT '',
    crop_type TEXT NOT NULL DEFAULT '',
    coordinates TEXT NOT NULL,
    ndvi REAL,
    ndwi REAL,
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
try { sqlite.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'farmer', created_at TEXT NOT NULL)`); } catch (_) {}

// Migration guards: add new columns to existing databases (SQLite doesn't support IF NOT EXISTS on ALTER TABLE)
const migrateColumns = [
  "ALTER TABLE fields ADD COLUMN time_series_data TEXT",
  "ALTER TABLE fields ADD COLUMN date_from TEXT",
  "ALTER TABLE fields ADD COLUMN date_to TEXT",
  "ALTER TABLE fields ADD COLUMN cloud_cover_max INTEGER DEFAULT 20",
  "ALTER TABLE fields ADD COLUMN last_notified_at TEXT",
  "ALTER TABLE fields ADD COLUMN notifications_enabled INTEGER DEFAULT 1",
];
for (const stmt of migrateColumns) {
  try { sqlite.exec(stmt); } catch (_) { /* column already exists — safe to ignore */ }
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
  createField(data: InsertField) { return db.insert(fields).values(data).returning().get(); }
  updateField(id: number, data: Partial<InsertField>) {
    return db.update(fields).set(data).where(eq(fields.id, id)).returning().get();
  }
  deleteField(id: number) { db.delete(fields).where(eq(fields.id, id)).run(); }
  getAlerts() { return db.select().from(alerts).all(); }
  getAlertsByField(fieldId: number) { return db.select().from(alerts).where(eq(alerts.fieldId, fieldId)).all(); }
  createAlert(data: InsertAlert) { return db.insert(alerts).values(data).returning().get(); }
  acknowledgeAlert(id: number) { db.update(alerts).set({ acknowledged: 1 }).where(eq(alerts.id, id)).run(); }
  deleteAlertsByField(fieldId: number) { db.delete(alerts).where(eq(alerts.fieldId, fieldId)).run(); }
  getSetting(key: string) { return db.select().from(appSettings).where(eq(appSettings.key, key)).get()?.value; }
  setSetting(key: string, value: string) {
    const existing = db.select().from(appSettings).where(eq(appSettings.key, key)).get();
    if (existing) {
      db.update(appSettings).set({ value }).where(eq(appSettings.key, key)).run();
    } else {
      db.insert(appSettings).values({ key, value }).run();
    }
  }
  // Users
  getUserById(id: number) { return db.select().from(users).where(eq(users.id, id)).get(); }
  getUserByEmail(email: string) { return db.select().from(users).where(eq(users.email, email.toLowerCase())).get(); }
  createUser(data: { name: string; email: string; passwordHash: string; role?: string }) {
    return db.insert(users).values({
      name: data.name,
      email: data.email.toLowerCase(),
      passwordHash: data.passwordHash,
      role: data.role || "farmer",
      createdAt: new Date().toISOString(),
    }).returning().get();
  }
  countUsers() { return (db.select().from(users).all()).length; }
}

export const storage = new Storage();
