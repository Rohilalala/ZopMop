import React from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  StatusBar,
  Linking,
  Platform,
  type TextStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ScatterBg } from './BackendDownScreen';
import ZopSurprised from '../../assets/zop/zop-surprised.svg';
import type { ForceUpdateInfo } from '../api/client';

// Same visual shell as BackendDownScreen ("Zop's down") — dark bg + dimmed Zop
// scatter + a bright vignetted Zop, branded title/body, pill button. Only the
// copy, mascot expression, and CTA (amber → store) differ.

const fontSemi: TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };
const fontBold: TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };
const ZOP_SIZE = 200;

// Last-resort store target when the admin hasn't set a URL in the CRM. Android
// package is known; iOS has no numeric App Store id until published.
const FALLBACK_STORE = Platform.select({
  ios: 'https://apps.apple.com/app/zopmop',
  android: 'https://play.google.com/store/apps/details?id=com.zopmop.app',
  default: 'https://zopmop.com',
}) as string;

type Props = {
  info: ForceUpdateInfo;
  /** Hard block (true) hides "Later"; soft prompt (false) shows it. */
  force: boolean;
  onLater?: () => void;
};

export default function UpdateRequiredScreen({ info, force, onLater }: Props) {
  const insets = useSafeAreaInsets();

  const openStore = () => {
    const url = info.store_url && info.store_url.trim() ? info.store_url.trim() : FALLBACK_STORE;
    Linking.openURL(url).catch(() => {});
  };

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" />
      <ScatterBg />

      <View style={[styles.center, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.zopWrap}>
          <ZopSurprised width={ZOP_SIZE} height={ZOP_SIZE} />
        </View>

        <Text style={[fontExtra, styles.title]}>
          {force ? 'Update required' : 'Update available'}
        </Text>
        <Text style={[fontSemi, styles.body]}>
          {info.message && info.message.trim()
            ? info.message.trim()
            : force
            ? "This version of ZopMop is no longer supported.\nUpdate to keep going."
            : "A new version of ZopMop is here\nwith the latest improvements."}
        </Text>

        <Pressable onPress={openStore} style={({ pressed }) => pressed && { opacity: 0.7 }}>
          <View style={styles.btn}>
            <Text style={[fontBold, styles.btnLabel]}>Update now</Text>
          </View>
        </Pressable>

        {!force && onLater && (
          <Pressable onPress={onLater} hitSlop={8} style={styles.later}>
            <Text style={[fontSemi, styles.laterText]}>Later</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Absolute full-screen overlay (UpdateGate mounts this above the live app),
  // unlike BackendDownScreen which replaces the screen as a flex:1 child.
  root: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 9999,
    elevation: 9999,
    backgroundColor: '#0B0B0C',
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  zopWrap: {
    padding: 24,
    borderRadius: 999,
    backgroundColor: 'rgba(11,11,12,0.78)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.55,
    shadowRadius: 28,
    elevation: 16,
  },
  title: { fontSize: 28, color: '#FFFFFF', marginTop: 18, textAlign: 'center' },
  body: { fontSize: 15, lineHeight: 22, color: 'rgba(255,255,255,0.6)', marginTop: 12, textAlign: 'center' },
  btn: {
    marginTop: 32,
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 999,
    backgroundColor: '#F5A300', // brand amber CTA
  },
  btnLabel: { color: '#0B0B0C', fontSize: 15 },
  later: { marginTop: 16 },
  laterText: { color: 'rgba(255,255,255,0.55)', fontSize: 14 },
});
