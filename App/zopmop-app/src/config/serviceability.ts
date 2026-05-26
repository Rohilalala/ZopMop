export interface ServiceArea {
  id: string;
  name: string;
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number };
}

// TODO(crm): replace static config with GET /v1/admin/service-areas
export const SERVICE_AREAS: ServiceArea[] = [
  {
    id: 'orchid-island-gurugram',
    name: 'Orchid Island, Gurugram',
    bbox: { minLat: 28.40, maxLat: 28.43, minLon: 77.07, maxLon: 77.10 },
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
