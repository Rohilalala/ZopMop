import React, { useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Platform,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { FontFamily } from '../../../theme';
import { LoadingBars } from '../../ui/LoadingBars';
import { ResultRow } from '../rows/ResultRow';
import { SavedAddressRow } from '../rows/SavedAddressRow';
import type { LSThemeTokens } from '../utils/theme';
import type { ApiAddress } from '../../../api/addresses';
import type { PlaceResult } from '../../../api/places';
import type { Mode } from '../types';

type SearchState = 'idle' | 'loading' | 'results' | 'no_results' | 'error';
type GpsState = 'idle' | 'loading' | 'denied' | 'error';

interface Props {
  t: LSThemeTokens;
  isDark: boolean;
  mode: Mode;
  query: string;
  searchState: SearchState;
  results: PlaceResult[];
  gpsState: GpsState;
  addresses: ApiAddress[];
  addressesLoading: boolean;
  addressesError: boolean;
  currentAddressId: string | null;
  onQueryChange: (text: string) => void;
  onClear: () => void;
  onRetry: () => void;
  onResultSelect: (result: PlaceResult) => void;
  onGps: () => void;
  onAddNew: () => void;
  onSavedSelect: (addr: ApiAddress) => void;
  onSavedEdit: (addr: ApiAddress) => void;
  onSavedDelete: (addr: ApiAddress) => void;
  onDismiss: () => void;
  onRetryAddresses: () => void;
}

export function SearchStep({
  t,
  isDark,
  mode,
  query,
  searchState,
  results,
  gpsState,
  addresses,
  addressesLoading,
  addressesError,
  currentAddressId,
  onQueryChange,
  onClear,
  onRetry,
  onResultSelect,
  onGps,
  onAddNew,
  onSavedSelect,
  onSavedEdit,
  onSavedDelete,
  onDismiss,
  onRetryAddresses,
}: Props) {
  const inputRef = useRef<TextInput>(null);
  const showIdleContent = !query.trim();
  const showActions = true;
  const hideGps = mode.kind === 'select';

  return (
    <View style={s.root}>
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity
          style={[s.iconBtn, { backgroundColor: t.glass, borderColor: t.glassBorderHi }]}
          onPress={onDismiss}
          activeOpacity={0.7}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Feather name="x" size={14} color={t.text} />
        </TouchableOpacity>
        <Text style={[s.title, { color: t.text }]}>Search your location</Text>
      </View>

      <View style={[s.divider, { backgroundColor: t.divider }]} />

      {/* Search input */}
      <View style={s.searchWrap}>
        <View
          style={[
            s.searchBar,
            { backgroundColor: t.glass, borderColor: query ? t.amber : t.glassBorder },
            query ? { backgroundColor: isDark ? 'rgba(245,163,0,0.06)' : t.surface } : null,
          ]}
        >
          {searchState === 'loading' ? (
            <LoadingBars size="small" color={t.amber} style={{ width: 18 }} />
          ) : (
            <Feather name="search" size={16} color={query ? t.amber : t.textMuted} />
          )}
          <TextInput
            ref={inputRef}
            style={[s.searchInput, { color: t.text }]}
            placeholder="Search locality, sector, area"
            placeholderTextColor={t.textMuted}
            value={query}
            onChangeText={onQueryChange}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            keyboardAppearance={isDark ? 'dark' : 'light'}
          />
          {query.length > 0 && (
            <TouchableOpacity
              style={[s.clearBtn, { backgroundColor: t.glassHi, borderColor: t.glassBorderHi }]}
              onPress={onClear}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Feather name="x" size={11} color={t.text} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Idle content: action card + saved addresses */}
        {showIdleContent && (
          <>
            {/* Action card */}
            <View style={[s.actionCard, { backgroundColor: t.surface, borderColor: t.glassBorder }]}>
              {!hideGps && (
                <>
                  <TouchableOpacity
                    style={s.actionRow}
                    onPress={onGps}
                    disabled={gpsState === 'loading'}
                    activeOpacity={0.7}
                  >
                    <View style={[s.actionIcon, { backgroundColor: t.amberFill, borderColor: t.amberBorder }]}>
                      {gpsState === 'loading' ? (
                        <LoadingBars size="small" color={t.amber} />
                      ) : (
                        <Feather name="navigation" size={16} color={t.amber} />
                      )}
                    </View>
                    <View style={s.actionBody}>
                      <Text style={[s.actionTitle, { color: t.text }]}>
                        {gpsState === 'loading' ? 'Detecting location...' : 'Use current location'}
                      </Text>
                      {gpsState === 'denied' ? (
                        <Text style={[s.actionSub, { color: t.danger }]}>
                          Location permission denied - enable it in Settings
                        </Text>
                      ) : gpsState === 'error' ? (
                        <Text style={[s.actionSub, { color: t.danger }]}>
                          Could not get location - tap to retry
                        </Text>
                      ) : (
                        <Text style={[s.actionSub, { color: t.textMuted }]}>Detect via GPS</Text>
                      )}
                    </View>
                    <Text style={[s.actionChev, { color: t.textMuted }]}>{'>'}</Text>
                  </TouchableOpacity>
                  <View style={[s.actionDivider, { backgroundColor: t.divider }]} />
                </>
              )}
              <TouchableOpacity
                style={s.actionRow}
                onPress={() => { onAddNew(); inputRef.current?.focus(); }}
                activeOpacity={0.7}
              >
                <View style={[s.actionIcon, { backgroundColor: t.glassHi, borderColor: t.glassBorderHi }]}>
                  <Feather name="plus" size={16} color={t.text} />
                </View>
                <View style={s.actionBody}>
                  <Text style={[s.actionTitle, { color: t.text }]}>Add new address</Text>
                  <Text style={[s.actionSub, { color: t.textMuted }]}>Search and pin a new spot</Text>
                </View>
                <Text style={[s.actionChev, { color: t.textMuted }]}>{'>'}</Text>
              </TouchableOpacity>
            </View>

            {/* Saved addresses */}
            {addressesLoading ? (
              <View style={s.loadingWrap}>
                <LoadingBars size="small" color={t.amber} />
              </View>
            ) : addressesError ? (
              <View style={[s.emptyPane, { backgroundColor: t.glass, borderColor: t.glassBorder }]}>
                <View style={[s.emptyIcon, { backgroundColor: t.amberFill }]}>
                  <Feather name="alert-triangle" size={22} color={t.amber} />
                </View>
                <Text style={[s.emptyTitle, { color: t.textSecondary }]}>
                  Couldn't load saved addresses
                </Text>
                <TouchableOpacity onPress={onRetryAddresses} activeOpacity={0.7}>
                  <Text style={[s.retryText, { color: t.amber }]}>Tap to retry</Text>
                </TouchableOpacity>
              </View>
            ) : addresses.length > 0 ? (
              <>
                <View style={s.savedHead}>
                  <Text style={[s.savedTitle, { color: t.textMuted }]}>Saved addresses</Text>
                  <Text style={[s.savedCount, { color: t.textMuted }]}>
                    {addresses.length} saved
                  </Text>
                </View>
                <View style={[s.savedList, { backgroundColor: t.surface, borderColor: t.glassBorder }]}>
                  {addresses.map((addr, idx) => (
                    <React.Fragment key={addr.id}>
                      {idx > 0 && (
                        <View style={[s.savedDivider, { backgroundColor: t.divider }]} />
                      )}
                      <SavedAddressRow
                        address={addr}
                        isCurrent={addr.id === currentAddressId}
                        showActions={showActions}
                        t={t}
                        onSelect={() => onSavedSelect(addr)}
                        onEdit={() => onSavedEdit(addr)}
                        onDelete={() => onSavedDelete(addr)}
                      />
                    </React.Fragment>
                  ))}
                </View>
              </>
            ) : (
              <View style={[s.emptyPane, { backgroundColor: t.glass, borderColor: t.glassBorder }]}>
                <View style={[s.emptyIcon, { backgroundColor: t.amberFill }]}>
                  <Feather name="map-pin" size={22} color={t.amber} />
                </View>
                <Text style={[s.emptyTitle, { color: t.textSecondary }]}>No saved addresses yet</Text>
                <Text style={[s.emptySub, { color: t.textMuted }]}>
                  Tap "Add new address" to get started
                </Text>
              </View>
            )}
          </>
        )}

        {/* Search results */}
        {!showIdleContent && (
          <>
            {searchState === 'results' && results.length > 0 && (
              <>
                <View style={s.resultsHead}>
                  <Text style={[s.resultsTitle, { color: t.textMuted }]}>
                    Results for "{query}"
                  </Text>
                  <Text style={[s.resultsAttr, { color: t.textMuted }]}>via Google</Text>
                </View>
                <View
                  style={[
                    s.resultsList,
                    { backgroundColor: t.glass, borderColor: t.glassBorder },
                  ]}
                >
                  {results.map((r, idx) => (
                    <ResultRow
                      key={`${r.lat}-${r.lon}-${idx}`}
                      result={r}
                      query={query}
                      t={t}
                      onPress={() => onResultSelect(r)}
                      isLast={idx === results.length - 1}
                    />
                  ))}
                </View>
              </>
            )}

            {searchState === 'no_results' && (
              <View style={[s.emptyPane, { backgroundColor: t.glass, borderColor: t.glassBorder }]}>
                <View style={[s.emptyIcon, { backgroundColor: t.amberFill }]}>
                  <Feather name="map" size={22} color={t.amber} />
                </View>
                <Text style={[s.emptyTitle, { color: t.textSecondary }]}>
                  No matches for "{query}"
                </Text>
                <Text style={[s.emptySub, { color: t.textMuted }]}>
                  Try a different area or locality
                </Text>
              </View>
            )}

            {searchState === 'error' && (
              <View style={[s.emptyPane, { backgroundColor: t.glass, borderColor: t.glassBorder }]}>
                <View style={[s.emptyIcon, { backgroundColor: t.amberFill }]}>
                  <Feather name="alert-triangle" size={22} color={t.amber} />
                </View>
                <Text style={[s.emptyTitle, { color: t.textSecondary }]}>
                  Couldn't fetch results
                </Text>
                <TouchableOpacity onPress={onRetry} activeOpacity={0.7}>
                  <Text style={[s.retryText, { color: t.amber }]}>Tap to retry</Text>
                </TouchableOpacity>
              </View>
            )}

            {searchState === 'loading' && results.length === 0 && (
              <View style={s.loadingWrap}>
                <LoadingBars size="small" color={t.amber} />
              </View>
            )}
          </>
        )}

        <View style={{ height: 24 }} />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 12,
    gap: 10,
  },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: 99,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  title: {
    fontFamily: FontFamily.bold,
    fontSize: 19,
    letterSpacing: -0.3,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: 16,
    marginBottom: 12,
  },

  searchWrap: { paddingHorizontal: 16, marginBottom: 12 },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    paddingHorizontal: 14,
    height: 50,
    gap: 10,
    borderWidth: 1,
  },
  searchInput: {
    flex: 1,
    fontFamily: FontFamily.semibold,
    fontSize: 13.5,
    paddingVertical: 0,
  },
  clearBtn: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 0.5,
  },

  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingBottom: 24 },

  actionCard: {
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 1,
    marginBottom: 2,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  actionDivider: { height: 1, marginHorizontal: 14 },
  actionIcon: {
    width: 42,
    height: 42,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  actionBody: { flex: 1 },
  actionTitle: {
    fontFamily: FontFamily.semibold,
    fontSize: 14,
    letterSpacing: -0.05,
  },
  actionSub: {
    fontFamily: FontFamily.medium,
    fontSize: 11.5,
    marginTop: 2,
  },
  actionChev: { fontSize: 18, fontWeight: '500' },

  savedHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginVertical: 10,
    marginHorizontal: 2,
  },
  savedTitle: {
    fontFamily: FontFamily.bold,
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  savedCount: {
    fontFamily: FontFamily.semibold,
    fontSize: 11,
  },
  savedList: {
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 1,
  },
  savedDivider: { height: 1 },

  resultsHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginVertical: 10,
    marginHorizontal: 2,
  },
  resultsTitle: {
    fontFamily: FontFamily.bold,
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  resultsAttr: {
    fontFamily: FontFamily.semibold,
    fontSize: 9.5,
    letterSpacing: 0.4,
  },
  resultsList: {
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 1,
  },

  emptyPane: {
    marginTop: 14,
    borderRadius: 16,
    minHeight: 200,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    padding: 20,
    borderWidth: 1,
  },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: {
    fontFamily: FontFamily.semibold,
    fontSize: 13,
    textAlign: 'center',
  },
  emptySub: {
    fontFamily: FontFamily.medium,
    fontSize: 11.5,
    textAlign: 'center',
  },
  retryText: {
    fontFamily: FontFamily.semibold,
    fontSize: 13,
    textDecorationLine: 'underline',
    marginTop: 4,
  },
  loadingWrap: {
    alignItems: 'center',
    paddingVertical: 40,
  },
});
