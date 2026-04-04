import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Dimensions,
} from 'react-native';
import { Colors, FontFamily, FontSize, Radius, Shadow } from '../theme';
import { getTimeSlots, type ApiTimeSlot } from '../api/slots';

interface Props {
  visible: boolean;
  token: string;
  onClose: () => void;
  onConfirm: (slotId: string, label: string) => void;
}

const { height: SCREEN_H } = Dimensions.get('window');

// Generate the next 7 days from today
function buildDays(): { iso: string; label: string; dayName: string }[] {
  const days = [];
  const now = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    const iso = d.toISOString().split('T')[0];
    const dayName = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString('en-IN', { weekday: 'short' });
    const label = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    days.push({ iso, label, dayName });
  }
  return days;
}

const DAYS = buildDays();

export default function SchedulingModal({ visible, token, onClose, onConfirm }: Props) {
  const [selectedDay, setSelectedDay] = useState(DAYS[0].iso);
  const [slots, setSlots] = useState<ApiTimeSlot[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<ApiTimeSlot | null>(null);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    setSelectedSlot(null);
    getTimeSlots(token, selectedDay)
      .then(data => { if (!cancelled) setSlots(data); })
      .catch(() => { if (!cancelled) setSlots([]); })
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
      <TouchableOpacity style={s.backdrop} activeOpacity={1} onPress={onClose} />

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
          contentContainerStyle={s.dateStrip}
        >
          {DAYS.map(day => {
            const active = day.iso === selectedDay;
            return (
              <TouchableOpacity
                key={day.iso}
                style={[s.dayChip, active && s.dayChipActive]}
                activeOpacity={0.7}
                onPress={() => setSelectedDay(day.iso)}
              >
                <Text style={[s.dayName, active && s.dayNameActive]}>{day.dayName}</Text>
                <Text style={[s.dayLabel, active && s.dayLabelActive]}>{day.label}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {/* Slots grid */}
        <View style={s.slotsContainer}>
          {loading ? (
            <ActivityIndicator color={Colors.primary} style={{ marginVertical: 32 }} />
          ) : slots.length === 0 ? (
            <Text style={s.noSlots}>No slots available for this date</Text>
          ) : (
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={s.slotsGrid}>
              {slots.map(slot => {
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
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: Colors.white,
    borderTopLeftRadius: Radius['2xl'],
    borderTopRightRadius: Radius['2xl'],
    maxHeight: SCREEN_H * 0.85,
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

  dateStrip: {
    paddingHorizontal: 16, paddingVertical: 16, gap: 10,
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
  dayName: { fontFamily: FontFamily.semibold, fontSize: FontSize.xs, color: Colors.textSecondary },
  dayNameActive: { color: Colors.white },
  dayLabel: { fontFamily: FontFamily.bold, fontSize: FontSize.sm, color: Colors.text, marginTop: 2 },
  dayLabelActive: { color: Colors.white },

  slotsContainer: { flex: 1, minHeight: 160 },
  slotsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 16,
    paddingBottom: 16,
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
