// Visual SDUI preview — renders a hydrated home page (the /preview payload, with
// $refs resolved) into a phone-frame mock. Recognizable approximation of the
// app, NOT a pixel-perfect clone: it shows section order, copy, visibility, and
// per-service content (emoji + name + price + rating) so an editor can eyeball a
// config before publishing. New/unknown section types fall back to a labelled
// block so the preview never breaks.

type AnySection = { id?: string; type?: string; visible?: boolean; data?: any };

function asSections(page: unknown): AnySection[] {
  if (page && typeof page === 'object' && Array.isArray((page as any).sections)) {
    return (page as any).sections as AnySection[];
  }
  return [];
}

const rupees = (cents?: number) =>
  typeof cents === 'number' ? `₹${Math.round(cents / 100)}` : '';

export function SduiVisualPreview({ page }: { page: unknown }) {
  const sections = asSections(page);

  return (
    <div className="flex justify-center py-2">
      {/* phone frame */}
      <div className="relative w-[380px] h-[720px] rounded-[2.5rem] border-8 border-neutral-800 bg-[#FAF7F2] shadow-2xl overflow-hidden">
        {/* notch */}
        <div className="absolute left-1/2 top-0 z-10 h-6 w-32 -translate-x-1/2 rounded-b-2xl bg-neutral-800" />
        <div className="h-full overflow-y-auto px-4 pt-9 pb-6 text-[#0D0D0F]">
          {sections.length === 0 ? (
            <div className="mt-20 text-center text-sm text-neutral-500">
              No sections in the hydrated payload.
            </div>
          ) : (
            sections.map((s, i) => (
              <div key={s.id ?? i} className={s.visible === false ? 'opacity-30' : ''}>
                {s.visible === false && (
                  <div className="mb-1 text-[9px] font-bold uppercase tracking-wide text-neutral-400">
                    hidden
                  </div>
                )}
                <Section section={s} />
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ section }: { section: AnySection }) {
  const d = section.data ?? {};
  switch (section.type) {
    case 'header_promo':
      return (
        <div className="mb-3 flex justify-end">
          <span className="rounded-full bg-[#0D0D0F] px-3 py-1.5 text-xs font-bold text-[#F5A300]">
            ⊕ {d.label ?? 'Earn'}
          </span>
        </div>
      );

    case 'greeting_hero':
      return (
        <div className="mb-3 rounded-3xl bg-white/70 p-5 shadow-sm">
          {d.greeting && (
            <div className="text-[10px] font-bold uppercase tracking-wider text-[#E88F00]">
              {d.greeting}
            </div>
          )}
          <div className="mt-1 whitespace-pre-line text-2xl font-extrabold leading-tight">
            {Array.isArray(d.title_lines) ? d.title_lines.join('\n') : 'Home,\nhandled.'}
          </div>
        </div>
      );

    case 'live_pill':
      return (
        <div className="mb-3 rounded-2xl bg-white/60 px-4 py-3 text-center text-sm text-neutral-600">
          {typeof d.nearby_count === 'number' && d.nearby_count > 0
            ? `${d.nearby_count} pros nearby · ${d.avg_eta_min ?? 0} min · ★ ${d.avg_rating ?? ''}`
            : 'All our pros are busy right now'}
        </div>
      );

    case 'usuals_row':
      return (
        <div className="mb-4">
          <div className="mb-2 text-lg font-bold">Book in 30 seconds</div>
          <div className="flex gap-3 overflow-x-auto pb-1">
            {(d.services ?? []).map((sv: any, i: number) => (
              <div key={sv.id ?? i} className="flex w-20 shrink-0 flex-col items-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white/70 text-3xl">
                  {sv.emoji ?? '✨'}
                </div>
                <div className="mt-1 text-center text-xs font-bold leading-tight">{sv.name}</div>
              </div>
            ))}
          </div>
        </div>
      );

    case 'service_grid':
      return (
        <div className="mb-4">
          <div className="mb-2 text-lg font-bold">{d.title ?? 'Popular services'}</div>
          <div className="grid grid-cols-2 gap-3">
            {(d.services ?? []).map((sv: any, i: number) => (
              <div key={sv.id ?? i} className="rounded-2xl bg-white/70 p-3 shadow-sm">
                <div className="text-3xl">{sv.emoji ?? '✨'}</div>
                <div className="mt-1 text-sm font-bold leading-tight">{sv.name}</div>
                <div className="mt-1 flex items-center justify-between text-xs text-neutral-600">
                  <span>{rupees(sv.base_price_cents)}</span>
                  {sv.rating ? <span>★ {sv.rating}</span> : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      );

    case 'hero_carousel':
      return (
        <div className="mb-4 space-y-2">
          {(d.slides ?? []).map((sl: any, i: number) => (
            <div
              key={sl.key ?? i}
              className="rounded-2xl p-4 text-white"
              style={{ background: sl.bg || '#F5A300' }}
            >
              <div className="text-[10px] font-bold uppercase tracking-wider opacity-80">{sl.eyebrow}</div>
              <div className="text-lg font-extrabold">{sl.title}</div>
              <div className="text-xs opacity-90">{sl.body}</div>
              {sl.cta && (
                <span className="mt-2 inline-block rounded-full bg-white/25 px-3 py-1 text-xs font-bold">
                  {sl.cta}
                </span>
              )}
            </div>
          ))}
        </div>
      );

    case 'upcoming_booking':
      return d.visible === false ? null : (
        <div className="mb-3 flex justify-center">
          <span className="rounded-full bg-[#0D0D0F] px-3 py-1.5 text-xs font-semibold text-white">
            ● Upcoming booking
          </span>
        </div>
      );

    case 'footer':
      return (
        <div className="mb-2 mt-6">
          <div className="whitespace-pre-line text-3xl font-extrabold leading-tight">
            {d.signoff?.lines?.join('\n') ?? ''}
          </div>
          {d.signoff?.brand && (
            <div className="mt-3 text-lg font-extrabold text-[#F5A300]">{d.signoff.brand}</div>
          )}
          {Array.isArray(d.signoff?.badges) && (
            <div className="mt-2 text-xs text-neutral-500">{d.signoff.badges.join(' · ')}</div>
          )}
          {d.signoff?.tagline && (
            <div className="mt-3 text-[10px] uppercase tracking-wider text-neutral-400">
              {d.signoff.tagline}
            </div>
          )}
        </div>
      );

    default:
      return (
        <div className="mb-3 rounded-xl border border-dashed border-neutral-300 p-3 text-xs text-neutral-500">
          <span className="font-bold">{section.type ?? 'unknown'}</span> — no visual renderer
        </div>
      );
  }
}
