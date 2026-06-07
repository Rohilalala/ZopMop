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
import { Feather } from '@expo/vector-icons';
import { LoadingBars } from './ui/LoadingBars';
import { FontFamily } from '../theme';
import { C } from '../theme/screen';
import { Bloom } from './home/Bloom';
import { getTimeSlots, type ApiTimeSlot, type ApiSlotPeriod } from '../api/slots';

interface Props {
  visible: boolean;
  token: string;
  onClose: () => void;
  onConfirm: (slotId: string, label: string) => void;
}

const { height: SCREEN_H } = Dimensions.get('window');

// SCHEDULING_LEAD_DAYS — hard cap matches backend booking.scheduledBookingMaxLeadDays.
const SCHEDULING_LEAD_DAYS = 2;

// IST cutoff hour. Past this, today + tomorrow become non-selectable —
// only day-after slots remain so we don't drop into the stealth-instant path.
const IST_CUTOFF_HOUR = 20;

// All scheduling math runs in IST — the backend slots and the cutoff are IST.
// We shift the epoch by +5:30 and then read/write ONLY UTC fields, so the
// shifted instant's UTC calendar values equal the IST wall-clock, regardless of
// the device timezone. This avoids the drift where, before 05:30 IST, the real
// UTC date is still "yesterday" — which made the "Today" chip resolve to
// yesterday's (already-past) slots and look unbookable.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istNow(): Date {
  return new Date(Date.now() + IST_OFFSET_MS);
}

function istHour(): number {
  return istNow().getUTCHours();
}

function buildDays(): { iso: string; label: string; dayName: string; disabled: boolean }[] {
  const days = [];
  const base = istNow();
  const pastCutoff = base.getUTCHours() >= IST_CUTOFF_HOUR;
  for (let i = 0; i <= SCHEDULING_LEAD_DAYS; i++) {
    const d = new Date(base);
    d.setUTCDate(base.getUTCDate() + i);
    const iso = d.toISOString().split('T')[0];
    const dayName = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' });
    const label = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    const disabled = pastCutoff && i < 2;
    days.push({ iso, label, dayName, disabled });
  }
  return days;
}

function firstSelectableIso(days: ReturnType<typeof buildDays>): string {
  return (days.find((d) => !d.disabled) ?? days[days.length - 1]).iso;
}

export default function SchedulingModal({ visible, token, onClose, onConfirm }: Props) {
  const DAYS = React.useMemo(() => buildDays(), [visible]);
  const [selectedDay, setSelectedDay] = useState(() => firstSelectableIso(buildDays()));
  const [periods, setPeriods] = useState<ApiSlotPeriod[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<ApiTimeSlot | null>(null);

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
          <View style={s.bloomWrap} pointerEvents="none">
            <Bloom />
          </View>

          <View style={s.handle} />

          <View style={s.header}>
            <Text style={s.title}>Choose Date & Time</Text>
            <TouchableOpacity onPress={onClose} activeOpacity={0.7} style={s.closeBtn}>
              <Feather name="x" size={16} color={C.white} />
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

          <View style={s.slotsContainer}>
            {loading ? (
              <LoadingBars color={C.amber} style={{ marginVertical: 32 }} />
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
                            activeOpacity={0.78}
                            disabled={!slot.is_available}
                            onPress={() => setSelectedSlot(slot)}
                          >
                            <Text
                              style={[
                                s.slotTime,
                                active && s.slotTimeActive,
                                !slot.is_available && s.slotTimeDisabled,
                              ]}
                            >
                              {slot.start_time}
                            </Text>
                            <Text
                              style={[
                                s.slotEnd,
                                active && s.slotEndActive,
                                !slot.is_available && s.slotTimeDisabled,
                              ]}
                            >
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

          <View style={s.footer}>
            <TouchableOpacity
              style={[s.confirmBtn, !selectedSlot && s.confirmBtnDisabled]}
              activeOpacity={0.88}
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
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  sheet: {
    backgroundColor: C.bg,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    height: SCREEN_H * 0.78,
    overflow: 'hidden',
    borderTopWidth: 0.5,
    borderColor: C.glassBorderHi,
  },
  bloomWrap: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
  },
  handle: {
    width: 40, height: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.18)',
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
    borderBottomColor: C.divider,
  },
  title: {
    fontFamily: FontFamily.extrabold,
    fontSize: 18,
    color: C.white,
    letterSpacing: -0.3,
  },
  closeBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: C.glassHi,
    borderWidth: 0.5, borderColor: C.glassBorderHi,
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
    backgroundColor: C.glass,
    borderWidth: 0.5, borderColor: C.glassBorder,
    minWidth: 72,
  },
  dayChipActive: {
    backgroundColor: C.amberSoft,
    borderColor: C.amberLine,
  },
  dayChipDisabled: { opacity: 0.32 },
  dayTextDisabled: { color: C.textMuted },
  dayName: {
    fontFamily: FontFamily.semibold,
    fontSize: 11,
    color: C.textSecondary,
    letterSpacing: 0.3,
  },
  dayNameActive: { color: C.amber },
  dayLabel: {
    fontFamily: FontFamily.bold,
    fontSize: 13,
    color: C.white,
    marginTop: 2,
  },
  dayLabelActive: { color: C.amberHi },

  slotsContainer: { flex: 1 },
  slotsScroll: { paddingHorizontal: 16, paddingBottom: 16 },
  periodLabel: {
    fontFamily: FontFamily.bold,
    fontSize: 11,
    color: C.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
    marginTop: 14,
    marginBottom: 10,
    paddingHorizontal: 4,
  },
  slotsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  slotBtn: {
    width: '30%',
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: C.glass,
    borderWidth: 0.5, borderColor: C.glassBorder,
    alignItems: 'center',
  },
  slotBtnActive: {
    backgroundColor: C.amberSoft,
    borderColor: C.amberLine,
  },
  slotBtnDisabled: { opacity: 0.4 },
  slotTime: {
    fontFamily: FontFamily.bold,
    fontSize: 13,
    color: C.white,
  },
  slotTimeActive: { color: C.amberHi },
  slotTimeDisabled: { color: C.textMuted },
  slotEnd: {
    fontFamily: FontFamily.regular,
    fontSize: 10,
    color: C.textMuted,
    marginTop: 1,
  },
  slotEndActive: { color: C.amber },
  slotFull: {
    fontFamily: FontFamily.semibold,
    fontSize: 9,
    color: C.danger,
    marginTop: 2,
    letterSpacing: 0.4,
  },
  noSlots: {
    fontFamily: FontFamily.regular,
    fontSize: 14,
    color: C.textMuted,
    textAlign: 'center',
    marginVertical: 32,
  },

  footer: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopWidth: 0.5,
    borderTopColor: C.divider,
  },
  confirmBtn: {
    backgroundColor: C.amber,
    borderRadius: 999,
    paddingVertical: 15,
    alignItems: 'center',
  },
  confirmBtnDisabled: {
    backgroundColor: C.glassHi,
    borderWidth: 0.5,
    borderColor: C.glassBorderHi,
  },
  confirmText: {
    fontFamily: FontFamily.bold,
    fontSize: 14.5,
    color: C.ink,
    letterSpacing: 0.3,
  },
});
