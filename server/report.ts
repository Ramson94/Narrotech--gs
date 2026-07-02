/**
 * NarrowTech GS — PDF Report Generator
 * Builds a clean A4 crop health report using PDFKit.
 * SENSITIVE DATA OMITTED: no API credentials, no user emails/passwords,
 * no session tokens, no internal server paths.
 */
import PDFDocument from "pdfkit";
import type { Field, Alert } from "@shared/schema";

// ── Colour palette ──────────────────────────────────────────────────────────
const C = {
  primary:    "#1E6FA3",
  dark:       "#0f172a",
  mid:        "#334155",
  muted:      "#64748b",
  light:      "#f1f5f9",
  border:     "#e2e8f0",
  green:      "#16a34a",
  yellow:     "#ca8a04",
  orange:     "#ea580c",
  red:        "#dc2626",
  blue:       "#2563eb",
  purple:     "#9333ea",
  white:      "#ffffff",
};

// ── Helpers ─────────────────────────────────────────────────────────────────
function ndviLabel(v: number | null): { text: string; color: string } {
  if (v === null) return { text: "Not analyzed", color: C.muted };
  if (v >= 0.6) return { text: "Excellent", color: C.green };
  if (v >= 0.4) return { text: "Good", color: C.green };
  if (v >= 0.25) return { text: "Moderate", color: C.yellow };
  if (v >= 0.1) return { text: "Poor", color: C.orange };
  return { text: "Critical", color: C.red };
}

function msiLabel(v: number | null): { text: string; color: string } {
  if (v === null) return { text: "Not analyzed", color: C.muted };
  if (v < 0.1) return { text: "Open water", color: C.blue };
  if (v < 0.4) return { text: "High moisture", color: C.green };
  if (v < 0.6) return { text: "Adequate moisture", color: C.green };
  if (v < 1.0) return { text: "Mild water stress", color: C.yellow };
  if (v < 1.2) return { text: "Moderate drought", color: C.orange };
  return { text: "Severe drought", color: C.red };
}

function eviLabel(v: number | null | undefined): { text: string; color: string } {
  if (v === null || v === undefined) return { text: "Not analyzed", color: C.muted };
  if (v >= 0.5) return { text: "Excellent", color: C.green };
  if (v >= 0.35) return { text: "Good", color: C.green };
  if (v >= 0.2) return { text: "Moderate", color: C.yellow };
  if (v >= 0.1) return { text: "Poor", color: C.orange };
  return { text: "Critical", color: C.red };
}

function healthColor(score: number | null): string {
  if (score === null) return C.muted;
  if (score >= 70) return C.green;
  if (score >= 45) return C.yellow;
  return C.red;
}

function recommendation(field: Field): string {
  const ndvi = field.ndvi ?? 0;
  const msi  = field.ndwi ?? 0;
  if (msi > 1.2)  return "⚠ URGENT: Severe drought stress detected. Irrigate immediately if possible. Consider emergency water application.";
  if (msi > 1.0)  return "Moderate drought stress. Schedule irrigation within 3–5 days. Monitor daily.";
  if (ndvi < 0.2) return "Very low vegetation density. Inspect field for crop failure, pest damage, or soil issues.";
  if (ndvi < 0.35) return "Low vegetation health. Consider fertiliser application and check for disease or pest pressure.";
  if (ndvi >= 0.6 && msi < 0.6) return "Optimal crop health. Maintain current management practices.";
  if (ndvi >= 0.4)return "Good crop health. Continue routine monitoring every 2 weeks.";
  return "Moderate crop health. Monitor closely and ensure adequate soil moisture.";
}

// ── Bar drawing helper ───────────────────────────────────────────────────────
function drawBar(
  doc: typeof PDFDocument.prototype,
  x: number, y: number, w: number, h: number,
  value: number, maxVal: number,
  fillColor: string
) {
  const fraction = Math.min(1, Math.max(0, value / maxVal));
  // background
  doc.rect(x, y, w, h).fillColor(C.border).fill();
  // fill
  doc.rect(x, y, w * fraction, h).fillColor(fillColor).fill();
  // outline
  doc.rect(x, y, w, h).strokeColor(C.border).lineWidth(0.5).stroke();
}

// ── Mini sparkline (time series) ─────────────────────────────────────────────
function drawSparkline(
  doc: typeof PDFDocument.prototype,
  data: { date: string; ndvi: number | null; ndwi: number | null; evi?: number | null }[],
  x: number, y: number, w: number, h: number
) {
  const valid = data.filter(d => d.ndvi !== null && !isNaN(d.ndvi as number));
  if (valid.length < 2) {
    doc.fontSize(8).fillColor(C.muted).text("Not enough data for chart", x, y + h / 2 - 5);
    return;
  }

  // grid background
  doc.rect(x, y, w, h).fillColor(C.light).fill();
  doc.rect(x, y, w, h).strokeColor(C.border).lineWidth(0.5).stroke();

  const pad = 4;
  const cx = x + pad, cy = y + pad;
  const cw = w - pad * 2, ch = h - pad * 2;

  // Reference lines
  const refLines = [
    { val: 0.35, color: C.orange, label: "0.35" },
    { val: 0.6,  color: C.green,  label: "0.60" },
  ];
  refLines.forEach(({ val, color, label }) => {
    const ry = cy + ch - (val / 1.0) * ch;
    doc.moveTo(cx, ry).lineTo(cx + cw, ry)
      .strokeColor(color).lineWidth(0.4).dash(3, { space: 2 }).stroke();
    doc.undash();
    doc.fontSize(6).fillColor(color).text(label, cx + cw + 1, ry - 3);
  });

  // NDVI line
  const pts = valid.map((d, i) => ({
    px: cx + (i / (valid.length - 1)) * cw,
    py: cy + ch - Math.min(1, Math.max(0, (d.ndvi as number))) * ch,
  }));
  doc.moveTo(pts[0].px, pts[0].py);
  pts.slice(1).forEach(p => doc.lineTo(p.px, p.py));
  doc.strokeColor(C.green).lineWidth(1.5).stroke();

  // Dots
  pts.forEach(p => {
    doc.circle(p.px, p.py, 2).fillColor(C.green).fill();
  });

  // MSI line (blue)
  const msiPts = valid
    .map((d, i) => ({
      px: cx + (i / (valid.length - 1)) * cw,
      py: d.ndwi !== null ? cy + ch - Math.min(1, Math.max(0, (d.ndwi as number) / 2.0)) * ch : null,
    }))
    .filter(p => p.py !== null) as { px: number; py: number }[];

  if (msiPts.length >= 2) {
    doc.moveTo(msiPts[0].px, msiPts[0].py);
    msiPts.slice(1).forEach(p => doc.lineTo(p.px, p.py));
    doc.strokeColor(C.blue).lineWidth(1).stroke();
  }

  // EVI line (purple)
  const eviPts = valid
    .map((d: any, i) => ({
      px: cx + (i / (valid.length - 1)) * cw,
      py: d.evi !== null && d.evi !== undefined ? cy + ch - Math.min(1, Math.max(0, (d.evi as number))) * ch : null,
    }))
    .filter(p => p.py !== null) as { px: number; py: number }[];

  if (eviPts.length >= 2) {
    doc.moveTo(eviPts[0].px, eviPts[0].py);
    eviPts.slice(1).forEach(p => doc.lineTo(p.px, p.py));
    doc.strokeColor(C.purple).lineWidth(1).dash(2, { space: 1.5 }).stroke();
    doc.undash();
  }

  // X axis labels — first and last date
  doc.fontSize(6).fillColor(C.muted)
    .text(valid[0].date.slice(5), cx, cy + ch + 2)
    .text(valid[valid.length - 1].date.slice(5), cx + cw - 18, cy + ch + 2);
}

// ── Main PDF builder ─────────────────────────────────────────────────────────
export function generateFieldReport(
  field: Field,
  fieldAlerts: Alert[]
): Promise<Buffer> {
  const doc = new (PDFDocument as any)({ size: "A4", margin: 0, info: {
    Title: `NarrowTech GS — Crop Health Report: ${field.name}`,
    Author: "NarrowTech GeoSolution",
    Subject: "Sentinel-2 Crop Health Analysis",
    Keywords: "NDVI, MSI, Satellite, Crop Health, Ghana",
    CreationDate: new Date(),
  }});

  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));

  const PAGE_W = 595.28;
  const PAGE_H = 841.89;
  const MARGIN = 40;
  const CONTENT_W = PAGE_W - MARGIN * 2;

  // ── Header band ─────────────────────────────────────────────────────────
  doc.rect(0, 0, PAGE_W, 72).fillColor(C.primary).fill();

  // Logo text (no logo file needed — styled text mark)
  doc.fontSize(18).fillColor(C.white).font("Helvetica-Bold")
    .text("NarrowTech", MARGIN, 20, { continued: true })
    .font("Helvetica").fillColor("#a8d4f0").text(" GeoSolution");

  doc.fontSize(8.5).fillColor("#cbd5e1").font("Helvetica")
    .text("Satellite Crop Health Intelligence · narrowtechgeosolution.org", MARGIN, 42);

  // Report tag top-right
  doc.fontSize(8).fillColor("#e2e8f0")
    .text("CROP HEALTH REPORT", PAGE_W - MARGIN - 130, 24, { width: 130, align: "right" });
  doc.fontSize(7).fillColor("#94a3b8")
    .text(new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }),
      PAGE_W - MARGIN - 130, 36, { width: 130, align: "right" });

  // ── Field title row ──────────────────────────────────────────────────────
  let curY = 88;

  doc.fontSize(16).fillColor(C.dark).font("Helvetica-Bold")
    .text(field.name, MARGIN, curY);
  curY += 22;

  const meta: string[] = [];
  if (field.region) meta.push(`Region: ${field.region.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())}`);
  if (field.cropType) meta.push(`Crop: ${field.cropType.charAt(0).toUpperCase() + field.cropType.slice(1)}`);
  if (field.dateFrom && field.dateTo) meta.push(`Analysis period: ${field.dateFrom} → ${field.dateTo}`);
  if (field.analyzedAt) meta.push(`Last analyzed: ${new Date(field.analyzedAt).toLocaleDateString("en-GB")}`);

  doc.fontSize(9).fillColor(C.muted).font("Helvetica")
    .text(meta.join("  ·  "), MARGIN, curY, { width: CONTENT_W });
  curY += 18;

  // Divider
  doc.moveTo(MARGIN, curY).lineTo(PAGE_W - MARGIN, curY)
    .strokeColor(C.border).lineWidth(1).stroke();
  curY += 14;

  // ── KPI cards row ────────────────────────────────────────────────────────
  const kpiW = (CONTENT_W - 15) / 4;
  const kpiH = 70;
  const kpis = [
    {
      label: "NDVI",
      value: field.ndvi !== null ? (field.ndvi ?? 0).toFixed(3) : "—",
      sublabel: ndviLabel(field.ndvi ?? null).text,
      color: ndviLabel(field.ndvi ?? null).color,
      note: "Vegetation Index",
    },
    {
      label: "MSI",
      value: field.ndwi !== null ? (field.ndwi ?? 0).toFixed(3) : "—",
      sublabel: msiLabel(field.ndwi ?? null).text,
      color: msiLabel(field.ndwi ?? null).color,
      note: "Moisture Stress Index",
    },
    {
      label: "EVI",
      value: field.evi !== null && field.evi !== undefined ? field.evi.toFixed(3) : "—",
      sublabel: eviLabel(field.evi ?? null).text,
      color: eviLabel(field.evi ?? null).color,
      note: "Enhanced Vegetation Index",
    },
    {
      label: "Health Score",
      value: field.healthScore !== null ? `${field.healthScore}/100` : "—",
      sublabel: field.healthScore !== null
        ? field.healthScore >= 70 ? "Healthy" : field.healthScore >= 45 ? "Monitor" : "Alert"
        : "Pending",
      color: healthColor(field.healthScore ?? null),
      note: "Overall crop health",
    },
  ];

  kpis.forEach((kpi, i) => {
    const kx = MARGIN + i * (kpiW + 5);
    const ky = curY;
    doc.rect(kx, ky, kpiW, kpiH).fillColor(C.light).fill();
    doc.rect(kx, ky, 3, kpiH).fillColor(kpi.color).fill();
    doc.fontSize(8).fillColor(C.muted).font("Helvetica")
      .text(kpi.label, kx + 10, ky + 8);
    doc.fontSize(20).fillColor(kpi.color).font("Helvetica-Bold")
      .text(kpi.value, kx + 10, ky + 20);
    doc.fontSize(8.5).fillColor(kpi.color).font("Helvetica")
      .text(kpi.sublabel, kx + 10, ky + 44);
    doc.fontSize(7).fillColor(C.muted)
      .text(kpi.note, kx + 10, ky + 56);
  });

  curY += kpiH + 16;

  // ── Recommendation box ────────────────────────────────────────────────────
  const recText = recommendation(field);
  const isCritical = recText.startsWith("⚠");
  const recBg = isCritical ? "#fff7ed" : "#f0fdf4";
  const recBorder = isCritical ? C.orange : C.green;
  const recHeight = 46;

  doc.rect(MARGIN, curY, CONTENT_W, recHeight).fillColor(recBg).fill();
  doc.rect(MARGIN, curY, 3, recHeight).fillColor(recBorder).fill();
  doc.rect(MARGIN, curY, CONTENT_W, recHeight).strokeColor(recBorder).lineWidth(0.5).stroke();

  doc.fontSize(8).fillColor(C.mid).font("Helvetica-Bold")
    .text("RECOMMENDATION", MARGIN + 10, curY + 8);
  doc.font("Helvetica").fontSize(8.5).fillColor(C.dark)
    .text(recText.replace(/^⚠ URGENT: /, ""), MARGIN + 10, curY + 20, { width: CONTENT_W - 20 });
  curY += recHeight + 16;

  // ── NDVI reference bar ────────────────────────────────────────────────────
  doc.fontSize(9).fillColor(C.dark).font("Helvetica-Bold")
    .text("NDVI — Vegetation Health", MARGIN, curY);
  curY += 14;

  if (field.ndvi !== null) {
    drawBar(doc, MARGIN, curY, CONTENT_W, 12, field.ndvi, 1.0, ndviLabel(field.ndvi).color);
    doc.fontSize(7.5).fillColor(C.muted).font("Helvetica")
      .text("0", MARGIN, curY + 14)
      .text("0.35 (warn)", MARGIN + CONTENT_W * 0.35 - 16, curY + 14)
      .text("0.6 (good)", MARGIN + CONTENT_W * 0.6 - 10, curY + 14)
      .text("1.0", MARGIN + CONTENT_W - 8, curY + 14);
  } else {
    doc.fontSize(8).fillColor(C.muted).text("No data", MARGIN, curY);
  }
  curY += 30;

  // ── MSI reference bar ─────────────────────────────────────────────────────
  doc.fontSize(9).fillColor(C.dark).font("Helvetica-Bold")
    .text("MSI — Moisture Stress Index", MARGIN, curY);
  curY += 14;

  if (field.ndwi !== null) {
    drawBar(doc, MARGIN, curY, CONTENT_W, 12, field.ndwi, 1.5, msiLabel(field.ndwi).color);
    doc.fontSize(7.5).fillColor(C.muted).font("Helvetica")
      .text("0", MARGIN, curY + 14)
      .text("0.6", MARGIN + CONTENT_W * 0.4 - 6, curY + 14)
      .text("1.0 (stress)", MARGIN + CONTENT_W * 0.67 - 10, curY + 14)
      .text("1.2+ (drought)", MARGIN + CONTENT_W * 0.8 - 16, curY + 14);
  } else {
    doc.fontSize(8).fillColor(C.muted).text("No data", MARGIN, curY);
  }
  curY += 30;

  // ── EVI reference bar ──────────────────────────────────────────────────
  doc.fontSize(9).fillColor(C.dark).font("Helvetica-Bold")
    .text("EVI — Enhanced Vegetation Index", MARGIN, curY);
  curY += 14;

  if (field.evi !== null && field.evi !== undefined) {
    drawBar(doc, MARGIN, curY, CONTENT_W, 12, field.evi, 1.0, eviLabel(field.evi).color);
    doc.fontSize(7.5).fillColor(C.muted).font("Helvetica")
      .text("0", MARGIN, curY + 14)
      .text("0.2 (moderate)", MARGIN + CONTENT_W * 0.2 - 20, curY + 14)
      .text("0.35 (good)", MARGIN + CONTENT_W * 0.35 - 16, curY + 14)
      .text("0.5+ (excellent)", MARGIN + CONTENT_W * 0.5 - 10, curY + 14);
  } else {
    doc.fontSize(8).fillColor(C.muted).text("No data", MARGIN, curY);
  }
  curY += 30;

  // ── Time series chart ─────────────────────────────────────────────────────
  if (field.timeSeriesData) {
    const ts: any[] = JSON.parse(field.timeSeriesData);
    const validObs = ts.filter(d => !d.excluded && !d.isWater && d.ndvi !== null);

    doc.fontSize(9).fillColor(C.dark).font("Helvetica-Bold")
      .text("Time Series — NDVI, MSI & EVI", MARGIN, curY);
    doc.fontSize(7.5).fillColor(C.muted).font("Helvetica")
      .text(`${validObs.length} valid Sentinel-2 observations  ·  ${ts.filter(d => d.excluded).length} cloudy excluded  ·  ${ts.filter(d => d.isWater).length} water pixels removed`,
        MARGIN, curY + 12);
    curY += 26;

    const chartH = 100;
    drawSparkline(doc, validObs, MARGIN, curY, CONTENT_W - 30, chartH);

    // Legend
    const legY = curY + chartH + 6;
    doc.circle(MARGIN + 3, legY + 4, 3).fillColor(C.green).fill();
    doc.fontSize(7).fillColor(C.muted).font("Helvetica").text("NDVI (vegetation)", MARGIN + 8, legY);
    doc.circle(MARGIN + 113, legY + 4, 3).fillColor(C.blue).fill();
    doc.text("MSI (moisture stress, /2 scaled)", MARGIN + 118, legY);
    doc.circle(MARGIN + 268, legY + 4, 3).fillColor(C.purple).fill();
    doc.text("EVI (enhanced vegetation)", MARGIN + 273, legY);
    curY = legY + 18;
  }

  // ── Alerts ────────────────────────────────────────────────────────────────
  const activeAlerts = fieldAlerts.filter(a => !a.acknowledged);
  if (activeAlerts.length > 0) {
    doc.fontSize(9).fillColor(C.dark).font("Helvetica-Bold")
      .text("Active Alerts", MARGIN, curY);
    curY += 14;

    activeAlerts.forEach(alert => {
      const alertColor = alert.severity === "critical" ? C.red
        : alert.severity === "warning" ? C.orange : C.blue;
      const alertBg = alert.severity === "critical" ? "#fff1f2"
        : alert.severity === "warning" ? "#fff7ed" : "#eff6ff";

      doc.rect(MARGIN, curY, CONTENT_W, 26).fillColor(alertBg).fill();
      doc.rect(MARGIN, curY, 3, 26).fillColor(alertColor).fill();

      const tag = alert.severity.toUpperCase();
      doc.fontSize(7).fillColor(alertColor).font("Helvetica-Bold")
        .text(`[${tag}]`, MARGIN + 8, curY + 4);
      doc.font("Helvetica").fillColor(C.dark).fontSize(8)
        .text(alert.message, MARGIN + 50, curY + 4, { width: CONTENT_W - 60 });
      doc.fontSize(6.5).fillColor(C.muted)
        .text(new Date(alert.createdAt).toLocaleDateString("en-GB"), MARGIN + 8, curY + 16);

      curY += 30;
    });
    curY += 4;
  }

  // ── Observation table ─────────────────────────────────────────────────────
  if (field.timeSeriesData) {
    const ts: any[] = JSON.parse(field.timeSeriesData);
    const rows = ts.filter(d => !d.excluded && !d.isWater && d.ndvi !== null).slice(-12); // last 12

    if (rows.length > 0) {
      // Check if we need a new page
      if (curY > PAGE_H - 120) {
        doc.addPage({ size: "A4", margin: 0 });
        curY = 40;
      }

      doc.fontSize(9).fillColor(C.dark).font("Helvetica-Bold")
        .text("Observation Log (last 12 valid passes)", MARGIN, curY);
      curY += 14;

      // Table header
      const cols = [
        { label: "Date",    x: MARGIN,       w: 65 },
        { label: "NDVI",   x: MARGIN + 68,   w: 55 },
        { label: "MSI",    x: MARGIN + 126,  w: 55 },
        { label: "EVI",    x: MARGIN + 184,  w: 55 },
        { label: "Status", x: MARGIN + 242,  w: 130 },
        { label: "Source", x: MARGIN + 375,  w: 75 },
      ];

      doc.rect(MARGIN, curY, CONTENT_W, 16).fillColor(C.primary).fill();
      cols.forEach(col => {
        doc.fontSize(7.5).fillColor(C.white).font("Helvetica-Bold")
          .text(col.label, col.x + 4, curY + 4, { width: col.w });
      });
      curY += 16;

      rows.forEach((row, i) => {
        const rowBg = i % 2 === 0 ? C.white : C.light;
        doc.rect(MARGIN, curY, CONTENT_W, 14).fillColor(rowBg).fill();
        doc.fontSize(7.5).fillColor(C.dark).font("Helvetica");
        doc.text(row.date ?? "—", cols[0].x + 4, curY + 3, { width: cols[0].w });
        doc.fillColor(C.green).text((row.ndvi ?? 0).toFixed(3), cols[1].x + 4, curY + 3, { width: cols[1].w });
        doc.fillColor(C.blue).text((row.ndwi ?? 0).toFixed(3), cols[2].x + 4, curY + 3, { width: cols[2].w });
        doc.fillColor(C.purple).text(row.evi !== null && row.evi !== undefined ? row.evi.toFixed(3) : "—", cols[3].x + 4, curY + 3, { width: cols[3].w });
        doc.fillColor(C.mid).text(ndviLabel(row.ndvi).text, cols[4].x + 4, curY + 3, { width: cols[4].w });
        doc.fillColor(C.muted).text(row.dataSource ?? "Sentinel-2", cols[5].x + 4, curY + 3, { width: cols[5].w });
        curY += 14;
      });
      curY += 8;
    }
  }

  // ── Data sources & methodology ────────────────────────────────────────────
  if (curY > PAGE_H - 100) {
    doc.addPage({ size: "A4", margin: 0 });
    curY = 40;
  }

  doc.fontSize(9).fillColor(C.dark).font("Helvetica-Bold")
    .text("Data Sources & Methodology", MARGIN, curY);
  curY += 14;

  const methodology = [
    "Satellite: ESA Sentinel-2 Level-2A (10m resolution) via Copernicus Data Space",
    "NDVI = (B08 − B04) / (B08 + B04) · Range −1 to 1; healthy vegetation typically 0.4–0.8",
    "MSI = B11 / B8A (SWIR/NIR) · Increases with water stress; open water pixels (MSI < 0.1) excluded",
    "EVI = 2.5 × (B08 − B04) / (B08 + 6×B04 − 7.5×B02 + 1) · Enhanced Vegetation Index; reduces soil/atmospheric background noise vs NDVI",
    "Observation cadence: bi-weekly (best cloud-free pass within each 14-day window)",
    `Cloud filter: scenes with > ${field.cloudCoverMax ?? 20}% cloud cover excluded; fallback to least-cloudy available`,
    "Health Score: composite of NDVI, MSI, and trend direction (0–100 scale)",
  ];

  doc.fontSize(8).fillColor(C.mid).font("Helvetica");
  methodology.forEach(line => {
    doc.text(`• ${line}`, MARGIN + 6, curY, { width: CONTENT_W - 10 });
    curY += 13;
  });

  // ── Footer band ────────────────────────────────────────────────────────────
  const footerY = PAGE_H - 36;
  doc.rect(0, footerY, PAGE_W, 36).fillColor(C.dark).fill();

  doc.fontSize(7.5).fillColor("#94a3b8").font("Helvetica")
    .text(
      "NarrowTech GeoSolution  ·  narrowtechgeosolution.org  ·  Satellite data: Copernicus Sentinel-2  ·  Report generated: "
        + new Date().toLocaleString("en-GB"),
      MARGIN, footerY + 8, { width: CONTENT_W - 60 }
    );

  doc.fontSize(7).fillColor("#475569")
    .text(
      "This report is for informational purposes only. Field conditions may vary. Verify with ground observation.",
      MARGIN, footerY + 22, { width: CONTENT_W }
    );

  return new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}
