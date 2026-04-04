import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors, FontFamily, FontSize, Radius, Shadow } from '../../theme';

type Tab = 'upcoming' | 'past';
type Filter = 'one-time' | 'recurring';

export default function BookingsScreen() {
  const [tab, setTab] = useState<Tab>('upcoming');
  const [filter, setFilter] = useState<Filter>('one-time');

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      {/* Header */}
      <View style={s.header}>
        <Text style={s.headerTitle}>Your Bookings</Text>
      </View>

      {/* Upcoming / Past tab bar */}
      <View style={s.tabBar}>
        <TouchableOpacity
          style={[s.tab, tab === 'upcoming' && s.tabActive]}
          onPress={() => setTab('upcoming')}
          activeOpacity={0.7}
        >
          <Text style={[s.tabText, tab === 'upcoming' && s.tabTextActive]}>Upcoming</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.tab, tab === 'past' && s.tabActive]}
          onPress={() => setTab('past')}
          activeOpacity={0.7}
        >
          <Text style={[s.tabText, tab === 'past' && s.tabTextActive]}>Past</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* One-time / Recurring pill toggle */}
        <View style={s.filterRow}>
          <TouchableOpacity
            style={[s.filterBtn, filter === 'one-time' && s.filterBtnActive]}
            onPress={() => setFilter('one-time')}
            activeOpacity={0.8}
          >
            <Text style={[s.filterText, filter === 'one-time' && s.filterTextActive]}>
              One-time
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.filterBtn, filter === 'recurring' && s.filterBtnActive]}
            onPress={() => setFilter('recurring')}
            activeOpacity={0.8}
          >
            <Text style={[s.filterText, filter === 'recurring' && s.filterTextActive]}>
              Recurring
            </Text>
          </TouchableOpacity>
        </View>

        <EmptyState tab={tab} filter={filter} />
      </ScrollView>
    </SafeAreaView>
  );
}

function EmptyState({ tab, filter }: { tab: Tab; filter: Filter }) {
  const isUpcoming = tab === 'upcoming';
  const isOneTime = filter === 'one-time';

  return (
    <View style={s.empty}>
      <View style={s.emptyIconWrap}>
        <Text style={s.emptyEmoji}>{isUpcoming ? '📅' : '✅'}</Text>
      </View>
      <Text style={s.emptyTitle}>
        {isUpcoming ? 'No upcoming bookings' : 'No past bookings'}
      </Text>
      <Text style={s.emptySub}>
        {isUpcoming
          ? `Your next ${isOneTime ? 'one-time' : 'recurring'} service will appear here`
          : `Your completed ${isOneTime ? 'one-time' : 'recurring'} services will appear here`}
      </Text>
      {isUpcoming && (
        <TouchableOpacity style={s.bookNowBtn} activeOpacity={0.85}>
          <Text style={s.bookNowText}>Book a Service</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },

  header: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 16,
  },
  headerTitle: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize['2xl'],
    color: Colors.text,
    letterSpacing: -0.5,
  },

  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    paddingHorizontal: 16,
    backgroundColor: Colors.white,
  },
  tab: {
    paddingVertical: 12,
    marginRight: 24,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: {
    borderBottomColor: Colors.primary,
  },
  tabText: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.base,
    color: Colors.textSecondary,
  },
  tabTextActive: {
    color: Colors.primary,
  },

  scroll: { flex: 1 },
  scrollContent: { padding: 16, flexGrow: 1 },

  filterRow: {
    flexDirection: 'row',
    backgroundColor: Colors.surface,
    borderRadius: Radius.xl,
    padding: 4,
    marginBottom: 28,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  filterBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: Radius.lg,
    alignItems: 'center',
  },
  filterBtnActive: {
    backgroundColor: Colors.primary,
    ...Shadow.sm,
  },
  filterText: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  filterTextActive: {
    color: Colors.white,
  },

  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 48,
    paddingBottom: 32,
    gap: 10,
  },
  emptyIconWrap: {
    width: 80,
    height: 80,
    borderRadius: Radius.full,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  emptyEmoji: { fontSize: 36 },
  emptyTitle: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.lg,
    color: Colors.text,
  },
  emptySub: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
    maxWidth: 220,
    lineHeight: 20,
  },
  bookNowBtn: {
    marginTop: 8,
    backgroundColor: Colors.primary,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: Radius.xl,
    ...Shadow.sm,
  },
  bookNowText: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.sm,
    color: Colors.white,
  },
});
