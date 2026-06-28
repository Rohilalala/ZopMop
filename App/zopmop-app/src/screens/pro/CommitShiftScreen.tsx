import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Modal,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Feather } from '@expo/vector-icons';

import type { MainStackParamList } from '../../types/navigation';
import { FontFamily, FontSize, Radius, Spacing } from '../../theme';
import { useColors } from '../../context/ThemeContext';
import { showError, showInfo } from '../../utils/toast';
import { friendlyError } from '../../utils/errors';
import {
  listCommitments,
  createCommitment,
  deleteCommitment,
  type Commitment,
} from '../../api/shifts';
import { useProRoleGate } from '../../hooks/useRoleGate';
import { t, useLocale } from '../../i18n';

// 30-min increments, 24h day → 48 slots.
function buildTimeSlots(): string[] {
  const out: string[] = [];
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 30]) {
      out.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }
  return out;
}
const TIME_SLOTS = buildTimeSlots();

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function fmtDayLabel(d: Date, today: Date, tomorrow: Date): string {
  if (ymd(d) === ymd(today)) return t('commit.today');
  if (ymd(d) === ymd(tomorrow)) return t('commit.tomorrow');
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function hoursBetween(start: string, end: string): number {
  const [sh, sm] = start.split(':').map((n) => parseInt(n, 10));
  const [eh, em] = end.split(':').map((n) => parseInt(n, 10));
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins <= 0) mins += 24 * 60;
  return Math.round((mins / 60) * 10) / 10;
}

// Same-day duration in minutes WITHOUT the midnight wrap. The backend
// rejects any shift where end <= start (no overnight support), so the
// picker must validate against the same rule — otherwise 22:00→02:00
// previewed a bogus "4h" and got a confusing 409 on save.
function sameDayMinutes(start: string, end: string): number {
  const [sh, sm] = start.split(':').map((n) => parseInt(n, 10));
  const [eh, em] = end.split(':').map((n) => parseInt(n, 10));
  return (eh * 60 + em) - (sh * 60 + sm);
}

function isEditableForDate(dateYMD: string): boolean {
  // Day D is editable until 03:00 (local IST) on day D itself.
  const [y, m, d] = dateYMD.split('-').map((n) => parseInt(n, 10));
  const lock = new Date(y, m - 1, d, 3, 0, 0, 0);
  return new Date() < lock;
}

export default function CommitShiftScreen() {
  useLocale(); // live-update strings on language change
  useProRoleGate();
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const c = useColors();
  const styles = useMemo(() => createStyles(c), [c]);

  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [loading, setLoading] = useState(true);
  const [picker, setPicker] = useState<{ date: string } | null>(null);
  const [pickerStart, setPickerStart] = useState('09:00');
  const [pickerEnd, setPickerEnd] = useState('17:00');
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setCommitments(await listCommitments());
    } catch (e: any) {
      showError(friendlyError(e, 'Couldn’t load your shifts. Pull to refresh or try again.'));
    } finally {
      setLoading(false);
    }
  }, []);

  // Date anchors live in state, not useMemo([]), so they recompute when
  // the screen regains focus — otherwise the 14-day grid froze at the
  // mount day and showed the wrong "today"/"tomorrow" across a midnight
  // boundary (and the commitment list went stale).
  const computeAnchors = useCallback(() => {
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    const out: Date[] = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      out.push(d);
    }
    const tmrw = new Date(base);
    tmrw.setDate(base.getDate() + 1);
    return { days: out, today: new Date(), tomorrow: tmrw };
  }, []);

  const [{ days, today, tomorrow }, setAnchors] = useState(computeAnchors);

  // Refetch commitments + recompute anchors on every focus.
  useFocusEffect(
    useCallback(() => {
      setAnchors(computeAnchors());
      refresh();
    }, [computeAnchors, refresh]),
  );

  // Total committed hours across all listed commitments (rough fortnight view).
  const fortnightHours = useMemo(() => {
    return commitments.reduce((sum, c) => sum + hoursBetween(c.start_time, c.end_time), 0);
  }, [commitments]);

  function openPicker(dateYMD: string) {
    setPicker({ date: dateYMD });
    setPickerStart('09:00');
    setPickerEnd('17:00');
  }

  async function save() {
    if (!picker) return;
    // End must be strictly after start on the same day — no overnight
    // wrap (the backend rejects end <= start).
    if (sameDayMinutes(pickerStart, pickerEnd) <= 0) {
      showError(t('commit.endBeforeStart'));
      return;
    }
    setSaving(true);
    try {
      await createCommitment({ shift_date: picker.date, start_time: pickerStart, end_time: pickerEnd });
      setPicker(null);
      await refresh();
    } catch (e: any) {
      // A 409 means the shift clashes with an existing one or falls outside
      // the editable window — point the pro at picking a different time.
      if (e?.status === 409) {
        showError(friendlyError(e, 'That shift overlaps another one or is no longer editable. Please pick a different time.'));
      } else {
        showError(friendlyError(e, 'Couldn’t save your shift. Please try again.'));
      }
    } finally {
      setSaving(false);
    }
  }

  function confirmDelete(c: Commitment) {
    Alert.alert(
      t('commit.deleteConfirm'),
      `${c.shift_date}  ${c.start_time}–${c.end_time}`,
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteCommitment(c.id);
              await refresh();
            } catch (e: any) {
              showError(friendlyError(e, 'Couldn’t remove this shift. Please try again.'));
            }
          },
        },
      ],
    );
  }

  // Preview uses the non-wrap duration so an invalid overnight selection
  // shows 0/negative (and the Save guard catches it) instead of a bogus
  // wrapped value.
  const previewMinutes = picker ? sameDayMinutes(pickerStart, pickerEnd) : 0;
  const previewHours = Math.max(0, Math.round((previewMinutes / 60) * 10) / 10);
  const showOverWarning = previewHours > 8;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.background }]} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Feather name="arrow-left" size={22} color={c.text} />
        </TouchableOpacity>
        <Text style={styles.title}>{t('commit.title')}</Text>
        <View style={{ width: 22 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.summaryCard}>
          <Text style={styles.summaryText}>
            {t('commit.fortnightLine', { hours: Math.round(fortnightHours * 10) / 10 })}
          </Text>
        </View>

        {loading && <ActivityIndicator color={c.accent} style={{ marginTop: Spacing.lg }} />}

        {!loading && days.map((d) => {
          const dateYMD = ymd(d);
          const existing = commitments.find((c) => c.shift_date === dateYMD);
          const editable = isEditableForDate(dateYMD);
          const label = fmtDayLabel(d, today, tomorrow);

          if (existing && editable) {
            return (
              <View key={dateYMD} style={styles.dayRow}>
                <View style={styles.dayLabelCol}>
                  <Text style={styles.dayLabel}>{label}</Text>
                  <Text style={styles.dayDate}>{dateYMD}</Text>
                </View>
                <View style={styles.dayCenterCol}>
                  <Text style={styles.shiftTimes}>{existing.start_time}–{existing.end_time}</Text>
                  <Text style={styles.shiftHours}>
                    {hoursBetween(existing.start_time, existing.end_time)}h
                  </Text>
                </View>
                <TouchableOpacity onPress={() => confirmDelete(existing)} style={styles.iconBtn}>
                  <Feather name="trash-2" size={18} color={c.danger} />
                </TouchableOpacity>
              </View>
            );
          }

          if (existing) {
            return (
              <View key={dateYMD} style={[styles.dayRow, styles.locked]}>
                <View style={styles.dayLabelCol}>
                  <Text style={[styles.dayLabel, styles.lockedText]}>{label}</Text>
                  <Text style={styles.dayDate}>{dateYMD}</Text>
                </View>
                <View style={styles.dayCenterCol}>
                  <Text style={[styles.shiftTimes, styles.lockedText]}>
                    {existing.start_time}–{existing.end_time}
                  </Text>
                  <Text style={[styles.shiftHours, styles.lockedText]}>{t('commit.locked')}</Text>
                </View>
                <Feather name="lock" size={16} color={c.textMuted} />
              </View>
            );
          }

          if (editable) {
            return (
              <TouchableOpacity
                key={dateYMD}
                style={styles.dayRow}
                onPress={() => openPicker(dateYMD)}
              >
                <View style={styles.dayLabelCol}>
                  <Text style={styles.dayLabel}>{label}</Text>
                  <Text style={styles.dayDate}>{dateYMD}</Text>
                </View>
                <Text style={styles.addText}>{t('commit.addShift')}</Text>
              </TouchableOpacity>
            );
          }

          return (
            <View key={dateYMD} style={[styles.dayRow, styles.locked]}>
              <View style={styles.dayLabelCol}>
                <Text style={[styles.dayLabel, styles.lockedText]}>{label}</Text>
                <Text style={styles.dayDate}>{dateYMD}</Text>
              </View>
              <Text style={styles.lockedText}>—</Text>
            </View>
          );
        })}
      </ScrollView>

      <Modal
        transparent
        visible={!!picker}
        animationType="slide"
        onRequestClose={() => setPicker(null)}
      >
        <View style={styles.sheetBackdrop}>
          <View style={[styles.sheet, { backgroundColor: c.surface }]}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>{picker?.date}</Text>
            <View style={styles.pickerRow}>
              <TimePickerColumn
                label={t('commit.pickStart')}
                value={pickerStart}
                onChange={setPickerStart}
                colors={c}
              />
              <TimePickerColumn
                label={t('commit.pickEnd')}
                value={pickerEnd}
                onChange={setPickerEnd}
                colors={c}
              />
            </View>
            <Text style={styles.estLine}>
              {t('commit.estimatedHours', { h: Math.round(previewHours * 10) / 10 })}
            </Text>
            {showOverWarning && (
              <View style={styles.warnBox}>
                <Text style={styles.warnText}>{t('commit.eightHourWarning')}</Text>
              </View>
            )}
            <View style={styles.sheetActions}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setPicker(null)}>
                <Text style={styles.cancelBtnText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.saveBtn, saving && { opacity: 0.5 }]}
                disabled={saving}
                onPress={save}
              >
                <Text style={styles.saveBtnText}>{t('commit.save')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function TimePickerColumn({
  label,
  value,
  onChange,
  colors,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={{ flex: 1, alignItems: 'center' }}>
      <Text style={{ color: colors.textSecondary, fontFamily: FontFamily.medium, fontSize: FontSize.sm }}>{label}</Text>
      <ScrollView style={{ height: 180 }} contentContainerStyle={{ paddingVertical: 8 }}>
        {TIME_SLOTS.map((slot) => (
          <TouchableOpacity
            key={slot}
            onPress={() => onChange(slot)}
            style={{
              paddingHorizontal: 16,
              paddingVertical: 8,
              backgroundColor: slot === value ? colors.accent : 'transparent',
              borderRadius: Radius.md,
              marginVertical: 1,
            }}
          >
            <Text style={{
              color: slot === value ? '#1a1a1a' : colors.text,
              fontFamily: slot === value ? FontFamily.bold : FontFamily.regular,
              fontSize: FontSize.base,
            }}>{slot}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

function createStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    safe: { flex: 1 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: Spacing.base,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    backBtn: { padding: 4 },
    title: { fontFamily: FontFamily.bold, fontSize: FontSize.lg, color: c.text },
    scroll: { padding: Spacing.lg, gap: Spacing.sm, paddingBottom: Spacing['3xl'] },
    summaryCard: {
      backgroundColor: c.surface,
      borderRadius: Radius.lg,
      padding: Spacing.base,
      borderWidth: 1,
      borderColor: c.border,
      marginBottom: Spacing.base,
    },
    summaryText: { fontFamily: FontFamily.semibold, fontSize: FontSize.base, color: c.text },
    dayRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Spacing.base,
      padding: Spacing.base,
      borderRadius: Radius.md,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
    },
    locked: { opacity: 0.6 },
    dayLabelCol: { flex: 1.2 },
    dayCenterCol: { flex: 1, alignItems: 'flex-end' },
    dayLabel: { fontFamily: FontFamily.semibold, fontSize: FontSize.base, color: c.text },
    dayDate: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: c.textSecondary },
    shiftTimes: { fontFamily: FontFamily.semibold, fontSize: FontSize.base, color: c.text },
    shiftHours: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: c.textSecondary },
    lockedText: { color: c.textMuted },
    addText: { fontFamily: FontFamily.semibold, fontSize: FontSize.base, color: c.accent, flex: 1, textAlign: 'right' },
    iconBtn: { padding: 4 },
    sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
    sheet: {
      padding: Spacing.lg, borderTopLeftRadius: Radius.xl, borderTopRightRadius: Radius.xl, gap: Spacing.base,
    },
    sheetHandle: { width: 40, height: 4, backgroundColor: c.border, alignSelf: 'center', borderRadius: 2 },
    sheetTitle: { fontFamily: FontFamily.bold, fontSize: FontSize.xl, color: c.text, textAlign: 'center' },
    pickerRow: { flexDirection: 'row', gap: Spacing.base },
    estLine: { fontFamily: FontFamily.medium, fontSize: FontSize.base, color: c.text, textAlign: 'center' },
    warnBox: { backgroundColor: c.warningBg, borderRadius: Radius.md, padding: Spacing.sm },
    warnText: { fontFamily: FontFamily.medium, fontSize: FontSize.sm, color: c.warning, textAlign: 'center' },
    sheetActions: { flexDirection: 'row', gap: Spacing.base },
    cancelBtn: {
      flex: 1, paddingVertical: Spacing.base, alignItems: 'center',
      borderWidth: 1, borderColor: c.border, borderRadius: Radius.lg,
    },
    cancelBtnText: { fontFamily: FontFamily.semibold, fontSize: FontSize.base, color: c.text },
    saveBtn: {
      flex: 1, paddingVertical: Spacing.base, alignItems: 'center',
      backgroundColor: c.accent, borderRadius: Radius.lg,
    },
    saveBtnText: { fontFamily: FontFamily.bold, fontSize: FontSize.base, color: '#1a1a1a' },
  });
}
