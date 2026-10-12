import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const fields = sqliteTable("fields", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  region: text("region").notNull().default(""),
  cropType: text("crop_type").notNull().default(""),
  // Coordinates stored as JSON string: [{lat, lng}, ...]
  coordinates: text("coordinates").notNull(),
  // Full field shape as a GeoJSON MultiPolygon (all plots, holes cut out) — see shared/geometry.ts.
  // This is the ONLY area used for analysis. `coordinates` keeps the first plot's outline for display.
  geometry: text("geometry"),
  ndvi: real("ndvi"),
  ndwi: real("ndwi"),
  healthScore: integer("health_score"),
  status: text("status").default("pending"), // pending, analyzed, alert
  // JSON array of FieldTimeSeriesPoint (see type below)
  timeSeriesData: text("time_series_data"),
  // Date range used for last analysis
  dateFrom: text("date_from"),
  dateTo: text("date_to"),
  cloudCoverMax: integer("cloud_cover_max").default(20), // fixed at 20 (% cloud over the field)
  analyzedAt: text("analyzed_at"),
  notes: text("notes").default(""),
  // Notification tracking
  lastNotifiedAt: text("last_notified_at"),
  notificationsEnabled: integer("notifications_enabled").default(1),
});

export const insertFieldSchema = createInsertSchema(fields).omit({ id: true });
export type InsertField = z.infer<typeof insertFieldSchema>;
export type Field = typeof fields.$inferSelect;

// One entry per 14-day window in a field's `timeSeriesData` JSON array.
// `date` is the acquisition date of the image used (or the window's middle for a gap).
// `ndwi` holds the Moisture Stress Index (MSI); `soilMoisture` is the OPTRAM wetness index W
// (relative soil moisture, ~0 dry .. 1 wet) or null when unavailable for a date.
// `cloudCover` is the % of the FIELD (not the satellite tile) covered by cloud, cirrus, cloud
// shadow or missing data; only images with cloudCover <= 20 are used. Gaps have excluded = true.
export type FieldTimeSeriesPoint = {
  date: string;
  ndvi: number | null;
  ndwi: number | null;
  soilMoisture: number | null;
  cloudCover: number | null;
  isWater: boolean;
  dataSource: string;
  excluded?: boolean;
  windowFrom?: string;
  windowTo?: string;
};

export const alerts = sqliteTable("alerts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fieldId: integer("field_id").notNull(),
  type: text("type").notNull(),
  message: text("message").notNull(),
  severity: text("severity").notNull(), // info, warning, critical
  createdAt: text("created_at").notNull(),
  acknowledged: integer("acknowledged").default(0),
});

export const insertAlertSchema = createInsertSchema(alerts).omit({ id: true });
export type InsertAlert = z.infer<typeof insertAlertSchema>;
export type Alert = typeof alerts.$inferSelect;

export const appSettings = sqliteTable("app_settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
});

// ─── Users ────────────────────────────────────────────────────────────────
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("farmer"), // farmer | admin
  createdAt: text("created_at").notNull(),
});

export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true, passwordHash: true }).extend({
  password: z.string().min(6, "Password must be at least 6 characters"),
});
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
