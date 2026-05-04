import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Maximize2, Users as UsersIcon } from 'lucide-react';

import { getLivePins, type LivePin } from '@/api/workers';
import { GoogleMapWrapper } from '@/components/maps/GoogleMapWrapper';
import { Card, EmptyState } from '@/components/ui';

// Compact dashboard preview of /map. Same colored dots, no info window, no
// click panel — read-only glance widget. Reuses GoogleMapWrapper so the JS
// API loader is shared with LiveMapPage and only initialised once.

const STATUS_COLOR: Record<LivePin['job_status'], string> = {
  idle:     '#00D4AA',
  en_route: '#FFB547',
  on_job:   '#FF4D6A',
  offline:  '#4A4A6A',
};

const INDIA: google.maps.LatLngLiteral = { lat: 20.59, lng: 78.96 };

function dotIcon(color: string): google.maps.Icon {
  // 8px dot, mirrors the full-size marker scaled down — no halo, no border
  // contrast tweak needed at this density.
  const r = 4;
  const halo = r + 3;
  const size = halo * 2 + 4;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${size / 2}" cy="${size / 2}" r="${halo}" fill="${color}" fill-opacity="0.2"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="${color}" stroke="#0A0A0F" stroke-width="1.5"/>
  </svg>`;
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: new google.maps.Size(size, size),
    anchor: new google.maps.Point(size / 2, size / 2),
  };
}

export function MiniWorkerMap() {
  const q = useQuery({
    queryKey: ['live-pins-mini'],
    queryFn: getLivePins,
    refetchInterval: 10_000,
  });
  const data = q.data ?? [];

  return (
    <Card className="relative">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Workers · live</h3>
        <Link
          to="/map"
          className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
        >
          <Maximize2 className="w-3.5 h-3.5" />
          Expand
        </Link>
      </div>
      {!q.isLoading && data.length === 0 ? (
        <EmptyState
          icon={<UsersIcon className="w-8 h-8" />}
          title="No workers currently online"
        />
      ) : (
        <MapBody pins={data} />
      )}
    </Card>
  );
}

function MapBody({ pins }: { pins: LivePin[] }) {
  const [map, setMap] = useState<google.maps.Map | null>(null);
  return (
    <div className="w-full h-[300px] rounded-lg overflow-hidden">
      <GoogleMapWrapper
        center={INDIA}
        zoom={4}
        disableDefaultUI
        style={{ width: '100%', height: '100%' }}
        onLoad={setMap}
      >
        <Dots map={map} pins={pins} />
      </GoogleMapWrapper>
    </div>
  );
}

function Dots({ map, pins }: { map: google.maps.Map | null; pins: LivePin[] }) {
  const markersRef = useRef<Record<string, google.maps.Marker>>({});
  const didFitRef = useRef(false);

  useEffect(() => {
    if (!map) return;
    const nextIds = new Set<string>();
    for (const p of pins) {
      nextIds.add(p.id);
      const existing = markersRef.current[p.id];
      const icon = dotIcon(STATUS_COLOR[p.job_status]);
      if (existing) {
        existing.setPosition({ lat: p.lat, lng: p.lng });
        existing.setIcon(icon);
      } else {
        markersRef.current[p.id] = new google.maps.Marker({
          position: { lat: p.lat, lng: p.lng },
          icon,
          map,
          clickable: false,
        });
      }
    }
    for (const id of Object.keys(markersRef.current)) {
      if (!nextIds.has(id)) {
        markersRef.current[id].setMap(null);
        delete markersRef.current[id];
      }
    }
  }, [map, pins]);

  // Fit bounds once on first non-empty payload — re-fitting on every 10s
  // refresh would jitter the dashboard widget.
  useEffect(() => {
    if (didFitRef.current || !map || pins.length === 0) return;
    const bounds = new google.maps.LatLngBounds();
    for (const p of pins) bounds.extend({ lat: p.lat, lng: p.lng });
    map.fitBounds(bounds, 40);
    didFitRef.current = true;
  }, [map, pins]);

  useEffect(() => {
    return () => {
      for (const m of Object.values(markersRef.current)) m.setMap(null);
      markersRef.current = {};
      didFitRef.current = false;
    };
  }, []);

  return null;
}
