import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';

import { getHealthMetrics, type HealthMetrics } from '@/api/all';

// HealthStrip: ultra-compact ops status bar at the top of the dashboard.
// Polls /admin/health/metrics every 30s. The endpoint pings user-app on
// each call, so we deliberately throttle (don't go faster).
//
// Failure modes:
//  - request errors  → red "APP UNREACHABLE" banner above the strip
//  - uptime "down"   → same banner (the API answered but the app is down)
//  - uptime unknown  → muted dot, no banner

type Tone = 'good' | 'warn' | 'bad' | 'muted';

const TONE_DOT: Record<Tone, string> = {
  good:  'bg-success',
  warn:  'bg-warning',
  bad:   'bg-danger',
  muted: 'bg-text-muted',
};
const TONE_TEXT: Record<Tone, string> = {
  good:  'text-success',
  warn:  'text-warning',
  bad:   'text-danger',
  muted: 'text-text-muted',
};

function latencyTone(ms: number): Tone {
  if (ms < 200) return 'good';
  if (ms <= 500) return 'warn';
  return 'bad';
}
function errorTone(rate: number): Tone {
  // rate is a fraction (0.013 == 1.3%)
  if (rate < 0.01) return 'good';
  if (rate <= 0.05) return 'warn';
  return 'bad';
}
function uptimeTone(s: HealthMetrics['uptime']): Tone {
  if (s === 'up') return 'good';
  if (s === 'down') return 'bad';
  return 'muted';
}

export function HealthStrip() {
  const q = useQuery({
    queryKey: ['health-metrics'],
    queryFn: getHealthMetrics,
    refetchInterval: 30_000,
    staleTime: 25_000,
  });

  const unreachable = q.isError || q.data?.uptime === 'down';

  return (
    <div className="space-y-2">
      {unreachable && (
        <div className="flex items-center gap-2 px-4 py-2 rounded-lg border border-danger/40 bg-danger/10 text-danger text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span className="font-medium">APP UNREACHABLE</span>
          <span className="text-danger/80">— main API health check failed</span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2 rounded-lg border border-border bg-card text-xs">
        {q.isLoading ? (
          <span className="text-text-muted">Loading metrics…</span>
        ) : q.data ? (
          <>
            <Indicator
              label="Latency"
              tone={latencyTone(q.data.avg_latency_ms)}
              value={`${Math.round(q.data.avg_latency_ms)}ms`}
            />
            <Indicator
              label="Errors"
              tone={errorTone(q.data.error_rate)}
              value={`${(q.data.error_rate * 100).toFixed(1)}%`}
            />
            <Indicator
              label="Uptime"
              tone={uptimeTone(q.data.uptime)}
              value={q.data.uptime.toUpperCase()}
            />
            <span className="ml-auto text-text-muted tabular-nums">
              {new Date(q.data.checked_at).toLocaleTimeString()}
            </span>
          </>
        ) : (
          <span className="text-text-muted">Metrics unavailable</span>
        )}
      </div>
    </div>
  );
}

function Indicator({ label, tone, value }: { label: string; tone: Tone; value: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`w-2 h-2 rounded-full ${TONE_DOT[tone]}`} />
      <span className="text-text-muted">{label}:</span>
      <span className={`font-medium tabular-nums ${TONE_TEXT[tone]}`}>{value}</span>
    </span>
  );
}
