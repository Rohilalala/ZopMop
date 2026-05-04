import { createContext, useContext, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { GoogleMap, useJsApiLoader } from '@react-google-maps/api';
import { MapPin } from 'lucide-react';

import { EmptyState, Skeleton } from '@/components/ui';
import { darkMapStyle, GOOGLE_MAPS_LIBRARIES } from '@/lib/maps/googleMapsStyle';

// Single source of truth for the Google Maps JS API loader. `useJsApiLoader`
// keys off the `id` we pass — every mount with the same id reuses the same
// script tag, so LiveMapPage and MiniWorkerMap together only fetch the SDK
// once for the lifetime of the SPA.

const API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY ?? '';

const MapInstanceContext = createContext<google.maps.Map | null>(null);

export function useGoogleMap(): google.maps.Map | null {
  return useContext(MapInstanceContext);
}

type Props = {
  center: google.maps.LatLngLiteral;
  zoom: number;
  children?: ReactNode;
  onLoad?: (map: google.maps.Map) => void;
  style?: CSSProperties;
  className?: string;
  // Dashboard widget: hide the entire default UI (no zoom buttons, no
  // attribution bar). Full page leaves it on so admins can zoom by click.
  disableDefaultUI?: boolean;
};

export function GoogleMapWrapper({
  center,
  zoom,
  children,
  onLoad,
  style,
  className,
  disableDefaultUI = false,
}: Props) {
  const [mapInstance, setMapInstance] = useState<google.maps.Map | null>(null);

  const { isLoaded, loadError } = useJsApiLoader({
    id: 'zopmop-crm-google-maps',
    googleMapsApiKey: API_KEY,
    libraries: GOOGLE_MAPS_LIBRARIES,
  });

  const options = useMemo<google.maps.MapOptions>(
    () => ({
      styles: darkMapStyle,
      backgroundColor: '#0A0A0F',
      disableDefaultUI,
      streetViewControl: false,
      mapTypeControl: false,
      fullscreenControl: false,
      zoomControl: !disableDefaultUI,
      // 7 = google.maps.ControlPosition.RIGHT_BOTTOM, hard-coded to avoid
      // dereferencing `google` before the SDK loads.
      zoomControlOptions: { position: 7 },
      clickableIcons: false,
      gestureHandling: 'greedy',
    }),
    [disableDefaultUI],
  );

  if (!API_KEY) {
    return (
      <div className={className} style={style}>
        <EmptyState
          icon={<MapPin className="w-10 h-10" />}
          title="Google Maps key missing"
          body="Set VITE_GOOGLE_MAPS_API_KEY in App/zopmop-crm/.env to render the map."
        />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className={className} style={style}>
        <EmptyState
          icon={<MapPin className="w-10 h-10" />}
          title="Map failed to load"
          body="Check your Google Maps API key."
        />
      </div>
    );
  }

  if (!isLoaded) {
    return (
      <div className={className} style={style}>
        <Skeleton className="w-full h-full rounded-lg" />
      </div>
    );
  }

  return (
    <GoogleMap
      mapContainerStyle={style ?? { width: '100%', height: '100%' }}
      mapContainerClassName={className}
      center={center}
      zoom={zoom}
      options={options}
      onLoad={(map) => {
        setMapInstance(map);
        onLoad?.(map);
      }}
      onUnmount={() => setMapInstance(null)}
    >
      <MapInstanceContext.Provider value={mapInstance}>
        {children}
      </MapInstanceContext.Provider>
    </GoogleMap>
  );
}
