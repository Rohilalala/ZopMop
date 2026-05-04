import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { InfoWindowF } from '@react-google-maps/api';
import { MarkerClusterer } from '@googlemaps/markerclusterer';
import { Maximize2, Star, X } from 'lucide-react';

import { getLivePins, type LivePin } from '@/api/workers';
import { GoogleMapWrapper } from '@/components/maps/GoogleMapWrapper';
import { Card, EmptyState, StatusPill } from '@/components/ui';

// Live worker map: one custom SVG marker per online worker, colored by job
// status. Click a marker → InfoWindow with quick detail card. Auto-fits the
// first non-empty payload only — re-fitting on every refetch would yank the
// view from under an admin who's panned.

const STATUS_COLOR: Record<LivePin['job_status'], string> = {
  idle:     '#00D4AA',
  en_route: '#FFB547',
  on_job:   '#FF4D6A',
  offline:  '#4A4A6A',
};

const DELHI: google.maps.LatLngLiteral = { lat: 28.6, lng: 77.2 };
const CLUSTER_THRESHOLD = 100;

function statusPin(color: string, scale = 1): google.maps.Icon {
  // Inlined SVG → data URL: 14px circle (18px on hover) with dark border + soft
  // halo so it reads against the dark basemap. No asset files to ship.
  const r = 7 * scale;
  const halo = r + 4;
  const size = halo * 2 + 4;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${size / 2}" cy="${size / 2}" r="${halo}" fill="${color}" fill-opacity="0.2"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="${color}" stroke="#0A0A0F" stroke-width="2"/>
  </svg>`;
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: new google.maps.Size(size, size),
    anchor: new google.maps.Point(size / 2, size / 2),
  };
}

export function LiveMapPage() {
  const [map, setMap] = useState<google.maps.Map | null>(null);
  const q = useQuery({
    queryKey: ['live-pins'],
    queryFn: getLivePins,
    refetchInterval: 10_000,
  });
  const pins = q.data ?? [];

  return (
    <div className="relative h-[calc(100vh-4rem)]">
      <GoogleMapWrapper
        center={DELHI}
        zoom={10}
        className="absolute inset-0"
        style={{ position: 'absolute', inset: 0 }}
        onLoad={setMap}
      >
        <Markers map={map} pins={pins} />
      </GoogleMapWrapper>

      <Legend pins={pins} map={map} />

      {!q.isLoading && pins.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center z-10">
          <Card className="pointer-events-auto">
            <EmptyState title="No workers currently online" />
          </Card>
        </div>
      )}
    </div>
  );
}

function Markers({ map, pins }: { map: google.maps.Map | null; pins: LivePin[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const markersRef = useRef<Record<string, google.maps.Marker>>({});
  const clustererRef = useRef<MarkerClusterer | null>(null);
  const didFitRef = useRef(false);

  // Sync markers diff-style each render: add new, move existing, drop stale.
  // Cluster only above CLUSTER_THRESHOLD — clustering at low counts hides
  // individuals behind cluster dots, defeating the operational purpose.
  useEffect(() => {
    if (!map) return;
    const nextIds = new Set<string>();
    for (const p of pins) {
      nextIds.add(p.id);
      const existing = markersRef.current[p.id];
      const scale = hoveredId === p.id ? 1.3 : 1;
      const icon = statusPin(STATUS_COLOR[p.job_status], scale);
      if (existing) {
        existing.setPosition({ lat: p.lat, lng: p.lng });
        existing.setIcon(icon);
        existing.setTitle(p.name ?? p.phone);
      } else {
        const marker = new google.maps.Marker({
          position: { lat: p.lat, lng: p.lng },
          icon,
          title: p.name ?? p.phone,
          map: clustererRef.current ? null : map,
        });
        marker.addListener('click', () => setSelectedId(p.id));
        marker.addListener('mouseover', () => setHoveredId(p.id));
        marker.addListener('mouseout', () => setHoveredId((id) => (id === p.id ? null : id)));
        markersRef.current[p.id] = marker;
      }
    }
    for (const id of Object.keys(markersRef.current)) {
      if (!nextIds.has(id)) {
        markersRef.current[id].setMap(null);
        delete markersRef.current[id];
      }
    }

    const useCluster = pins.length > CLUSTER_THRESHOLD;
    if (useCluster && !clustererRef.current) {
      clustererRef.current = new MarkerClusterer({
        map,
        markers: Object.values(markersRef.current),
      });
    } else if (!useCluster && clustererRef.current) {
      clustererRef.current.clearMarkers();
      clustererRef.current = null;
      for (const m of Object.values(markersRef.current)) m.setMap(map);
    } else if (useCluster && clustererRef.current) {
      clustererRef.current.clearMarkers();
      clustererRef.current.addMarkers(Object.values(markersRef.current));
    }
  }, [map, pins, hoveredId]);

  // Auto-fit once on first non-empty payload.
  useEffect(() => {
    if (didFitRef.current || !map || pins.length === 0) return;
    const bounds = new google.maps.LatLngBounds();
    for (const p of pins) bounds.extend({ lat: p.lat, lng: p.lng });
    map.fitBounds(bounds, 80);
    didFitRef.current = true;
  }, [map, pins]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      for (const m of Object.values(markersRef.current)) m.setMap(null);
      markersRef.current = {};
      clustererRef.current?.clearMarkers();
      clustererRef.current = null;
    };
  }, []);

  const selected = useMemo(
    () => pins.find((p) => p.id === selectedId) ?? null,
    [pins, selectedId],
  );

  if (!selected) return null;
  return (
    <InfoWindowF
      position={{ lat: selected.lat, lng: selected.lng }}
      onCloseClick={() => setSelectedId(null)}
      options={{ pixelOffset: new google.maps.Size(0, -16) }}
    >
      <InfoCard pin={selected} onClose={() => setSelectedId(null)} />
    </InfoWindowF>
  );
}

function InfoCard({ pin, onClose }: { pin: LivePin; onClose: () => void }) {
  return (
    <div className="bg-surface-elevated border border-border rounded-lg p-3 min-w-[240px] text-text-primary">
      <div className="flex items-start justify-between mb-2">
        <div>
          <div className="text-sm font-semibold">{pin.name ?? pin.phone}</div>
          <div className="text-[11px] text-text-secondary">{pin.phone}</div>
        </div>
        <button onClick={onClose} className="text-text-muted hover:text-text-primary" aria-label="Close">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <StatusPill tone={
          pin.job_status === 'idle' ? 'success'
          : pin.job_status === 'en_route' ? 'warning'
          : 'danger'
        }>{pin.job_status.replace('_', ' ')}</StatusPill>
        <span className="inline-flex items-center gap-1 text-[11px] text-text-secondary">
          <Star className="w-3 h-3 text-warning fill-warning" />
          {pin.rating.toFixed(2)}
        </span>
      </div>
      {pin.active_booking_id && (
        <div className="mb-2">
          <div className="text-[10px] uppercase tracking-wider text-text-muted">Active booking</div>
          <Link to="/orders" className="font-mono text-[11px] text-primary hover:underline">
            {pin.active_booking_id}
          </Link>
        </div>
      )}
      {pin.updated_at && (
        <div className="text-[10px] text-text-muted">
          Updated {new Date(pin.updated_at).toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}

function Legend({ pins, map }: { pins: LivePin[]; map: google.maps.Map | null }) {
  const counts = useMemo(() => {
    const out: Record<string, number> = { idle: 0, en_route: 0, on_job: 0 };
    for (const p of pins) out[p.job_status] = (out[p.job_status] ?? 0) + 1;
    return out;
  }, [pins]);

  const fitAll = useCallback(() => {
    if (!map || pins.length === 0) return;
    const bounds = new google.maps.LatLngBounds();
    for (const p of pins) bounds.extend({ lat: p.lat, lng: p.lng });
    map.fitBounds(bounds, 80);
  }, [map, pins]);

  return (
    <div className="absolute top-4 left-4 card-elevated px-4 py-3 z-10">
      <div className="text-xs uppercase tracking-wider text-text-muted mb-2">
        {pins.length} workers online
      </div>
      <div className="flex flex-col gap-1.5 text-xs">
        <LegendRow color={STATUS_COLOR.idle}     label="Idle"     count={counts.idle ?? 0} />
        <LegendRow color={STATUS_COLOR.en_route} label="En route" count={counts.en_route ?? 0} />
        <LegendRow color={STATUS_COLOR.on_job}   label="On job"   count={counts.on_job ?? 0} />
      </div>
      <button
        onClick={fitAll}
        disabled={!map || pins.length === 0}
        className="mt-3 w-full inline-flex items-center justify-center gap-1.5 text-[11px] text-primary hover:underline disabled:opacity-40 disabled:no-underline"
      >
        <Maximize2 className="w-3 h-3" />
        Fit all workers
      </button>
    </div>
  );
}

function LegendRow({ color, label, count }: { color: string; label: string; count: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-2.5 h-2.5 rounded-full" style={{ background: color }} />
      <span className="text-text-secondary">{label}</span>
      <span className="ml-auto text-text-primary tabular-nums">{count}</span>
    </div>
  );
}
