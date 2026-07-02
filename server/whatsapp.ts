/**
 * NarrowTech GS — WhatsApp Notifications via Meta WhatsApp Cloud API
 * Free tier: 1,000 messages/month. Works reliably internationally incl. Ghana (+233).
 * No Twilio needed. Uses fetch — no extra npm packages required.
 *
 * Required env vars:
 *   META_WA_TOKEN        — permanent system user token from Meta Developer Console
 *   META_WA_PHONE_ID     — Phone Number ID from WhatsApp > API Setup
 *   WHATSAPP_NOTIFY_TO   — recipient number in international format e.g. 2330240802791
 */

import type { Field, Alert } from "@shared/schema";

// Read dynamically each call so env changes take effect without restart
function getToken()    { return process.env.META_WA_TOKEN    || ""; }
function getPhoneId()  { return process.env.META_WA_PHONE_ID || ""; }
function getNotifyTo() { return (process.env.WHATSAPP_NOTIFY_TO || "972552875338").replace(/^\+/, ""); }

// ── Label helpers ─────────────────────────────────────────────────────────────
function ndviLabel(v: number | null): string {
  if (v === null) return "Unknown";
  if (v >= 0.6)  return "Excellent ✅";
  if (v >= 0.4)  return "Good ✅";
  if (v >= 0.25) return "Moderate ⚠️";
  if (v >= 0.1)  return "Poor ⚠️";
  return "Critical 🔴";
}

function msiLabel(v: number | null): string {
  if (v === null) return "Unknown";
  if (v < 0.1)  return "Open water 💧";
  if (v < 0.4)  return "High moisture 💧";
  if (v < 0.6)  return "Adequate ✅";
  if (v < 1.0)  return "Mild stress ⚠️";
  if (v < 1.2)  return "Moderate drought ⚠️";
  return "SEVERE DROUGHT 🔴";
}

function eviLabel(v: number | null | undefined): string {
  if (v === null || v === undefined) return "Unknown";
  if (v >= 0.5)  return "Excellent ✅";
  if (v >= 0.35) return "Good ✅";
  if (v >= 0.2)  return "Moderate ⚠️";
  if (v >= 0.1)  return "Poor ⚠️";
  return "Critical 🔴";
}

function recommendation(field: Field): string {
  const msi  = field.ndwi ?? 0;
  const ndvi = field.ndvi ?? 0;
  if (msi > 1.2)   return "🚨 URGENT: Irrigate immediately — severe drought stress detected.";
  if (msi > 1.0)   return "⚠️ Schedule irrigation within 3–5 days.";
  if (ndvi < 0.2)  return "🔴 Very low vegetation. Inspect field for crop failure or damage.";
  if (ndvi < 0.35) return "⚠️ Low crop health. Check for pests or nutrient deficiency.";
  if (ndvi >= 0.6 && msi < 0.6) return "✅ Crop is healthy. Maintain current practices.";
  return "✅ Good health. Continue routine monitoring every 2 weeks.";
}

// ── Build plain-text message ──────────────────────────────────────────────────
export function buildWhatsAppMessage(field: Field, alerts: Alert[]): string {
  const lines: string[] = [];

  lines.push("🌾 *NarrowTech GS — Crop Health Update*");
  lines.push(`📍 Field: *${field.name}*`);
  if (field.region)   lines.push(`Region: ${field.region.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())}`);
  if (field.cropType) lines.push(`Crop: ${field.cropType.charAt(0).toUpperCase() + field.cropType.slice(1)}`);
  lines.push("");

  lines.push("📊 *Satellite Results (Sentinel-2)*");
  lines.push(`• NDVI: ${field.ndvi !== null ? (field.ndvi ?? 0).toFixed(3) : "—"}  →  ${ndviLabel(field.ndvi ?? null)}`);
  lines.push(`• MSI:  ${field.ndwi !== null ? (field.ndwi ?? 0).toFixed(3) : "—"}  →  ${msiLabel(field.ndwi ?? null)}`);
  lines.push(`• EVI:  ${field.evi !== null && field.evi !== undefined ? field.evi.toFixed(3) : "—"}  →  ${eviLabel(field.evi ?? null)}`);
  lines.push(`• Health Score: ${field.healthScore ?? "—"}/100`);
  lines.push("");

  lines.push("💡 *Recommendation*");
  lines.push(recommendation(field));
  lines.push("");

  // Active alerts (max 3)
  const activeAlerts = alerts.filter(a => !a.acknowledged).slice(0, 3);
  if (activeAlerts.length > 0) {
    lines.push("🔔 *Active Alerts*");
    activeAlerts.forEach(a => {
      const icon = a.severity === "critical" ? "🔴" : a.severity === "warning" ? "🟡" : "🔵";
      lines.push(`${icon} ${a.message}`);
    });
    lines.push("");
  }

  if (field.dateFrom && field.dateTo) {
    lines.push(`📅 Period: ${field.dateFrom} → ${field.dateTo}`);
  }
  if (field.analyzedAt) {
    lines.push(`🛰️ Analyzed: ${new Date(field.analyzedAt).toLocaleDateString("en-GB")}`);
  }

  lines.push("");
  lines.push("—");
  lines.push("_NarrowTech GeoSolution_");
  lines.push("_narrowtechgeosolution.com_");

  return lines.join("\n");
}

// ── Send via Meta WhatsApp Cloud API ─────────────────────────────────────────
export async function sendWhatsAppNotification(
  field: Field,
  alerts: Alert[]
): Promise<{ success: boolean; messageSid?: string; error?: string; simulated?: boolean }> {
  const META_WA_TOKEN    = getToken();
  const META_WA_PHONE_ID = getPhoneId();
  const NOTIFY_TO        = getNotifyTo();

  const messageBody = buildWhatsAppMessage(field, alerts);

  // No credentials → simulate (log to console, show preview in UI)
  if (!META_WA_TOKEN || !META_WA_PHONE_ID) {
    console.log("[WhatsApp] META credentials not set — simulating send.");
    console.log("[WhatsApp] Would send to:", NOTIFY_TO);
    console.log("[WhatsApp] Message:\n", messageBody);
    return { success: true, simulated: true, messageSid: "preview-" + Date.now() };
  }

  try {
    const url = `https://graph.facebook.com/v19.0/${META_WA_PHONE_ID}/messages`;

    const payload = {
      messaging_product: "whatsapp",
      to: NOTIFY_TO,
      type: "text",
      text: { body: messageBody },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${META_WA_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json() as any;

    if (!res.ok) {
      const errMsg = data?.error?.message ?? JSON.stringify(data);
      console.error("[WhatsApp] Meta API error:", errMsg);
      return { success: false, error: errMsg };
    }

    const msgId = data?.messages?.[0]?.id ?? "unknown";
    console.log(`[WhatsApp] Sent to ${NOTIFY_TO} — ID: ${msgId}`);
    return { success: true, messageSid: msgId };
  } catch (err: any) {
    const errMsg = err?.message ?? String(err);
    console.error("[WhatsApp] Fetch failed:", errMsg);
    return { success: false, error: errMsg };
  }
}
