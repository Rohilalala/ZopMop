export interface ServiceArea {
  id: string;
  name: string;
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number };
}

// TODO(crm): replace static config with GET /v1/admin/service-areas
export const SERVICE_AREAS: ServiceArea[] = [
  {
    id: 'gurugram',
    name: 'Gurugram',
    bbox: { minLat: 28.35, maxLat: 28.56, minLon: 76.95, maxLon: 77.15 },
  },
];

export function isInsideBbox(
  lat: number,
  lon: number,
  bbox: ServiceArea['bbox'],
): boolean {
  return (
    lat >= bbox.minLat &&
    lat <= bbox.maxLat &&
    lon >= bbox.minLon &&
    lon <= bbox.maxLon
  );
}

export function checkServiceability(
  lat: number,
  lon: number,
): { serviceable: boolean; areaName: string | null } {
  for (const area of SERVICE_AREAS) {
    if (isInsideBbox(lat, lon, area.bbox)) {
      return { serviceable: true, areaName: area.name };
    }
  }
  return { serviceable: false, areaName: null };
}
