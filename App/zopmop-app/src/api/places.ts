import { BASE_URL, authHeaders } from './config';

export interface PlaceResult {
  place_id: string;
  description: string;
  main_text: string;
  secondary_text: string;
  lat: number;
  lon: number;
}

export async function searchPlaces(token: string, query: string): Promise<PlaceResult[]> {
  const res = await fetch(
    `${BASE_URL}/places/autocomplete?q=${encodeURIComponent(query)}`,
    { headers: authHeaders(token) },
  );
  if (!res.ok) throw new Error('places search failed');
  const data = await res.json();
  return (data.results ?? []) as PlaceResult[];
}
