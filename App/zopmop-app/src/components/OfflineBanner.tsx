import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '../context/ThemeContext';
import { FontFamily, FontSize } from '../theme';
import { addConnectivityListener, isConnected } from '../utils/netInfo';

function createStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    banner: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: '#1A1A1A',
      paddingHorizontal: 16,
      paddingVertical: 10,
      gap: 8,
    },
    text: {
      flex: 1,
      fontFamily: FontFamily.medium,
      fontSize: FontSize.sm,
      color: '#FFFFFF',
    },
  });
}

/**
 * Persistent banner shown whenever the device loses connectivity.
 * Subscribes to addConnectivityListener and auto-hides when back online.
 * Renders nothing when online.
 */
export default function OfflineBanner() {
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    // Seed initial state without a spinner/flash.
    isConnected().then((online) => setOffline(!online));
    return addConnectivityListener((online) => setOffline(!online));
  }, []);

  if (!offline) return null;

  return (
    <View style={s.banner}>
      <Feather name="wifi-off" size={14} color="#FFFFFF" />
      <Text style={s.text}>No connection — some features may be unavailable</Text>
    </View>
  );
}
