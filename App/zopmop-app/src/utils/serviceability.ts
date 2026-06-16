/**
 * Checks whether a lat/lng coordinate falls within a serviceable city.
 * Using a bounding-box approach — easy to expand as we add more cities.
 */

export interface ServiceableCity {
  name: string;
  displayName: string;
  bounds: {
    minLat: number;
    maxLat: number;
    minLng: number;
    maxLng: number;
  };
}

export const SERVICEABLE_CITIES: ServiceableCity[] = [
  {
    name: 'gurugram',
    displayName: 'Gurugram',
    bounds: {
      minLat: 28.35,
      maxLat: 28.56,
      minLng: 76.95,
      maxLng: 77.15,
    },
  },
  // Add more cities here as you expand.
];

export function checkServiceability(lat: number, lng: number): ServiceableCity | null {
  for (const city of SERVICEABLE_CITIES) {
    const { minLat, maxLat, minLng, maxLng } = city.bounds;
    if (lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng) {
      return city;
    }
  }
  return null;
}

/** Case-insensitive lookup by city name or display name. */
export function findCityByName(input: string): ServiceableCity | null {
  const q = input.trim().toLowerCase();
  return (
    SERVICEABLE_CITIES.find(
      (c) => c.name === q || c.displayName.toLowerCase() === q
    ) ?? null
  );
}

/** All known cities for the manual picker. */
export const ALL_KNOWN_CITIES: { displayName: string; serviceable: boolean }[] = [
  { displayName: 'Gurugram', serviceable: true },
];
