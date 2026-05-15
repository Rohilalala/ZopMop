// ZopBookingCard — inline booking confirmation card rendered in the Zop chat
// when a `create_booking` action succeeds. Mirrors the design of the
// scheduled-booking card in BookingsScreen but tuned for the chat width.

import React, { useState } from 'react';
import { Alert, StyleSheet, Text, View, type TextStyle } from 'react-native';
import { LoadingBars } from './ui/LoadingBars';
import { Feather } from '@expo/vector-icons';
import { PressFx } from './ui/PressFx';
import { navigationRef } from '../navigation/navigationRef';
import { useAuth } from '../context/AuthContext';
import { cancelBooking } from '../api/bookings';
import { showError, showSuccess } from '../utils/toast';

const AMBER = '#F5A300';

const fontReg:   TextStyle = { fontFamily: 'PlusJakartaSans_400Regular' };
const fontMed:   TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };
const fontBold:  TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontMono:  TextStyle = { fontFamily: 'PlusJakartaSans_500Medium', letterSpacing: 0.4 };

export interface ZopBookingData {
  id: string;
  scheduled_time?: string | null;
  total_duration_minutes?: number;
  price_paise?: number;
  discount_paise?: number;
  address_id?: string | null;
  address_tag?: string | null;
  address_title?: string | null;
  services?: Array<{
    service_name?: string;
    duration_minutes?: number;
    price_paise?: number;
  }>;
}

interface Props {
  booking: ZopBookingData;
  onCloseChat?: () => void;
}

function bookingCode(id: string): string {
  return `ZM-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

function formatHeader(iso: string | null | undefined): string {
  if (!iso) return 'SCHEDULED';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'SCHEDULED';
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOfDay(d) - startOfDay(now)) / 86400000);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (diff === 0) return `TODAY · ${time}`;
  if (diff === 1) return `TOMORROW · ${time}`;
  return `${d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase()} · ${time}`;
}

function formatRange(iso: string | null | undefined, durationMin?: number): string {
  if (!iso) return 'Scheduled';
  const start = new Date(iso);
  if (Number.isNaN(start.getTime())) return 'Scheduled';
  const end = new Date(start.getTime() + (durationMin ?? 0) * 60000);
  const day = start.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const fmt = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${day} · ${fmt(start)} – ${fmt(end)}`;
}

export default function ZopBookingCard({ booking, onCloseChat }: Props) {
  const { token } = useAuth();
  const [cancelling, setCancelling] = useState(false);
  const [cancelled, setCancelled] = useState(false);

  const handleAddService = () => {
    if (navigationRef.isReady()) {
      (navigationRef as unknown as {
        navigate: (s: string) => void;
      }).navigate('AllServices');
    }
    onCloseChat?.();
  };

  const handleCancel = () => {
    if (cancelled || cancelling) return;
    Alert.alert(
      'Cancel booking?',
      'Late cancellations may incur a small fee.',
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Cancel',
          style: 'destructive',
          onPress: async () => {
            if (!token) {
              showError('Please sign in to cancel.');
              return;
            }
            setCancelling(true);
            try {
              const r = await cancelBooking(token, booking.id);
              setCancelled(true);
              showSuccess(
                r.cancellation_fee_applied
                  ? `Cancelled · ₹${Math.round(r.cancellation_fee_paise / 100)} fee applied`
                  : 'Booking cancelled',
              );
            } catch (e) {
              showError(e instanceof Error ? e.message : 'Could not cancel');
            } finally {
              setCancelling(false);
            }
          },
        },
      ],
    );
  };
  const svc = booking.services?.[0];
  const totalServices = booking.services?.length ?? 0;
  const summaryName =
    totalServices > 1 && booking.services
      ? booking.services.map((s) => s.service_name ?? 'Service').join(' + ')
      : svc?.service_name ?? 'Service';
  const durationLine =
    totalServices > 1
      ? `${totalServices} services · ${booking.total_duration_minutes ?? 0} min total`
      : `${booking.total_duration_minutes ?? svc?.duration_minutes ?? 0} min`;
  // Match server's customer-facing total: price - discount (mirrors
  // sanitizeBookingsForLLM in househelp-api/internal/zop/service.go).
  const netCents = (booking.price_paise ?? 0) - (booking.discount_paise ?? 0);
  const priceText = `₹${Math.round(Math.max(0, netCents) / 100)}`;
  const headerLabel = formatHeader(booking.scheduled_time);
  const whenLine = formatRange(booking.scheduled_time, booking.total_duration_minutes);
  const whereLine =
    booking.address_tag ||
    booking.address_title ||
    (booking.address_id ? 'Saved address' : 'Address pending');

  return (
    <View style={styles.card}>
      <View style={styles.statusRow}>
        <View style={styles.pill}>
          <View style={styles.dot} />
          <Text style={[fontBold, styles.pillText]}>{headerLabel}</Text>
        </View>
        <Text style={[fontMono, styles.bookingId]}>{bookingCode(booking.id)}</Text>
      </View>

      <View style={styles.svcRow}>
        <View style={styles.svcThumb}>
          <Feather name="droplet" size={20} color={AMBER} />
        </View>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={[fontBold, styles.svcTitle]} numberOfLines={1}>
            {summaryName}
          </Text>
          <Text style={[fontReg, styles.svcSub]} numberOfLines={1}>
            {durationLine}
          </Text>
        </View>
        <Text style={[fontBold, styles.price]}>{priceText}</Text>
      </View>

      <View style={styles.stops}>
        <Stop iconName="calendar" keyLabel="When"  value={whenLine} />
        <Stop iconName="map-pin"  keyLabel="Where" value={whereLine} />
        <Stop iconName="user"     keyLabel="Pro"   value="Auto-matching 30 min before" />
      </View>

      <View style={styles.actions}>
        <PressFx
          onPress={handleAddService}
          disabled={cancelled}
          style={[
            styles.act,
            styles.actSecondary,
            { flex: 1 },
            cancelled && { opacity: 0.4 },
          ]}
        >
          <Feather name="plus" size={13} color="rgba(255,255,255,0.85)" />
          <Text style={[fontBold, { color: 'rgba(255,255,255,0.85)', fontSize: 13 }]}>
            Add service
          </Text>
        </PressFx>
        <PressFx
          onPress={handleCancel}
          disabled={cancelling || cancelled}
          style={[
            styles.act,
            styles.actDanger,
            { flex: 1 },
            (cancelling || cancelled) && { opacity: 0.55 },
          ]}
        >
          {cancelling ? (
            <LoadingBars size="small" color="#EF4444" />
          ) : (
            <Text style={[fontBold, { color: '#EF4444', fontSize: 13 }]}>
              {cancelled ? 'Cancelled' : 'Cancel'}
            </Text>
          )}
        </PressFx>
      </View>
    </View>
  );
}

function Stop({
  iconName,
  keyLabel,
  value,
}: {
  iconName: React.ComponentProps<typeof Feather>['name'];
  keyLabel: string;
  value: string;
}) {
  return (
    <View style={styles.stop}>
      <Text style={[fontReg, styles.stopKey]}>{keyLabel}</Text>
      <Feather name={iconName} size={13} color="rgba(255,255,255,0.55)" style={{ marginRight: 6 }} />
      <Text style={[fontMed, styles.stopVal]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderRadius: 18,
    padding: 14,
    width: '100%',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(245,163,0,0.14)',
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: AMBER,
    marginRight: 6,
  },
  pillText: {
    color: AMBER,
    fontSize: 10.5,
    letterSpacing: 0.2,
    textTransform: 'uppercase',
  },
  bookingId: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 10.5,
  },
  svcRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 14,
  },
  svcThumb: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: 'rgba(245,163,0,0.10)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  svcTitle: {
    color: '#FFFFFF',
    fontSize: 15,
    letterSpacing: -0.1,
  },
  svcSub: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 11.5,
    marginTop: 2,
  },
  price: {
    color: '#FFFFFF',
    fontSize: 14,
    marginLeft: 12,
  },
  stops: {
    marginTop: 14,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  stop: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
  },
  stopKey: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 11.5,
    width: 52,
  },
  stopVal: {
    color: '#FFFFFF',
    fontSize: 12.5,
    flex: 1,
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
  },
  act: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 11,
    borderRadius: 12,
    gap: 6,
  },
  actSecondary: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
  },
  actDanger: {
    backgroundColor: 'rgba(239,68,68,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.30)',
  },
});
