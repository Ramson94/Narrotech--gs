// ─── Field shape: the ONLY area any analysis, map or stress zone may use ─────
// A field is a set of one or more polygons (plots of the same farm), each with an outer boundary
// and optional holes (e.g. a homestead or pond cut out of the farm). Stored as a GeoJSON
// MultiPolygon in the `geometry` column. Older fields only have `coordinates` (one outer ring of
// {lat,lng}); they are read as a single polygon without holes.
//
// Shape layout (GeoJSON order, [lng, lat], rings NOT closed):
//   shape[p][0]  = outer ring of polygon p
//   shape[p][1+] = holes of polygon p

export type LatLng = { lat: number; lng: number };
export type Ring = [number, number][];
export type FieldShape = Ring[][];

const openRing = (ring: number[][]): Ring => {
  const r = ring.map(([lng, lat]) => [lng, lat] as [number, number]);
  if (r.length > 1) {
    const [a, b] = [r[0], r[r.length - 1]];
    if (a[0] === b[0] && a[1] === b[1]) r.pop();
  }
  return r;
};

export function shapeFromCoords(coords: LatLng[]): FieldShape {
  return [[coords.map(c => [c.lng, c.lat] as [number, number])]];
}

// Every Polygon / MultiPolygon in a GeoJSON object (FeatureCollection, Feature or geometry),
// merged into one field shape with holes kept.
export function shapeFromGeoJSON(gj: any): FieldShape | null {
  const shape: FieldShape = [];
  const addGeom = (g: any) => {
    if (!g) return;
    if (g.type === "Polygon") shape.push(g.coordinates.map(openRing));
    else if (g.type === "MultiPolygon") for (const poly of g.coordinates) shape.push(poly.map(openRing));
    else if (g.type === "GeometryCollection") (g.geometries || []).forEach(addGeom);
  };
  const walk = (o: any) => {
    if (!o) return;
    if (Array.isArray(o)) return o.forEach(walk);           // shpjs may return several collections
    if (o.type === "FeatureCollection") (o.features || []).forEach(walk);
    else if (o.type === "Feature") addGeom(o.geometry);
    else addGeom(o);
  };
  walk(gj);
  const valid = shape
    .map(poly => poly.filter(r => r.length >= 3))
    .filter(poly => poly.length > 0 && poly[0].length >= 3);
  return valid.length ? valid : null;
}

export function shapeToGeoJSON(shape: FieldShape) {
  const close = (r: Ring) => [...r, r[0]];
  return { type: "MultiPolygon", coordinates: shape.map(poly => poly.map(close)) };
}

export function shapeFromField(field: { coordinates: string; geometry?: string | null }): FieldShape {
  if (field.geometry) {
    const s = shapeFromGeoJSON(JSON.parse(field.geometry));
    if (s) return s;
  }
  return shapeFromCoords(JSON.parse(field.coordinates));
}

export function shapeBBox(shape: FieldShape, buffer = 0): [number, number, number, number] {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const poly of shape) for (const [lng, lat] of poly[0]) {
    if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
  }
  return [minLng - buffer, minLat - buffer, maxLng + buffer, maxLat + buffer];
}

function inRing(lat: number, lng: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Inside the field = inside some polygon's outer boundary and not inside any of its holes.
export function pointInShape(lat: number, lng: number, shape: FieldShape): boolean {
  for (const [outer, ...holes] of shape) {
    if (inRing(lat, lng, outer) && !holes.some(h => inRing(lat, lng, h))) return true;
  }
  return false;
}

export const ringToLatLngs = (ring: Ring): LatLng[] => ring.map(([lng, lat]) => ({ lat, lng }));
export const vertexCount = (shape: FieldShape) => shape.reduce((n, poly) => n + poly.reduce((m, r) => m + r.length, 0), 0);
