import React from 'react';
import { View, Text, ActivityIndicator, type TextStyle } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

const fontSemi: TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };
const fontReg: TextStyle = { fontFamily: 'PlusJakartaSans_400Regular' };

export type NearbyStats = {
  nearby_count: number;
  avg_rating: number;
  avg_eta_min: number;
};

type Props = {
  stats: NearbyStats | null;
  loading?: boolean;
};

// Daily-rotating quirky messages for after 8pm when no pros are online.
// Picked deterministically from the date so it stays consistent within a day
// but shuffles tomorrow.
const NIGHT_MESSAGES = [
  'All our pros are taking it easy',
  'The pros are rebooting',
  'The pros are dream-scaping their next big move',
  'Pros are recharging — back at sunrise',
  "Pros clocked out — see you in the morning",
  "Pros are off-duty, dreaming up tomorrow's hustle",
  'Pros are tucked in — try us bright & early',
  'Even pros need beauty sleep',
  'Pros are off-shift, plotting world-class chores',
  'The mops are resting. The pros too.',
];

function quirkyOfflineMessage(): string {
  const now = new Date();
  const hr = now.getHours();
  if (hr < 20) return 'All our pros are busy right now';
  // Rotate by day-of-year so message stays stable for the whole evening
  // and changes the next day.
  const start = new Date(now.getFullYear(), 0, 0);
  const diff = now.getTime() - start.getTime();
  const dayOfYear = Math.floor(diff / (1000 * 60 * 60 * 24));
  return NIGHT_MESSAGES[dayOfYear % NIGHT_MESSAGES.length];
}

export function LivePill({ stats, loading }: Props) {
  if (loading || !stats) {
    return (
      <View
        style={{
          alignSelf: 'center',
          marginTop: 20,
          paddingHorizontal: 18,
          paddingVertical: 12,
          borderRadius: 999,
          backgroundColor: '#FFFFFF',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.06,
          shadowRadius: 12,
          elevation: 2,
        }}
      >
        <ActivityIndicator size="small" color="#4F46E5" />
        <Text style={[fontReg, { fontSize: 12, color: '#9CA3AF' }]}>Checking nearby pros…</Text>
      </View>
    );
  }

  // No pros online → single quirky message instead of misleading 3-stat row.
  if (stats.nearby_count === 0) {
    const msg = quirkyOfflineMessage();
    return (
      <Animated.View
        entering={FadeIn.duration(420)}
        style={{
          alignSelf: 'center',
          marginTop: 20,
          paddingHorizontal: 18,
          paddingVertical: 12,
          borderRadius: 999,
          backgroundColor: '#FFFFFF',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          maxWidth: '90%',
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.06,
          shadowRadius: 12,
          elevation: 2,
        }}
      >
        <View
          style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#9CA3AF' }}
        />
        <Text
          style={[fontSemi, { fontSize: 13, color: '#475569' }]}
          numberOfLines={1}
        >
          {msg}
        </Text>
      </Animated.View>
    );
  }

  const items: { icon: React.ReactNode; label: string }[] = [
    {
      icon: (
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: '#10B981',
          }}
        />
      ),
      label: `${stats.nearby_count} pro${stats.nearby_count === 1 ? '' : 's'} nearby`,
    },
    {
      icon: <Text style={{ color: '#F59E0B', fontSize: 13 }}>★</Text>,
      label: `${stats.avg_rating.toFixed(1)} avg`,
    },
    {
      icon: null,
      label: `~${Math.max(1, Math.round(stats.avg_eta_min))} min arrival`,
    },
  ];

  return (
    <Animated.View
      entering={FadeIn.duration(420)}
      style={{
        alignSelf: 'center',
        marginTop: 20,
        paddingHorizontal: 18,
        paddingVertical: 12,
        borderRadius: 999,
        backgroundColor: '#FFFFFF',
        flexDirection: 'row',
        alignItems: 'center',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.06,
        shadowRadius: 12,
        elevation: 2,
      }}
    >
      {items.map((it, i) => (
        <React.Fragment key={i}>
          {i > 0 && (
            <View
              style={{
                width: 1,
                height: 16,
                backgroundColor: '#E5E7EB',
                marginHorizontal: 12,
              }}
            />
          )}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {it.icon}
            <Text style={[fontSemi, { fontSize: 13, color: '#0F172A' }]}>{it.label}</Text>
          </View>
        </React.Fragment>
      ))}
    </Animated.View>
  );
}
