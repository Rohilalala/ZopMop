import React from 'react';
import { View, Text, type TextStyle } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { useRoomies } from '../../context/RoomiesContext';
import { PressFx } from '../ui/PressFx';

const fontReg: TextStyle = { fontFamily: 'PlusJakartaSans_400Regular' };
const fontBold: TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontSemi: TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };

type Props = {
  locationName: string;
  onLocationPress: () => void;
  selectedAddressId?: string;
};

export function HomeHeader({ locationName, onLocationPress, selectedAddressId }: Props) {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const { myGroup } = useRoomies();
  const isRoomies =
    !!myGroup && !!selectedAddressId && selectedAddressId === myGroup.group.address_id;

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        paddingHorizontal: 20,
        paddingTop: 8,
        paddingBottom: 4,
      }}
    >
      <PressFx onPress={onLocationPress} style={{ flex: 1 }} accessibilityRole="button">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View
            style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#10B981' }}
          />
          <Text
            style={[fontSemi, { fontSize: 11, color: '#9CA3AF', letterSpacing: 1.4 }]}
          >
            DELIVER TO
          </Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
          <Text
            style={[fontBold, { fontSize: 18, color: '#0F172A', maxWidth: 200 }]}
            numberOfLines={1}
          >
            {locationName}
          </Text>
          <Text style={{ fontSize: 16, color: '#6B7280', marginTop: -2 }}>⌄</Text>
        </View>
      </PressFx>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {isRoomies && (
          <PressFx
            onPress={() =>
              navigation.navigate('ManageHousehold', { groupId: myGroup.group.id })
            }
            style={{
              backgroundColor: '#4F46E5',
              paddingHorizontal: 10,
              paddingVertical: 6,
              borderRadius: 999,
            }}
          >
            <Text style={[fontSemi, { fontSize: 11, color: '#FFFFFF' }]}>Household</Text>
          </PressFx>
        )}
        <PressFx
          onPress={() => navigation.navigate('Offers')}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            backgroundColor: '#EEF2FF',
            paddingLeft: 4,
            paddingRight: 12,
            paddingVertical: 4,
            borderRadius: 999,
            borderWidth: 1,
            borderColor: 'rgba(79,70,229,0.18)',
          }}
        >
          <View
            style={{
              width: 22,
              height: 22,
              borderRadius: 11,
              backgroundColor: '#FFFFFF',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ fontSize: 12 }}>🪙</Text>
          </View>
          <Text style={[fontSemi, { fontSize: 13, color: '#4F46E5' }]}>Earn ₹100</Text>
        </PressFx>
        <PressFx
          onPress={() => navigation.navigate('Profile')}
          style={{
            width: 38,
            height: 38,
            borderRadius: 19,
            backgroundColor: '#FFFFFF',
            borderWidth: 1,
            borderColor: '#E5E7EB',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          accessibilityRole="button"
          accessibilityLabel="Profile"
        >
          <Text style={{ fontSize: 16 }}>👤</Text>
        </PressFx>
      </View>
    </View>
  );
}
