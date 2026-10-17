// ─── "Go here": problem spots inside a field ─────────────────────────────────
// A problem spot is a patch of the field that is clearly weaker (low NDVI) and/or drier (high MSI)
// than the rest of the same field on the same satellite image. Each spot comes with a plain reason,
// what to check when you get there, its size, and links to walk there or share it.

export type SpotKind = "weak" | "dry" | "weak_dry";

export type ProblemSpot = {
  label: string;                      // "A", "B", ...
  lat: number;
  lng: number;
  kind: SpotKind;
  severity: "critical" | "warning";   // critical = much worse than the rest of the field
  reason: string;                     // plain sentence
  check: string;                      // what to check on arrival (follows "Check: ")
  areaHa: number;                     // approximate size of the patch
  ndvi?: number; fieldNdvi?: number;  // technical values (spot vs whole field)
  msi?: number; fieldMsi?: number;
};

export type SpotsResult = { date: string | null; spots: ProblemSpot[]; message?: string };

export const SPOT_TEXT: Record<SpotKind, { reason: string; check: string }> = {
  weak: {
    reason: "Crops here are weaker than in the rest of the field.",
    check: "pests, disease, yellow leaves or missing plants.",
  },
  dry: {
    reason: "This part is drier than the rest of the field.",
    check: "how wet the soil is, and whether water reaches this spot.",
  },
  weak_dry: {
    reason: "Crops here are weaker and drier than in the rest of the field.",
    check: "water first, then pests or disease.",
  },
};

export const walkingDirectionsUrl = (lat: number, lng: number) =>
  `https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lng.toFixed(6)}&travelmode=walking`;

export const mapPinUrl = (lat: number, lng: number) =>
  `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lng.toFixed(6)}`;

// Ready-to-send text for sharing one spot with someone who will go and check it.
export function spotShareText(fieldName: string, spot: ProblemSpot): string {
  return [
    `NarrowTech GS — please check spot ${spot.label} on ${fieldName}`,
    spot.reason,
    `Check: ${spot.check}`,
    `Size: about ${formatArea(spot.areaHa)}`,
    `Location: ${mapPinUrl(spot.lat, spot.lng)}`,
  ].join("\n");
}

export function formatArea(ha: number): string {
  if (ha >= 1) return `${ha.toFixed(1)} ha`;
  return `${Math.max(100, Math.round((ha * 10000) / 100) * 100).toLocaleString("en")} m²`;
}
