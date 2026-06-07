import React from 'react';
import { View, Text, type TextStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { useAuth } from '../../context/AuthContext';
import { useRoomies } from '../../context/RoomiesContext';
import { useTheme } from '../../context/ThemeContext';
import { PressFx } from '../ui/PressFx';

const fontBold: TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontSemi: TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };

type Props = {
  locationName: string;
  onLocationPress: () => void;
  selectedAddressId?: string;
  /** Saved-address tag (e.g. "Home", "Office", "Mom's"). Falls back to a
   *  generic label when the user hasn't saved this place. */
  addressTag?: string | null;
};

function initialsOf(name?: string | null): string {
  if (!name) return 'You';
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || 'You';
}

export function HomeHeader({ locationName, onLocationPress, selectedAddressId, addressTag }: Props) {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const { user } = useAuth();
  const { myGroup } = useRoomies();
  const { isDark, colors: c } = useTheme();
  const isRoomies =
    !!myGroup && !!selectedAddressId && selectedAddressId === myGroup.group.address_id;

  const kickerColor = c.accentOnSurface;
  const locationTextColor = isDark ? '#FFFFFF' : c.text;
  const chevronColor = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(13,13,15,0.35)';

  // Earn pill: amber-tinted on dark, inverted (dark bg + amber text) on light
  const earnBg = isDark ? 'rgba(245,163,0,0.12)' : '#0D0D0F';
  const earnBorder = isDark ? 'rgba(245,163,0,0.3)' : '#0D0D0F';
  const earnTextColor = '#F5A300';

  // Household pill reuses the same inversion logic
  const householdBg = isDark ? 'rgba(245,163,0,0.12)' : 'rgba(13,13,15,0.06)';
  const householdBorder = isDark ? 'rgba(245,163,0,0.3)' : 'rgba(13,13,15,0.12)';
  const householdTextColor = isDark ? '#F5A300' : c.text;

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 20,
        paddingTop: 10,
        paddingBottom: 4,
      }}
    >
      <PressFx onPress={onLocationPress} style={{ flex: 1 }} accessibilityRole="button">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Feather name="map-pin" size={10} color={kickerColor} />
          <Text
            style={[
              fontBold,
              {
                fontSize: 10.5,
                color: kickerColor,
                letterSpacing: 0.84,
                textTransform: 'uppercase',
              },
            ]}
            numberOfLines={1}
          >
            {addressTag && addressTag.trim() ? addressTag : 'Current location'}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
          <Text
            style={[fontBold, { fontSize: 17, color: locationTextColor, letterSpacing: -0.34, maxWidth: 200 }]}
            numberOfLines={1}
          >
            {locationName}
          </Text>
          <Text style={{ fontSize: 14, color: chevronColor, marginTop: 2 }}>⌄</Text>
        </View>
      </PressFx>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {isRoomies && (
          <PressFx
            onPress={() =>
              navigation.navigate('ManageHousehold', { groupId: myGroup.group.id })
            }
            style={{
              backgroundColor: householdBg,
              paddingHorizontal: 10,
              paddingVertical: 6,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: householdBorder,
            }}
          >
            <Text style={[fontBold, { fontSize: 11, color: householdTextColor }]}>Household</Text>
          </PressFx>
        )}
        <PressFx
          onPress={() => navigation.navigate('ReferralEarn')}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            height: 36,
            paddingHorizontal: 12,
            borderRadius: 18,
            backgroundColor: earnBg,
            borderWidth: 1,
            borderColor: earnBorder,
          }}
        >
          <Feather name="plus-circle" size={12} color={earnTextColor} />
          <Text style={[fontBold, { fontSize: 12, color: earnTextColor }]}>Earn ₹150</Text>
        </PressFx>
        <PressFx
          onPress={() => navigation.navigate('Profile')}
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            backgroundColor: '#F5A300',
            alignItems: 'center',
            justifyContent: 'center',
            shadowColor: '#F5A300',
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: 0.35,
            shadowRadius: 12,
            elevation: 6,
          }}
          accessibilityRole="button"
          accessibilityLabel="Profile"
        >
          <Text style={[fontBold, { fontSize: 13, color: '#0D0D0F' }]}>
            {initialsOf(user?.name)}
          </Text>
        </PressFx>
      </View>
    </View>
  );
}
