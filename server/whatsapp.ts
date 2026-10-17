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
import { fieldStatus } from "@shared/status";
import { formatArea, walkingDirectionsUrl, type ProblemSpot } from "@shared/spots";

// Read dynamically each call so env changes take effect without restart
function getToken()    { return process.env.META_WA_TOKEN    || ""; }
function getPhoneId()  { return process.env.META_WA_PHONE_ID || ""; }
function getNotifyTo() { return (process.env.WHATSAPP_NOTIFY_TO || "972552875338").replace(/^\+/, ""); }

// ── Label helpers ─────────────────────────────────────────────────────────────
function ndviLabel(v: number | null): string {
  if (v === null) return "unknown";
  if (v >= 0.6)  return "excellent";
  if (v >= 0.4)  return "good";
  if (v >= 0.25) return "moderate";
  if (v >= 0.1)  return "poor";
  return "critical";
}

function msiLabel(v: number | null): string {
  if (v === null) return "unknown";
  if (v < 0.1)  return "open water";
  if (v < 0.4)  return "very moist";
  if (v < 0.6)  return "adequate";
  if (v < 1.0)  return "mild stress";
  if (v < 1.2)  return "moderate drought";
  return "severe drought";
}


// ── Build plain-text message ──────────────────────────────────────────────────
// Order: traffic light + what to do → places to go → technical numbers.
export function buildWhatsAppMessage(field: Field, alerts: Alert[], spots: ProblemSpot[] = []): string {
  const lines: string[] = [];
  const status = fieldStatus(field);

  lines.push("🌾 *NarrowTech GS — Crop Health Update*");
  lines.push(`📍 Field: *${field.name}*`);
  if (field.cropType) lines.push(`Crop: ${field.cropType.charAt(0).toUpperCase() + field.cropType.slice(1)}`);
  lines.push("");

  lines.push(`${status.emoji} *${status.label.toUpperCase()}*`);
  lines.push(status.action);
  lines.push("");

  if (spots.length > 0) {
    lines.push(`🚶 *Go here — ${spots.length} place${spots.length > 1 ? "s" : ""} to check*`);
    for (const sp of spots) {
      lines.push(`*${sp.label}.* ${sp.reason} (about ${formatArea(sp.areaHa)})`);
      lines.push(`   Check: ${sp.check}`);
      lines.push(`   ${walkingDirectionsUrl(sp.lat, sp.lng)}`);
    }
    lines.push("");
  }

  lines.push("📊 _Technical (Sentinel-2)_");
  lines.push(`NDVI ${field.ndvi != null ? field.ndvi.toFixed(3) : "—"} (${ndviLabel(field.ndvi ?? null)}) · MSI ${field.ndwi != null ? field.ndwi.toFixed(3) : "—"} (${msiLabel(field.ndwi ?? null)}) · Score ${field.healthScore ?? "—"}/100`);
  if (field.analyzedAt) lines.push(`Analysed ${new Date(field.analyzedAt).toLocaleDateString("en-GB")}`);

  lines.push("");
  lines.push("_NarrowTech GeoSolution · narrowtechgeosolution.org_");
  return lines.join("\n");
}

// ── Send via Meta WhatsApp Cloud API ─────────────────────────────────────────
export async function sendWhatsAppNotification(
  field: Field,
  alerts: Alert[],
  spots: ProblemSpot[] = []
): Promise<{ success: boolean; messageSid?: string; error?: string; simulated?: boolean }> {
  const META_WA_TOKEN    = getToken();
  const META_WA_PHONE_ID = getPhoneId();
  const NOTIFY_TO        = getNotifyTo();

  const messageBody = buildWhatsAppMessage(field, alerts, spots);

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
