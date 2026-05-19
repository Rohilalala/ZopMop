// Full-screen interrupt that fires when the pro drifts outside their
// assigned zone mid-shift. Wired via the shiftEvents bus; the backend
// drift-scan cron emits `zone_drift_warning` data pushes once the
// cron stub lands. Mounted at the MainNavigator root so it stays
// visible across stack pushes.

import React, { useEffect, useState } from 'react';
import { View, Text, Modal, TouchableOpacity, StyleSheet } from 'react-native';

import { onShiftEvent } from '../utils/shiftEvents';
import { useColors } from '../context/ThemeContext';
import { FontFamily, FontSize, Radius, Spacing } from '../theme';
import { t } from '../i18n';

export default function ZoneDriftOverlay() {
  const c = useColors();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const unsub = onShiftEvent((ev) => {
      if (ev.type === 'zone_drift_warning') setVisible(true);
    });
    return unsub;
  }, []);

  if (!visible) return null;

  return (
    <Modal transparent visible animationType="fade" onRequestClose={() => setVisible(false)}>
      <View style={styles.backdrop}>
        <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.warning }]}>
          <Text style={[styles.title, { color: c.warning }]}>{t('drift.title')}</Text>
          <Text style={[styles.body, { color: c.text }]}>{t('drift.body')}</Text>
          <TouchableOpacity
            style={[styles.btn, { backgroundColor: c.accent }]}
            onPress={() => setVisible(false)}
          >
            <Text style={styles.btnText}>{t('drift.acknowledge')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', alignItems: 'center', justifyContent: 'center', padding: Spacing.lg },
  card: { width: '100%', maxWidth: 400, padding: Spacing.xl, borderRadius: Radius.xl, gap: Spacing.lg, borderWidth: 2, alignItems: 'center' },
  title: { fontFamily: FontFamily.bold, fontSize: FontSize.xl, textAlign: 'center' },
  body: { fontFamily: FontFamily.regular, fontSize: FontSize.base, textAlign: 'center', lineHeight: 22 },
  btn: { paddingHorizontal: Spacing.xl, paddingVertical: Spacing.base, borderRadius: Radius.lg, minWidth: 200, alignItems: 'center' },
  btnText: { fontFamily: FontFamily.bold, fontSize: FontSize.base, color: '#1a1a1a' },
});
