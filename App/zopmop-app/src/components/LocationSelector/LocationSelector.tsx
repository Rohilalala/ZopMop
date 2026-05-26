import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Modal, Pressable, BackHandler, Keyboard, StyleSheet, Dimensions, Platform } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Motion } from '../../constants/tokens';
import { useAuth } from '../../context/AuthContext';
import {
  listAddresses,
  createAddress,
  updateAddress,
  deleteAddress,
  type ApiAddress,
  type CreateAddressPayload,
} from '../../api/addresses';
import type { PlaceResult } from '../../api/places';
import { showError } from '../../utils/toast';
import { usePlacesAutocomplete } from './hooks/usePlacesAutocomplete';
import { useReverseGeocode } from './hooks/useReverseGeocode';
import { useServiceability } from './hooks/useServiceability';
import { getThemeTokens } from './utils/theme';
import { SearchStep } from './steps/SearchStep';
import { ConfirmPinStep } from './steps/ConfirmPinStep';
import { AddressFormStep } from './steps/AddressFormStep';
import type {
  LocationSelectorProps,
  Step,
  SelectedPlace,
  FormValues,
} from './types';
import { INITIAL_FORM } from './types';

const { height: SCREEN_H } = Dimensions.get('window');
const SHEET_H = Math.round(SCREEN_H * 0.9);

export function LocationSelector({
  visible,
  onClose,
  onLocationSelect,
  onAddressesChanged,
  mode,
  theme = 'auto',
}: LocationSelectorProps) {
  const { token } = useAuth();
  const isDark = theme === 'light' ? false : true;
  const t = getThemeTokens(isDark);

  const [step, setStep] = useState<Step>('search');
  const [addresses, setAddresses] = useState<ApiAddress[]>([]);
  const [addressesLoading, setAddressesLoading] = useState(false);
  const [addressesError, setAddressesError] = useState(false);
  const [selectedPlace, setSelectedPlace] = useState<SelectedPlace | null>(null);
  const [form, setForm] = useState<FormValues>(INITIAL_FORM);
  const [editingAddress, setEditingAddress] = useState<ApiAddress | null>(null);
  const [saving, setSaving] = useState(false);
  const [isOpen, setIsOpen] = useState(false);

  const translateY = useSharedValue(SHEET_H);
  const backdrop = useSharedValue(0);

  const search = usePlacesAutocomplete(token);
  const geo = useReverseGeocode();
  const { isServiceable } = useServiceability();

  const currentAddressId =
    mode.kind === 'select' ? mode.initialAddressId ?? null : null;

  // ── Animation ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (visible) {
      setIsOpen(true);
      translateY.value = withSpring(0, Motion.spring.gentle);
      backdrop.value = withTiming(1, { duration: Motion.duration.base });
      fetchAddresses();
      if (mode.kind === 'manage' && mode.editAddress) {
        openEditMode(mode.editAddress);
      }
    } else {
      translateY.value = withTiming(SHEET_H, {
        duration: Motion.duration.base,
        easing: Motion.easing.exit,
      });
      backdrop.value = withTiming(0, { duration: Motion.duration.quick });
      setTimeout(() => {
        setIsOpen(false);
        resetState();
      }, Motion.duration.base);
    }
  }, [visible]);

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: backdrop.value,
  }));

  // ── Swipe dismiss ──────────────────────────────────────────────────────────

  const canSwipeDismiss = step === 'search';

  const pan = Gesture.Pan()
    .onUpdate((e) => {
      if (!canSwipeDismiss) return;
      if (e.translationY > 0) translateY.value = e.translationY;
    })
    .onEnd((e) => {
      if (!canSwipeDismiss) return;
      if (e.translationY > SHEET_H * 0.3 || e.velocityY > 800) {
        translateY.value = withTiming(SHEET_H, {
          duration: Motion.duration.quick,
          easing: Motion.easing.exit,
        });
        runOnJS(handleDismiss)();
      } else {
        translateY.value = withSpring(0, Motion.spring.snappy);
      }
    });

  // ── Android back button ────────────────────────────────────────────────────

  useEffect(() => {
    if (!visible) return;
    const handler = BackHandler.addEventListener('hardwareBackPress', () => {
      if (step === 'address-form') {
        if (editingAddress) {
          setStep('search');
          setEditingAddress(null);
        } else {
          setStep('confirm-pin');
        }
        return true;
      }
      if (step === 'confirm-pin') {
        setStep('search');
        return true;
      }
      handleDismiss();
      return true;
    });
    return () => handler.remove();
  }, [visible, step, editingAddress]);

  // ── Data ───────────────────────────────────────────────────────────────────

  const fetchAddresses = useCallback(async () => {
    if (!token || token === '__guest__') return;
    setAddressesLoading(true);
    setAddressesError(false);
    try {
      const list = await listAddresses(token);
      setAddresses(list);
    } catch {
      setAddressesError(true);
    } finally {
      setAddressesLoading(false);
    }
  }, [token]);

  // ── State transitions ──────────────────────────────────────────────────────

  function resetState() {
    setStep('search');
    setSelectedPlace(null);
    setForm(INITIAL_FORM);
    setEditingAddress(null);
    setSaving(false);
    search.clear();
  }

  function handleDismiss() {
    Keyboard.dismiss();
    onClose();
  }

  function handleBackdropPress() {
    if (step === 'search') handleDismiss();
  }

  function handleResultSelect(result: PlaceResult) {
    const place: SelectedPlace = {
      name: result.description || result.main_text,
      lat: result.lat,
      lon: result.lon,
    };
    setSelectedPlace(place);
    search.clear();
    Keyboard.dismiss();

    if (!isServiceable(place.lat, place.lon)) {
      setStep('confirm-pin');
      return;
    }
    setStep('confirm-pin');
  }

  function handleGps() {
    geo.getCurrentLocation().then((loc) => {
      if (!loc) return;
      const place: SelectedPlace = { name: loc.name, lat: loc.lat, lon: loc.lon };
      setSelectedPlace(place);

      if (mode.kind === 'change-location') {
        onLocationSelect(loc.name, loc.lat, loc.lon);
        handleDismiss();
        return;
      }

      setStep('confirm-pin');
    });
  }

  function handleSavedSelect(addr: ApiAddress) {
    onLocationSelect(addr.full_address, addr.lat, addr.lon, addr.id, addr);
    handleDismiss();
  }

  function handleSavedEdit(addr: ApiAddress) {
    openEditMode(addr);
  }

  function openEditMode(addr: ApiAddress) {
    setEditingAddress(addr);
    setSelectedPlace({
      name: addr.full_address,
      lat: addr.lat,
      lon: addr.lon,
    });
    setForm({
      tag: addr.tag,
      flatNo: addr.flat_no ?? '',
      floor: addr.floor ?? '',
      buildingName: addr.building_name ?? '',
      landmark: addr.landmark ?? '',
      receiverName: addr.receiver_name ?? '',
      receiverPhone: addr.receiver_phone ?? '',
      setAsDefault: false,
    });
    setStep('address-form');
  }

  async function handleSavedDelete(addr: ApiAddress) {
    if (!token) return;
    try {
      await deleteAddress(token, addr.id);
      setAddresses((prev) => prev.filter((a) => a.id !== addr.id));
      onAddressesChanged?.();
    } catch {
      showError('Could not delete. Please try again.');
    }
  }

  function handleConfirmPin() {
    setStep('address-form');
  }

  function handleChangeFromPin() {
    setStep('search');
    setSelectedPlace(null);
  }

  function handleChangeFromForm() {
    setStep('confirm-pin');
  }

  function handleBackFromForm() {
    if (editingAddress) {
      setStep('search');
      setEditingAddress(null);
      setForm(INITIAL_FORM);
    } else {
      setStep('confirm-pin');
    }
  }

  async function handleSave() {
    if (!token || !selectedPlace) return;
    setSaving(true);
    try {
      const parts = [
        form.flatNo.trim(),
        form.floor.trim(),
        form.buildingName.trim(),
        form.landmark.trim(),
        selectedPlace.name,
      ].filter(Boolean);
      const fullAddress = parts.join(', ');

      const payload: CreateAddressPayload = {
        tag: form.tag,
        title: form.tag === 'Other' ? form.buildingName.trim() : form.tag,
        flat_no: form.flatNo.trim(),
        floor: form.floor.trim(),
        building_name: form.buildingName.trim(),
        landmark: form.landmark.trim(),
        full_address: fullAddress,
        receiver_name: form.receiverName.trim(),
        receiver_phone: form.receiverPhone.trim(),
        lat: selectedPlace.lat,
        lon: selectedPlace.lon,
      };

      let saved: ApiAddress;
      if (editingAddress) {
        saved = await updateAddress(token, editingAddress.id, payload);
      } else {
        saved = await createAddress(token, payload);
      }

      await fetchAddresses();
      onAddressesChanged?.();
      onLocationSelect(fullAddress, selectedPlace.lat, selectedPlace.lon, saved.id, saved);
      handleDismiss();
    } catch {
      showError('Failed to save address. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  const serviceableForPin =
    selectedPlace ? isServiceable(selectedPlace.lat, selectedPlace.lon) : true;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <Modal
      visible={isOpen}
      transparent
      animationType="none"
      onRequestClose={handleDismiss}
      statusBarTranslucent
    >
      <View style={styles.root}>
        <Animated.View style={[styles.backdrop, backdropStyle, { backgroundColor: t.scrim }]}>
          <Pressable style={{ flex: 1 }} onPress={handleBackdropPress} />
        </Animated.View>
        <GestureDetector gesture={pan}>
          <Animated.View
            style={[
              styles.sheet,
              sheetStyle,
              {
                height: SHEET_H,
                backgroundColor: t.sheetBg,
                borderTopLeftRadius: 28,
                borderTopRightRadius: 28,
              },
            ]}
          >
            {/* Grabber */}
            <View style={styles.grabberWrap}>
              <View
                style={[
                  styles.grabber,
                  { backgroundColor: isDark ? 'rgba(255,255,255,0.22)' : 'rgba(13,13,15,0.18)' },
                ]}
              />
            </View>

            {step === 'search' && (
              <SearchStep
                t={t}
                isDark={isDark}
                mode={mode}
                query={search.query}
                searchState={search.state}
                results={search.results}
                gpsState={geo.gpsState}
                addresses={addresses}
                addressesLoading={addressesLoading}
                addressesError={addressesError}
                currentAddressId={currentAddressId}
                onQueryChange={search.handleQueryChange}
                onClear={search.clear}
                onRetry={search.retry}
                onResultSelect={handleResultSelect}
                onGps={handleGps}
                onAddNew={() => {}}
                onSavedSelect={handleSavedSelect}
                onSavedEdit={handleSavedEdit}
                onSavedDelete={handleSavedDelete}
                onDismiss={handleDismiss}
                onRetryAddresses={fetchAddresses}
              />
            )}

            {step === 'confirm-pin' && selectedPlace && (
              <ConfirmPinStep
                t={t}
                isDark={isDark}
                place={selectedPlace}
                isServiceable={serviceableForPin}
                onPlaceUpdate={setSelectedPlace}
                onReverseGeocode={geo.reverseGeocodeDebounced}
                onConfirm={handleConfirmPin}
                onChange={handleChangeFromPin}
                onDismiss={handleDismiss}
              />
            )}

            {step === 'address-form' && selectedPlace && (
              <AddressFormStep
                t={t}
                isDark={isDark}
                place={selectedPlace}
                form={form}
                isEdit={!!editingAddress}
                saving={saving}
                onFormChange={(updates) =>
                  setForm((prev) => ({ ...prev, ...updates }))
                }
                onSave={handleSave}
                onChangeLocation={handleChangeFromForm}
                onBack={handleBackFromForm}
              />
            )}
          </Animated.View>
        </GestureDetector>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  backdrop: { flex: 1 },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -24 },
    shadowOpacity: 0.55,
    shadowRadius: 44,
    elevation: 16,
  },
  grabberWrap: { alignItems: 'center', paddingVertical: 8 },
  grabber: { width: 38, height: 5, borderRadius: 99 },
});
