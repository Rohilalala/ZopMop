import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Linking,
  Platform,
  ActivityIndicator,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Feather } from '@expo/vector-icons';
import MapView, { Marker } from 'react-native-maps';

import type { MainStackParamList } from '../../types/navigation';
import { FontFamily, FontSize, Radius, Spacing } from '../../theme';
import { useColors } from '../../context/ThemeContext';
import { showError } from '../../utils/toast';
import { requestZoneApproval } from '../../api/shifts';
import { captureSelfieForApproval, type CapturedPhoto } from '../../utils/photoCapture';
import { useProRoleGate } from '../../hooks/useRoleGate';
import { t, useLocale } from '../../i18n';

const SUPPORT_PHONE = process.env.EXPO_PUBLIC_SUPPORT_PHONE ?? '+918000000000';

export default function ZoneApprovalRequestScreen() {
  useLocale(); // live-update strings on language change
  useProRoleGate();
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const route = useRoute<RouteProp<MainStackParamList, 'ZoneApprovalRequest'>>();
  const c = useColors();
  const styles = useMemo(() => createStyles(c), [c]);

  const { commitment_id, current_lat, current_lng, distance_meters } = route.params;
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function capture() {
    if (capturing) return;
    setCapturing(true);
    try {
      const result = await captureSelfieForApproval();
      if (result) setPhoto(result);
    } catch (e: any) {
      if (__DEV__) console.warn('[ZoneApproval] capture:', e);
      showError(t('zoneApproval.submitFailed'));
    } finally {
      setCapturing(false);
    }
  }

  async function submit() {
    if (submitting) return;
    if (!photo) {
      showError(t('zoneApproval.photoRequired'));
      return;
    }
    setSubmitting(true);
    try {
      await requestZoneApproval(commitment_id, {
        lat: current_lat,
        lng: current_lng,
        photo_url: photo.dataUrl,
      });
      setSubmitted(true);
    } catch (e: any) {
      showError(e?.message ?? t('zoneApproval.submitFailed'));
    } finally {
      setSubmitting(false);
    }
  }

  function callSupport() {
    const tel = `tel:${SUPPORT_PHONE}`;
    Linking.canOpenURL(tel).then((ok) => {
      if (ok) Linking.openURL(tel);
      else showError(`${tel}`);
    });
  }

  if (submitted) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: c.background }]} edges={['top']}>
        <View style={styles.waitWrap}>
          <Feather name="clock" size={48} color={c.accent} />
          <Text style={styles.waitTitle}>{t('zoneApproval.waiting')}</Text>
          <Text style={styles.waitBody}>{t('zoneApproval.waitingBody')}</Text>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() => navigation.navigate('Pro', { screen: 'ProHome' })}
          >
            <Text style={styles.primaryBtnText}>{t('zoneApproval.backToDashboard')}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.background }]} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Feather name="arrow-left" size={22} color={c.text} />
        </TouchableOpacity>
        <Text style={styles.title}>{t('zoneApproval.title')}</Text>
        <View style={{ width: 22 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.distance}>
          {t('zoneApproval.distanceLine', { meters: Math.round(distance_meters) })}
        </Text>

        <View style={styles.mapWrap}>
          <MapView
            style={styles.map}
            initialRegion={{
              latitude: current_lat,
              longitude: current_lng,
              latitudeDelta: 0.05,
              longitudeDelta: 0.05,
            }}
            pointerEvents="none"
          >
            <Marker
              coordinate={{ latitude: current_lat, longitude: current_lng }}
              title="You"
              pinColor={Platform.OS === 'android' ? 'red' : undefined}
            />
          </MapView>
        </View>

        <TouchableOpacity style={styles.optionCard} onPress={callSupport}>
          <Feather name="phone" size={20} color={c.accent} />
          <Text style={styles.optionText}>{t('zoneApproval.callSupport')}</Text>
        </TouchableOpacity>

        {photo && (
          <View style={styles.previewWrap}>
            <Image source={{ uri: photo.uri }} style={styles.preview} resizeMode="cover" />
            <TouchableOpacity style={styles.retakeBtn} onPress={capture}>
              <Feather name="refresh-ccw" size={14} color={c.text} />
              <Text style={styles.retakeText}>{t('zoneApproval.captureSelfie')}</Text>
            </TouchableOpacity>
          </View>
        )}

        {!photo ? (
          <TouchableOpacity
            style={[styles.optionCard, styles.primaryOption, capturing && styles.disabled]}
            onPress={capture}
            disabled={capturing}
          >
            {capturing ? (
              <ActivityIndicator color="#1a1a1a" />
            ) : (
              <>
                <Feather name="camera" size={20} color="#1a1a1a" />
                <Text style={styles.primaryOptionText}>{t('zoneApproval.uploadPhoto')}</Text>
              </>
            )}
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.optionCard, styles.primaryOption, submitting && styles.disabled]}
            onPress={submit}
            disabled={submitting}
          >
            {submitting ? (
              <ActivityIndicator color="#1a1a1a" />
            ) : (
              <>
                <Feather name="send" size={20} color="#1a1a1a" />
                <Text style={styles.primaryOptionText}>{t('zoneApproval.submit')}</Text>
              </>
            )}
          </TouchableOpacity>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    safe: { flex: 1 },
    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      padding: Spacing.base, borderBottomWidth: 1, borderBottomColor: c.border,
    },
    backBtn: { padding: 4 },
    title: { fontFamily: FontFamily.bold, fontSize: FontSize.lg, color: c.text },
    scroll: { padding: Spacing.lg, gap: Spacing.lg },
    distance: { fontFamily: FontFamily.semibold, fontSize: FontSize.base, color: c.warning, textAlign: 'center' },
    mapWrap: { borderRadius: Radius.lg, overflow: 'hidden', height: 220, borderWidth: 1, borderColor: c.border },
    map: { flex: 1 },
    optionCard: {
      flexDirection: 'row', alignItems: 'center', gap: Spacing.base,
      padding: Spacing.lg, borderRadius: Radius.lg,
      backgroundColor: c.surface, borderWidth: 1, borderColor: c.border,
    },
    optionText: { fontFamily: FontFamily.semibold, fontSize: FontSize.base, color: c.text },
    primaryOption: { backgroundColor: c.accent, borderColor: c.accent, justifyContent: 'center' },
    primaryOptionText: { fontFamily: FontFamily.bold, fontSize: FontSize.base, color: '#1a1a1a' },
    disabled: { opacity: 0.6 },
    previewWrap: { alignItems: 'center', gap: Spacing.sm },
    preview: {
      width: '100%', aspectRatio: 1, borderRadius: Radius.lg,
      borderWidth: 1, borderColor: c.border, backgroundColor: c.surface,
    },
    retakeBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      paddingHorizontal: Spacing.base, paddingVertical: Spacing.sm,
      borderWidth: 1, borderColor: c.border, borderRadius: Radius.full,
    },
    retakeText: { fontFamily: FontFamily.medium, fontSize: FontSize.sm, color: c.text },
    waitWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.lg, gap: Spacing.base },
    waitTitle: { fontFamily: FontFamily.bold, fontSize: FontSize.xl, color: c.text, textAlign: 'center' },
    waitBody: { fontFamily: FontFamily.regular, fontSize: FontSize.base, color: c.textSecondary, textAlign: 'center' },
    primaryBtn: { backgroundColor: c.accent, paddingHorizontal: Spacing.xl, paddingVertical: Spacing.base, borderRadius: Radius.lg },
    primaryBtnText: { fontFamily: FontFamily.bold, fontSize: FontSize.base, color: '#1a1a1a' },
  });
}
