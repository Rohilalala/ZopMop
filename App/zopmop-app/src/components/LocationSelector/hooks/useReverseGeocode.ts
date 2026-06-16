import { useState, useCallback, useRef } from 'react';
import * as Location from 'expo-location';

const DRAG_DEBOUNCE_MS = 300;

type GpsState = 'idle' | 'loading' | 'denied' | 'error';

export function useReverseGeocode() {
  const [gpsState, setGpsState] = useState<GpsState>('idle');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reverseGeocode = useCallback(
    async (lat: number, lon: number): Promise<string> => {
      try {
        const [place] = await Location.reverseGeocodeAsync({
          latitude: lat,
          longitude: lon,
        });
        if (!place) return 'Selected Location';
        return (
          [place.name, place.district ?? place.subregion ?? place.city]
            .filter(Boolean)
            .join(', ') || 'Selected Location'
        );
      } catch {
        return 'Selected Location';
      }
    },
    [],
  );

  const getCurrentLocation = useCallback(async (): Promise<{
    lat: number;
    lon: number;
    name: string;
  } | null> => {
    setGpsState('loading');
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setGpsState('denied');
        return null;
      }
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const { latitude, longitude } = pos.coords;
      const name = await reverseGeocode(latitude, longitude);
      setGpsState('idle');
      return { lat: latitude, lon: longitude, name };
    } catch {
      setGpsState('error');
      return null;
    }
  }, [reverseGeocode]);

  const reverseGeocodeDebounced = useCallback(
    (lat: number, lon: number, onResult: (name: string) => void) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(async () => {
        const name = await reverseGeocode(lat, lon);
        onResult(name);
      }, DRAG_DEBOUNCE_MS);
    },
    [reverseGeocode],
  );

  return { gpsState, getCurrentLocation, reverseGeocode, reverseGeocodeDebounced };
}
