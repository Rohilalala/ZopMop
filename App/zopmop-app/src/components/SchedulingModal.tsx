import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  
  Dimensions,
} from 'react-native';
import { LoadingBars } from './ui/LoadingBars';
import { Colors, FontFamily, FontSize, Radius, Shadow } from '../theme';
import { getTimeSlots, type ApiTimeSlot, type ApiSlotPeriod } from '../api/slots';

interface Props {
  visible: boolean;
  token: string;
  onClose: () => void;
  onConfirm: (slotId: string, label: string) => void;
}

const { height: SCREEN_H } = Dimensions.get('window');

// SCHEDULING_LEAD_DAYS — hard cap matches backend booking.scheduledBookingMaxLeadDays.
// Customer can pick today, tomorrow, or day-after-tomorrow. Anything beyond is
// rejected by classifyScheduling with ErrSlotTooFar.
const SCHEDULING_LEAD_DAYS = 2;

// IST cutoff hour. Past this (device-time-IST), today + tomorrow become
// non-selectable — the booking would land in the stealth-instant path,
// which we keep transparent to the customer by only offering day-after slots.
const IST_CUTOFF_HOUR = 20; // 8pm IST

// istHour returns the current hour-of-day in India (0-23). Computed off
// UTC + 5h30 so the device's own tz doesn't confuse the cutoff.
function istHour(): number {
  const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return istNow.getUTCHours();
}

// Build the selectable date list. Capped at SCHEDULING_LEAD_DAYS + 1 entries
// (today through today+lead). disabled flag honours the 8pm IST cutoff —
// today + tomorrow flip to disabled past cutoff so only day-after-tomorrow
// remains selectable.
function buildDays(): { iso: string; label: string; dayName: string; disabled: boolean }[] {
  const days = [];
  const now = new Date();
  const pastCutoff = istHour() >= IST_CUTOFF_HOUR;
  for (let i = 0; i <= SCHEDULING_LEAD_DAYS; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    const iso = d.toISOString().split('T')[0];
    const dayName = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString('en-IN', { weekday: 'short' });
    const label = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    // Past cutoff: disable today + tomorrow. Day-after-tomorrow stays open.
    const disabled = pastCutoff && i < 2;
    days.push({ iso, label, dayName, disabled });
  }
  return days;
}

// firstSelectableIso picks the earliest non-disabled day for the default
// selection — defaults to the last day in the list when everything's
// disabled (defensive; current rules guarantee at least day-after stays
// open).
function firstSelectableIso(days: ReturnType<typeof buildDays>): string {
  return (days.find((d) => !d.disabled) ?? days[days.length - 1]).iso;
}

export default function SchedulingModal({ visible, token, onClose, onConfirm }: Props) {
  // Recompute every time the modal opens so dates are never stale past
  // midnight or past the 8pm IST cutoff (which moves selectable days).
  const DAYS = React.useMemo(() => buildDays(), [visible]);
  const [selectedDay, setSelectedDay] = useState(() => firstSelectableIso(buildDays()));
  const [periods, setPeriods] = useState<ApiSlotPeriod[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<ApiTimeSlot | null>(null);

  // Sync selectedDay to the earliest still-selectable day on open.
  useEffect(() => {
    if (visible) setSelectedDay(firstSelectableIso(DAYS));
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    setSelectedSlot(null);
    getTimeSlots(token, selectedDay)
      .then(data => { if (!cancelled) setPeriods(data); })
      .catch(() => { if (!cancelled) setPeriods([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [visible, selectedDay, token]);

  const handleConfirm = useCallback(() => {
    if (!selectedSlot) return;
    const day = DAYS.find(d => d.iso === selectedDay);
    const label = `${day?.dayName ?? selectedDay}, ${selectedSlot.start_time} – ${selectedSlot.end_time}`;
    onConfirm(selectedSlot.id, label);
  }, [selectedSlot, selectedDay, onConfirm]);

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
        {/* Handle */}
        <View style={s.handle} />

        {/* Header */}
        <View style={s.header}>
          <Text style={s.title}>Choose Date & Time</Text>
          <TouchableOpacity onPress={onClose} activeOpacity={0.7} style={s.closeBtn}>
            <Text style={s.closeText}>✕</Text>
          </TouchableOpacity>
        </View>

        {/* Date strip */}
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
                activeOpacity={0.7}
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

        {/* Slots — grouped by period */}
        <View style={s.slotsContainer}>
          {loading ? (
            <LoadingBars color={Colors.primary} style={{ marginVertical: 32 }} />
          ) : periods.length === 0 ? (
            <Text style={s.noSlots}>No slots available for this date</Text>
          ) : (
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={s.slotsScroll}>
              {periods.map(period => (
                <View key={period.label}>
                  <Text style={s.periodLabel}>{period.label}</Text>
                  <View style={s.slotsGrid}>
                    {period.slots.map(slot => {
                      const active = selectedSlot?.id === slot.id;
                      return (
                        <TouchableOpacity
                          key={slot.id}
                          style={[
                            s.slotBtn,
                            active && s.slotBtnActive,
                            !slot.is_available && s.slotBtnDisabled,
                          ]}
                          activeOpacity={0.75}
                          disabled={!slot.is_available}
                          onPress={() => setSelectedSlot(slot)}
                        >
                          <Text style={[s.slotTime, active && s.slotTimeActive, !slot.is_available && s.slotTimeDisabled]}>
                            {slot.start_time}
                          </Text>
                          <Text style={[s.slotEnd, active && s.slotEndActive, !slot.is_available && s.slotTimeDisabled]}>
                            – {slot.end_time}
                          </Text>
                          {!slot.is_available && (
                            <Text style={s.slotFull}>Full</Text>
                          )}
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              ))}
            </ScrollView>
          )}
        </View>

        {/* Confirm */}
        <View style={s.footer}>
          <TouchableOpacity
            style={[s.confirmBtn, !selectedSlot && s.confirmBtnDisabled]}
            activeOpacity={0.85}
            disabled={!selectedSlot}
            onPress={handleConfirm}
          >
            <Text style={s.confirmText}>
              {selectedSlot ? `Confirm – ${selectedSlot.start_time}` : 'Select a time slot'}
            </Text>
          </TouchableOpacity>
        </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    backgroundColor: Colors.white,
    borderTopLeftRadius: Radius['2xl'],
    borderTopRightRadius: Radius['2xl'],
    height: SCREEN_H * 0.78,
    ...Shadow.lg,
  },
  handle: {
    width: 40, height: 4,
    borderRadius: Radius.full,
    backgroundColor: Colors.border,
    alignSelf: 'center',
    marginTop: 10, marginBottom: 4,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  title: { fontFamily: FontFamily.bold, fontSize: FontSize.lg, color: Colors.text },
  closeBtn: {
    width: 32, height: 32, borderRadius: Radius.full,
    backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center',
  },
  closeText: { fontSize: 14, color: Colors.textSecondary, fontFamily: FontFamily.semibold },

  dateScrollView: {
    flexGrow: 0,
    flexShrink: 0,
  },
  dateStrip: {
    paddingHorizontal: 16, paddingVertical: 12, gap: 10,
    alignItems: 'center',
  },
  dayChip: {
    alignItems: 'center',
    paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: Radius.xl,
    backgroundColor: Colors.surface,
    borderWidth: 1.5, borderColor: Colors.border,
    minWidth: 68,
  },
  dayChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  dayChipDisabled: { opacity: 0.32, backgroundColor: 'transparent' },
  dayTextDisabled: { color: Colors.textMuted ?? 'rgba(0,0,0,0.4)' },
  dayName: { fontFamily: FontFamily.semibold, fontSize: FontSize.xs, color: Colors.textSecondary },
  dayNameActive: { color: Colors.white },
  dayLabel: { fontFamily: FontFamily.bold, fontSize: FontSize.sm, color: Colors.text, marginTop: 2 },
  dayLabelActive: { color: Colors.white },

  slotsContainer: { flex: 1 },
  slotsScroll: { paddingHorizontal: 16, paddingBottom: 16 },
  periodLabel: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 14,
    marginBottom: 8,
  },
  slotsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  slotBtn: {
    width: '30%',
    paddingVertical: 12,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1.5, borderColor: Colors.border,
    alignItems: 'center',
  },
  slotBtnActive: { backgroundColor: Colors.primaryBg, borderColor: Colors.primary },
  slotBtnDisabled: { opacity: 0.45 },
  slotTime: { fontFamily: FontFamily.bold, fontSize: FontSize.sm, color: Colors.text },
  slotTimeActive: { color: Colors.primary },
  slotTimeDisabled: { color: Colors.textMuted },
  slotEnd: { fontFamily: FontFamily.regular, fontSize: 10, color: Colors.textMuted, marginTop: 1 },
  slotEndActive: { color: Colors.primary },
  slotFull: { fontFamily: FontFamily.semibold, fontSize: 9, color: Colors.danger, marginTop: 2 },
  noSlots: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    textAlign: 'center',
    marginVertical: 32,
  },

  footer: { paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1, borderTopColor: Colors.border },
  confirmBtn: {
    backgroundColor: Colors.primary,
    borderRadius: Radius.xl,
    paddingVertical: 14,
    alignItems: 'center',
    ...Shadow.sm,
  },
  confirmBtnDisabled: { opacity: 0.45 },
  confirmText: { fontFamily: FontFamily.semibold, fontSize: FontSize.base, color: Colors.white },
});
