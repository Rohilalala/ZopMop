import { useCallback } from 'react';
import { checkServiceability } from '../../../config/serviceability';

export function useServiceability() {
  const isServiceable = useCallback((lat: number, lon: number) => {
    return checkServiceability(lat, lon).serviceable;
  }, []);

  const getAreaName = useCallback((lat: number, lon: number) => {
    return checkServiceability(lat, lon).areaName;
  }, []);

  return { isServiceable, getAreaName };
}
