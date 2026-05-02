import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import mapboxgl, { Map, Marker } from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { MapPin, Star, X } from 'lucide-react';

import { getLivePins, type LivePin } from '@/api/workers';
import { Card, EmptyState, StatusPill } from '@/components/ui';

// LiveMapPage: full-screen Mapbox map with one pulsing marker per online
// worker. Color = job status (idle / en_route / on_job). Click → side panel.
//
// If VITE_MAPBOX_TOKEN is missing we render an empty-state instead of
// crashing; the rest of the CRM keeps working.

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN ?? '';

const STATUS_COLOR: Record<LivePin['job_status'], string> = {
  idle:     '#00D4AA', // accent / teal
  en_route: '#FFB547', // warning / amber
  on_job:   '#FF4D6A', // danger / red
  offline:  '#4A4A6A',
};

export function LiveMapPage() {
  if (!TOKEN) {
    return (
      <div className="p-6">
        <Card>
          <EmptyState
            icon={<MapPin className="w-10 h-10" />}
            title="Mapbox token missing"
            body="Set VITE_MAPBOX_TOKEN in App/zopmop-crm/.env to render the live map. The rest of the CRM is unaffected."
          />
        </Card>
      </div>
    );
  }
  return <LiveMap />;
}

function LiveMap() {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const markers = useRef<Record<string, Marker>>({});
  const [selected, setSelected] = useState<LivePin | null>(null);

  const q = useQuery({
    queryKey: ['live-pins'],
    queryFn: getLivePins,
    refetchInterval: 10_000,
  });

  // Init map once.
  useEffect(() => {
    if (!mapEl.current || mapRef.current) return;
    mapboxgl.accessToken = TOKEN;
    const map = new mapboxgl.Map({
      container: mapEl.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      center: [77.2, 28.6], // default to Delhi; auto-fits to pins on first data tick
      zoom: 10,
    });
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      markers.current = {};
    };
  }, []);

  // Sync markers to data. Adds new markers, updates existing positions, and
  // removes ones that have dropped from the response.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !q.data) return;

    const nextIds = new Set<string>();
    for (const p of q.data) {
      nextIds.add(p.id);
      const existing = markers.current[p.id];
      if (existing) {
        existing.setLngLat([p.lng, p.lat]);
        const el = existing.getElement();
        el.style.background = STATUS_COLOR[p.job_status];
      } else {
        const el = document.createElement('div');
        el.style.cssText = `
          width: 14px; height: 14px; border-radius: 50%;
          background: ${STATUS_COLOR[p.job_status]};
          border: 2px solid #0A0A0F;
          box-shadow: 0 0 0 4px ${STATUS_COLOR[p.job_status]}33;
          cursor: pointer; transition: transform 150ms;
        `;
        el.addEventListener('mouseenter', () => { el.style.transform = 'scale(1.3)'; });
        el.addEventListener('mouseleave', () => { el.style.transform = 'scale(1)'; });
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          setSelected(p);
        });
        const marker = new mapboxgl.Marker({ element: el })
          .setLngLat([p.lng, p.lat])
          .addTo(map);
        markers.current[p.id] = marker;
      }
    }
    // Remove stale markers.
    for (const id of Object.keys(markers.current)) {
      if (!nextIds.has(id)) {
        markers.current[id].remove();
        delete markers.current[id];
      }
    }
  }, [q.data]);

  // Auto-fit on first data load only — re-fitting on every refresh would
  // disorient an admin who's panned the view.
  const didFit = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !q.data || didFit.current || q.data.length === 0) return;
    const bounds = new mapboxgl.LngLatBounds();
    for (const p of q.data) bounds.extend([p.lng, p.lat]);
    map.fitBounds(bounds, { padding: 80, maxZoom: 12, duration: 600 });
    didFit.current = true;
  }, [q.data]);

  const counts = useMemo(() => {
    const out = { idle: 0, en_route: 0, on_job: 0 };
    for (const p of q.data ?? []) (out as Record<string, number>)[p.job_status] = ((out as Record<string, number>)[p.job_status] ?? 0) + 1;
    return out;
  }, [q.data]);

  return (
    <div className="relative h-[calc(100vh-4rem)]">
      <div ref={mapEl} className="absolute inset-0" />

      {/* Legend overlay */}
      <div className="absolute top-4 left-4 card-elevated px-4 py-3 z-10">
        <div className="text-xs uppercase tracking-wider text-text-muted mb-2">
          {q.data?.length ?? 0} workers online
        </div>
        <div className="flex flex-col gap-1.5 text-xs">
          <LegendRow color={STATUS_COLOR.idle}     label="Idle"     count={counts.idle} />
          <LegendRow color={STATUS_COLOR.en_route} label="En route" count={counts.en_route} />
          <LegendRow color={STATUS_COLOR.on_job}   label="On job"   count={counts.on_job} />
        </div>
      </div>

      {/* Side panel */}
      {selected && (
        <aside className="absolute top-4 right-4 bottom-4 w-80 card-elevated p-5 z-10 flex flex-col">
          <div className="flex items-start justify-between mb-3">
            <div>
              <div className="text-lg font-semibold">{selected.name ?? selected.phone}</div>
              <div className="text-xs text-text-secondary">{selected.phone}</div>
            </div>
            <button onClick={() => setSelected(null)} className="text-text-muted hover:text-text-primary"><X className="w-4 h-4" /></button>
          </div>
          <div className="flex items-center gap-2 mb-4">
            <StatusPill tone={
              selected.job_status === 'idle' ? 'success'
              : selected.job_status === 'en_route' ? 'warning'
              : 'danger'
            }>{selected.job_status.replace('_', ' ')}</StatusPill>
            <span className="inline-flex items-center gap-1 text-xs text-text-secondary">
              <Star className="w-3 h-3 text-warning fill-warning" />
              {selected.rating.toFixed(2)}
            </span>
          </div>
          {selected.active_booking_id && (
            <div className="card p-3 mb-4">
              <div className="text-[11px] uppercase tracking-wider text-text-muted">Active booking</div>
              <div className="font-mono text-xs mt-1">{selected.active_booking_id}</div>
            </div>
          )}
          <div className="text-[11px] text-text-muted font-mono">
            {selected.lat.toFixed(5)}, {selected.lng.toFixed(5)}
          </div>
        </aside>
      )}
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
