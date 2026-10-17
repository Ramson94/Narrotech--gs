// ─── One simple answer per field: a traffic light and one sentence of action ──
// Used by the dashboard, the PDF report and the WhatsApp message so they always agree.
// The underlying numbers (NDVI, MSI, health score) stay available in the tables for technical use.

export type StatusLevel = "green" | "yellow" | "red" | "none";

export type FieldStatus = {
  level: StatusLevel;
  label: string;   // short name of the state
  emoji: string;   // for WhatsApp
  action: string;  // one plain sentence: what to do
};

export function fieldStatus(f: { ndvi?: number | null; ndwi?: number | null; healthScore?: number | null }): FieldStatus {
  const ndvi = f.ndvi ?? null, msi = f.ndwi ?? null, score = f.healthScore ?? null;
  if (score === null || ndvi === null) {
    return { level: "none", label: "Not checked yet", emoji: "⚪", action: "Run an analysis to check this field." };
  }

  // Red: act now
  if (msi !== null && msi > 1.2) return red("The field is very dry. Irrigate as soon as possible.");
  if (ndvi < 0.2) return red("Very little healthy crop is visible. Visit the field to check for crop failure or damage.");
  if (score < 45) return red("Crop health is poor. Visit the field this week to find the cause.");

  // Yellow: watch closely
  if (msi !== null && msi > 1.0) return yellow("The field is getting dry. Plan irrigation within 3–5 days.");
  if (ndvi < 0.35) return yellow("Crops are weaker than expected. Check for pests or a lack of fertiliser.");
  if (score < 70) return yellow("Some stress is showing. Keep watching and check the field soon.");

  return { level: "green", label: "Healthy", emoji: "🟢", action: "Crop is healthy. Keep your current practices." };
}

const red = (action: string): FieldStatus => ({ level: "red", label: "Act now", emoji: "🔴", action });
const yellow = (action: string): FieldStatus => ({ level: "yellow", label: "Watch", emoji: "🟡", action });

export const STATUS_COLORS: Record<StatusLevel, string> = {
  green: "#16a34a",
  yellow: "#d97706",
  red: "#dc2626",
  none: "#94a3b8",
};
