import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Dimensions,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { LoadingBars } from './ui/LoadingBars';
import { FontFamily } from '../theme';
import { useC, type ScreenColors } from '../theme/screen';
import { useTheme } from '../context/ThemeContext';
import { Bloom } from './home/Bloom';
import { getSlotAvailability, type ApiTimeSlot, type ApiSlotPeriod } from '../api/slots';

// What the user picked: a specific regular slot. The instant/scheduled choice
// now lives on the cart's ModeToggle; this modal is slot-only.
export type ScheduleSelection = { kind: 'slot'; slotId: string; label: string };

interface Props {
  visible: boolean;
  token: string;
  // Active booking address. When set, slots come from the capacity-aware
  // /bookings/availability endpoint (live headroom). When absent, the modal
  // falls back to the plain /slots feed and capacity degrades to Available/Full.
  addressId?: string;
  onClose: () => void;
  onConfirm: (selection: ScheduleSelection) => void;
}

const { height: SCREEN_H } = Dimensions.get('window');

// SCHEDULING_LEAD_DAYS — hard cap matches backend booking.scheduledBookingMaxLeadDays.
const SCHEDULING_LEAD_DAYS = 2;

// All scheduling math runs in IST — the backend slots and the cutoff are IST.
// We shift the epoch by +5:30 and then read/write ONLY UTC fields, so the
// shifted instant's UTC calendar values equal the IST wall-clock, regardless of
// the device timezone. This avoids the drift where, before 05:30 IST, the real
// UTC date is still "yesterday" — which made the "Today" chip resolve to
// yesterday's (already-past) slots and look unbookable.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Customers can't book a regular slot closer than this (spec §3.1:
// minSlotLeadMin = dispatchLead 30 + travelBuffer 15). The backend /slots feed
// only filters at +30 min, so a slot in the 30–45 min window can still arrive —
// the picker disables it here (and the scheduled-create path would 400
// slot_too_soon as a backstop).
const MIN_SLOT_LEAD_MIN = 45;

function istNow(): Date {
  return new Date(Date.now() + IST_OFFSET_MS);
}

// IST wall-clock instant for a slot on `dayIso` (YYYY-MM-DD) starting at
// `startTime` ("HH:MM"). Built via Date.UTC so its UTC fields equal the IST
// wall-clock — directly comparable to istNow() (same shifted-epoch convention).
function slotIstStart(dayIso: string, startTime: string): Date {
  const [y, m, d] = dayIso.split('-').map(Number);
  const [hh, mm] = startTime.split(':').map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0, 0));
}

// A slot is too soon to book when its IST start is within the 45-min lead.
function isSlotTooSoon(dayIso: string, startTime: string): boolean {
  return slotIstStart(dayIso, startTime).getTime() < istNow().getTime() + MIN_SLOT_LEAD_MIN * 60 * 1000;
}

function buildDays(): { iso: string; label: string; dayName: string; disabled: boolean }[] {
  const days = [];
  const base = istNow();
  for (let i = 0; i <= SCHEDULING_LEAD_DAYS; i++) {
    const d = new Date(base);
    d.setUTCDate(base.getUTCDate() + i);
    const iso = d.toISOString().split('T')[0];
    const dayName = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' });
    const label = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    // No 8 PM cutoff (spec §9/§13.3 deleted schedulingCutoffHourIST): the backend
    // accepts any slot that is not past, ≥45 min out, and ≤2 days ahead, so day
    // chips stay enabled across the whole window. Individual slots in the
    // 30–45-min gap are disabled by the per-slot isSlotTooSoon check; a day with
    // no remaining bookable slots simply shows every period as "Full".
    days.push({ iso, label, dayName, disabled: false });
  }
  return days;
}

function firstSelectableIso(days: ReturnType<typeof buildDays>): string {
  return (days.find((d) => !d.disabled) ?? days[days.length - 1]).iso;
}

// Backend periods are Morning | Afternoon | Evening. The segmented control
// displays the shorter Noon/Eve; the backend label stays the lookup key.
const PERIOD_ORDER = ['Morning', 'Afternoon', 'Evening'];
const PERIOD_TAB: Record<string, string> = { Morning: 'Morning', Afternoon: 'Noon', Evening: 'Eve' };

// Live helper headroom for a slot. Prefer available_capacity from the
// capacity endpoint; otherwise derive from the slot counters on the /slots
// fallback so the meter still carries a signal pre-merge.
function slotCapacity(slot: ApiTimeSlot): number {
  if (typeof slot.available_capacity === 'number') return Math.max(0, slot.available_capacity);
  return Math.max(0, slot.max_bookings - slot.current_bookings);
}

// Bookable is colour-independent so the period tab counts don't depend on theme.
// A slot is bookable only if it has live capacity AND its start is ≥ 45 min out.
function isSlotBookable(slot: ApiTimeSlot, dayIso: string): boolean {
  return slot.is_available && slotCapacity(slot) > 0 && !isSlotTooSoon(dayIso, slot.start_time);
}

// Three capacity states drive the meter colour, fill and label. Scarce-only
// copy: roomy slots say "Available" with no raw number; numbers appear only at
// <= 3. fill is bucketed — the meter is a signal, not a precise gauge.
type CapView = { fill: number; color: string; label: string; bookable: boolean };
function capView(slot: ApiTimeSlot, c: ScreenColors, dayIso: string): CapView {
  const n = slotCapacity(slot);
  if (isSlotTooSoon(dayIso, slot.start_time)) {
    return { fill: 1, color: c.textMuted, label: 'Not available', bookable: false };
  }
  if (!slot.is_available || n <= 0) {
    return { fill: 1, color: c.textMuted, label: 'Full', bookable: false };
  }
  if (n <= 3) {
    const fill = n === 1 ? 0.9 : n === 2 ? 0.8 : 0.7;
    const color = n === 1 ? c.amberLo : c.amber;
    return { fill, color, label: `${n} left`, bookable: true };
  }
  return { fill: 0.3, color: c.green, label: 'Available', bookable: true };
}

export default function SchedulingModal({ visible, token, addressId, onClose, onConfirm }: Props) {
  const c = useC();
  const { isDark } = useTheme();
  const s = useMemo(() => makeStyles(c, isDark), [c, isDark]);

  const DAYS = React.useMemo(() => buildDays(), [visible]);
  const [selectedDay, setSelectedDay] = useState(() => firstSelectableIso(buildDays()));
  const [periods, setPeriods] = useState<ApiSlotPeriod[]>([]);
  const [activePeriod, setActivePeriod] = useState<string>('Morning');
  const [loading, setLoading] = useState(false);
  // Distinguish a failed slot load from a genuinely empty day — otherwise a
  // transient network error reads as "No slots available" with no retry.
  const [slotsError, setSlotsError] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [selectedSlot, setSelectedSlot] = useState<ApiTimeSlot | null>(null);

  useEffect(() => {
    if (visible) {
      setSelectedDay(firstSelectableIso(DAYS));
      setSelectedSlot(null);
    }
  }, [visible]);

  // Cache availability per (day, address) so switching dates is instant after
  // the first load — no loading-bar flash. The cache is cleared each time the
  // modal (re)opens or the address changes, so capacity is at most a few
  // seconds stale within one open.
  const cacheRef = useRef<Map<string, ApiSlotPeriod[]>>(new Map());
  const cacheKey = useCallback(
    (iso: string) => `${iso}|${addressId ?? ''}`,
    [addressId],
  );

  // Prefetch every other selectable day on open so the first date switch is
  // already warm. The current day is fetched by the day-effect below.
  useEffect(() => {
    if (!visible) return;
    cacheRef.current.clear();
    let cancelled = false;
    const current = firstSelectableIso(DAYS);
    DAYS.filter(d => !d.disabled && d.iso !== current).forEach(d => {
      getSlotAvailability(token, addressId, d.iso)
        .then(data => { if (!cancelled) cacheRef.current.set(cacheKey(d.iso), data); })
        .catch(() => {});
    });
    return () => { cancelled = true; };
  }, [visible, token, addressId, DAYS, cacheKey]);

  // Render the selected day: serve from cache instantly (no loader); only show
  // the loading bars on a genuine cache miss (the very first time a day loads).
  useEffect(() => {
    if (!visible) return;
    setSelectedSlot(null);
    setSlotsError(false);
    const cached = cacheRef.current.get(cacheKey(selectedDay));
    if (cached) { setPeriods(cached); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    getSlotAvailability(token, addressId, selectedDay)
      .then(data => { if (!cancelled) { cacheRef.current.set(cacheKey(selectedDay), data); setPeriods(data); } })
      .catch(() => { if (!cancelled) { setPeriods([]); setSlotsError(true); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [visible, selectedDay, token, addressId, cacheKey, reloadTick]);

  // Canonical-ordered tabs with a live open-count, derived from the loaded
  // periods. A period with zero bookable slots renders disabled + "Full".
  const tabs = useMemo(() => {
    const byLabel = new Map(periods.map(p => [p.label, p]));
    return PERIOD_ORDER.filter(l => byLabel.has(l)).map(label => {
      const p = byLabel.get(label)!;
      const open = p.slots.filter(sl => isSlotBookable(sl, selectedDay)).length;
      return { label, tab: PERIOD_TAB[label] ?? label, open, slots: p.slots };
    });
  }, [periods, selectedDay]);

  // When slots (re)load, land on the first period that has open slots so the
  // user opens onto something bookable; fall back to the first tab.
  useEffect(() => {
    if (!tabs.length) return;
    const firstOpen = tabs.find(t => t.open > 0) ?? tabs[0];
    setActivePeriod(firstOpen.label);
    setSelectedSlot(null);
  }, [tabs]);

  const activeSlots = useMemo(
    () => tabs.find(t => t.label === activePeriod)?.slots ?? [],
    [tabs, activePeriod],
  );

  const handleConfirm = useCallback(() => {
    if (!selectedSlot) return;
    const day = DAYS.find(d => d.iso === selectedDay);
    const label = `${day?.dayName ?? selectedDay}, ${selectedSlot.start_time} – ${selectedSlot.end_time}`;
    onConfirm({ kind: 'slot', slotId: selectedSlot.id, label });
  }, [selectedSlot, selectedDay, DAYS, onConfirm]);

  const canConfirm = !!selectedSlot;
  const confirmLabel = selectedSlot
    ? `Confirm · ${DAYS.find(d => d.iso === selectedDay)?.dayName ?? ''} ${selectedSlot.start_time}`.trim()
    : 'Select a time';

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <View style={s.overlay}>
        <TouchableOpacity style={StyleSheet.absoluteFillObject} activeOpacity={1} onPress={onClose} />

        <View style={s.sheet}>
          <View style={s.bloomWrap} pointerEvents="none">
            <Bloom />
          </View>

          <View style={s.handle} />

          <View style={s.header}>
            <Text style={s.title}>Choose Date &amp; Time</Text>
            <TouchableOpacity onPress={onClose} activeOpacity={0.7} style={s.closeBtn}>
              <Feather name="x" size={16} color={c.text} />
            </TouchableOpacity>
          </View>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={s.dateScrollView}
            contentContainerStyle={s.dateStrip}
          >
            {DAYS.map(day => {
              const active = day.iso === selectedDay;
              return (
                <TouchableOpacity
                  key={day.iso}
                  style={[
                    s.dayChip,
                    active && s.dayChipActive,
                    day.disabled && s.dayChipDisabled,
                  ]}
                  activeOpacity={0.75}
                  disabled={day.disabled}
                  onPress={() => setSelectedDay(day.iso)}
                >
                  <Text
                    style={[
                      s.dayName,
                      active && s.dayNameActive,
                      day.disabled && s.dayTextDisabled,
                    ]}
                  >
                    {day.dayName}
                  </Text>
                  <Text
                    style={[
                      s.dayLabel,
                      active && s.dayLabelActive,
                      day.disabled && s.dayTextDisabled,
                    ]}
                  >
                    {day.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          {!loading && tabs.length > 0 && (
            <View style={s.segment}>
              {tabs.map(t => {
                const active = t.label === activePeriod;
                const disabled = t.open === 0;
                return (
                  <TouchableOpacity
                    key={t.label}
                    style={[s.segBtn, active && s.segBtnActive]}
                    activeOpacity={0.8}
                    disabled={disabled}
                    onPress={() => { setActivePeriod(t.label); setSelectedSlot(null); }}
                  >
                    <Text style={[s.segName, active && s.segNameActive, disabled && s.segNameDisabled]}>
                      {t.tab}
                    </Text>
                    <Text style={[s.segCount, active && s.segCountActive, disabled && s.segNameDisabled]}>
                      {disabled ? 'Full' : `${t.open} open`}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          <View style={s.slotsContainer}>
            {loading ? (
              <LoadingBars color={c.amber} style={{ marginVertical: 32 }} />
            ) : slotsError ? (
              <View style={{ alignItems: 'center', marginVertical: 28, gap: 10 }}>
                <Text style={s.noSlots}>Couldn't load time slots</Text>
                <TouchableOpacity
                  onPress={() => { cacheRef.current.delete(cacheKey(selectedDay)); setReloadTick((t) => t + 1); }}
                  style={{ paddingVertical: 8, paddingHorizontal: 18, borderRadius: 10, backgroundColor: c.amber }}
                  activeOpacity={0.85}
                >
                  <Text style={{ fontFamily: FontFamily.bold, fontSize: 13, color: '#0D0D0F' }}>Retry</Text>
                </TouchableOpacity>
              </View>
            ) : activeSlots.length === 0 ? (
              <Text style={s.noSlots}>No slots available for this date</Text>
            ) : (
              <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={s.slotsScroll}>
                <View style={s.slotsGrid}>
                  {activeSlots.map(slot => {
                    const cap = capView(slot, c, selectedDay);
                    const active = selectedSlot?.id === slot.id;
                    return (
                      <TouchableOpacity
                        key={slot.id}
                        style={[
                          s.slotBtn,
                          active && s.slotBtnActive,
                          !cap.bookable && s.slotBtnDisabled,
                        ]}
                        activeOpacity={0.78}
                        disabled={!cap.bookable}
                        onPress={() => { setSelectedSlot(slot); }}
                      >
                        <Text style={[s.slotTime, active && s.slotTimeActive, !cap.bookable && s.slotTimeDisabled]}>
                          {slot.start_time}
                        </Text>
                        <Text style={[s.slotEnd, active && s.slotEndActive, !cap.bookable && s.slotTimeDisabled]}>
                          – {slot.end_time}
                        </Text>
                        <View style={s.meter}>
                          <View style={[s.meterFill, { width: `${cap.fill * 100}%`, backgroundColor: cap.color }]} />
                        </View>
                        <Text style={[s.capLabel, { color: cap.bookable ? cap.color : c.textMuted }]}>
                          {cap.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </ScrollView>
            )}
          </View>

          <View style={s.footer}>
            <TouchableOpacity
              style={[s.confirmBtn, !canConfirm && s.confirmBtnDisabled]}
              activeOpacity={0.88}
              disabled={!canConfirm}
              onPress={handleConfirm}
            >
              <Text style={[s.confirmText, !canConfirm && s.confirmTextDisabled]}>{confirmLabel}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (c: ScreenColors, isDark: boolean) => {
  const meterTrack = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(13,13,15,0.07)';
  const handleBg = isDark ? 'rgba(255,255,255,0.18)' : 'rgba(13,13,15,0.18)';
  return StyleSheet.create({
    overlay: {
      flex: 1,
      justifyContent: 'flex-end',
      backgroundColor: 'rgba(0,0,0,0.6)',
    },
    sheet: {
      backgroundColor: c.bg,
      borderTopLeftRadius: 28,
      borderTopRightRadius: 28,
      height: SCREEN_H * 0.78,
      overflow: 'hidden',
      borderTopWidth: 0.5,
      borderColor: c.glassBorderHi,
    },
    bloomWrap: {
      position: 'absolute',
      top: 0, left: 0, right: 0, bottom: 0,
    },
    handle: {
      width: 40, height: 4,
      borderRadius: 999,
      backgroundColor: handleBg,
      alignSelf: 'center',
      marginTop: 10, marginBottom: 4,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 20,
      paddingVertical: 14,
      borderBottomWidth: 0.5,
      borderBottomColor: c.divider,
    },
    title: {
      fontFamily: FontFamily.extrabold,
      fontSize: 18,
      color: c.text,
      letterSpacing: -0.3,
    },
    closeBtn: {
      width: 32, height: 32, borderRadius: 16,
      backgroundColor: c.glassHi,
      borderWidth: 0.5, borderColor: c.glassBorderHi,
      alignItems: 'center', justifyContent: 'center',
    },

    dateScrollView: {
      flexGrow: 0,
      flexShrink: 0,
    },
    dateStrip: {
      paddingHorizontal: 16, paddingVertical: 14, gap: 10,
      alignItems: 'center',
    },
    dayChip: {
      alignItems: 'center',
      paddingHorizontal: 14, paddingVertical: 10,
      borderRadius: 16,
      backgroundColor: c.glass,
      borderWidth: 0.5, borderColor: c.glassBorder,
      minWidth: 72,
    },
    dayChipActive: {
      backgroundColor: c.amberSoft,
      borderColor: c.amberLine,
    },
    dayChipDisabled: { opacity: 0.32 },
    dayTextDisabled: { color: c.textMuted },
    dayName: {
      fontFamily: FontFamily.semibold,
      fontSize: 11,
      color: c.textSecondary,
      letterSpacing: 0.3,
    },
    dayNameActive: { color: c.amberLo },
    dayLabel: {
      fontFamily: FontFamily.bold,
      fontSize: 13,
      color: c.text,
      marginTop: 2,
    },
    dayLabelActive: { color: c.amberLo },

    segment: {
      flexDirection: 'row',
      marginHorizontal: 16,
      backgroundColor: c.glass,
      borderWidth: 0.5, borderColor: c.glassBorder,
      borderRadius: 14,
      padding: 4,
      gap: 4,
    },
    segBtn: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: 9,
      borderRadius: 10,
    },
    segBtnActive: {
      backgroundColor: c.amberSoft,
    },
    segName: {
      fontFamily: FontFamily.semibold,
      fontSize: 12.5,
      color: c.textSecondary,
    },
    segNameActive: { color: c.amberLo, fontFamily: FontFamily.bold },
    segNameDisabled: { color: c.textMuted },
    segCount: {
      fontFamily: FontFamily.semibold,
      fontSize: 9.5,
      color: c.textMuted,
      marginTop: 2,
      letterSpacing: 0.2,
    },
    segCountActive: { color: c.amberLo },

    slotsContainer: { flex: 1 },
    slotsScroll: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 16 },
    slotsGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 11,
    },
    slotBtn: {
      width: '31%',
      paddingTop: 13,
      paddingBottom: 11,
      borderRadius: 15,
      backgroundColor: c.glass,
      borderWidth: 0.5, borderColor: c.glassBorder,
      alignItems: 'center',
    },
    slotBtnActive: {
      backgroundColor: c.amberSoft,
      borderColor: c.amberLine,
    },
    slotBtnDisabled: { opacity: 0.4 },
    slotTime: {
      fontFamily: FontFamily.bold,
      fontSize: 14,
      color: c.text,
    },
    slotTimeActive: { color: c.amberLo },
    slotTimeDisabled: { color: c.textMuted },
    slotEnd: {
      fontFamily: FontFamily.regular,
      fontSize: 9.5,
      color: c.textMuted,
      marginTop: 1,
    },
    slotEndActive: { color: c.amberLo },
    meter: {
      height: 4,
      borderRadius: 3,
      backgroundColor: meterTrack,
      alignSelf: 'stretch',
      marginHorizontal: 12,
      marginTop: 9,
      marginBottom: 5,
      overflow: 'hidden',
    },
    meterFill: {
      height: '100%',
      borderRadius: 3,
    },
    capLabel: {
      fontFamily: FontFamily.semibold,
      fontSize: 9.5,
      letterSpacing: 0.3,
    },
    noSlots: {
      fontFamily: FontFamily.regular,
      fontSize: 14,
      color: c.textMuted,
      textAlign: 'center',
      marginVertical: 32,
    },

    footer: {
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderTopWidth: 0.5,
      borderTopColor: c.divider,
    },
    confirmBtn: {
      backgroundColor: c.amber,
      borderRadius: 999,
      paddingVertical: 15,
      alignItems: 'center',
    },
    confirmBtnDisabled: {
      backgroundColor: c.glassHi,
      borderWidth: 0.5,
      borderColor: c.glassBorderHi,
    },
    confirmText: {
      fontFamily: FontFamily.bold,
      fontSize: 14.5,
      color: c.ink,
      letterSpacing: 0.3,
    },
    confirmTextDisabled: { color: c.textMuted },
  });
};
