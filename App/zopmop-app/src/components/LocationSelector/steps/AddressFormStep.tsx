import React, { useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { FontFamily } from '../../../theme';
import { LoadingBars } from '../../ui/LoadingBars';
import { AppSwitch } from '../../ui/AppSwitch';
import type { LSThemeTokens } from '../utils/theme';
import type { SelectedPlace, FormValues, AddressTag } from '../types';
import { INDIAN_PHONE_REGEX } from '../types';

const TAG_OPTIONS: { tag: AddressTag; icon: keyof typeof Feather.glyphMap }[] = [
  { tag: 'Home', icon: 'home' },
  { tag: 'Work', icon: 'briefcase' },
  { tag: 'Other', icon: 'clock' },
];

interface Props {
  t: LSThemeTokens;
  isDark: boolean;
  place: SelectedPlace;
  form: FormValues;
  isEdit: boolean;
  saving: boolean;
  onFormChange: (updates: Partial<FormValues>) => void;
  onSave: () => void;
  onChangeLocation: () => void;
  onBack: () => void;
}

export function AddressFormStep({
  t,
  isDark,
  place,
  form,
  isEdit,
  saving,
  onFormChange,
  onSave,
  onChangeLocation,
  onBack,
}: Props) {
  const [phoneBlurred, setPhoneBlurred] = useState(false);

  const canSave =
    form.flatNo.trim().length > 0 &&
    form.buildingName.trim().length > 0 &&
    form.receiverName.trim().length > 0 &&
    INDIAN_PHONE_REGEX.test(form.receiverPhone.trim()) &&
    form.tag !== undefined;

  const phoneError =
    phoneBlurred &&
    form.receiverPhone.trim().length > 0 &&
    !INDIAN_PHONE_REGEX.test(form.receiverPhone.trim());

  const handleSave = useCallback(() => {
    if (!canSave || saving) return;
    onSave();
  }, [canSave, saving, onSave]);

  return (
    <View style={s.root}>
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity
          style={[s.iconBtn, { backgroundColor: t.glass, borderColor: t.glassBorderHi }]}
          onPress={onBack}
          activeOpacity={0.7}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Feather name="chevron-left" size={18} color={t.text} />
        </TouchableOpacity>
        <Text style={[s.title, { color: t.text }]}>
          {isEdit ? 'Edit address' : 'Add address details'}
        </Text>
      </View>
      <View style={[s.divider, { backgroundColor: t.divider }]} />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={100}
      >
        <ScrollView
          style={s.scroll}
          contentContainerStyle={s.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Saving-to strip */}
          <View style={[s.savingTo, { borderColor: t.amberBorder }]}>
            <View style={[s.stPin, { backgroundColor: t.amberFill, borderColor: t.amberBorder }]}>
              <Feather name="map-pin" size={16} color={t.amber} />
            </View>
            <View style={s.stBody}>
              <Text style={[s.stLabel, { color: t.amber }]}>Saving to</Text>
              <Text style={[s.stVal, { color: t.text }]} numberOfLines={1}>
                {place.name}
              </Text>
            </View>
            {!isEdit && (
              <TouchableOpacity
                style={[s.stChange, { backgroundColor: t.amberFill }]}
                onPress={onChangeLocation}
                activeOpacity={0.75}
              >
                <Text style={[s.stChangeText, { color: t.amber }]}>Change</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* 01 - Save as */}
          <View style={s.sectionTitle}>
            <Text style={s.sectionNum}>01</Text>
            <Text style={[s.sectionLbl, { color: t.text }]}>Save as</Text>
          </View>
          <View style={s.typeGrid}>
            {TAG_OPTIONS.map(({ tag, icon }) => {
              const active = form.tag === tag;
              return (
                <TouchableOpacity
                  key={tag}
                  style={[
                    s.typeTile,
                    { backgroundColor: t.glass, borderColor: t.glassBorder },
                    active && {
                      borderColor: 'rgba(245,163,0,0.55)',
                      shadowColor: '#F5A300',
                      shadowOpacity: 0.18,
                      shadowRadius: 20,
                      shadowOffset: { width: 0, height: 6 },
                      elevation: 6,
                    },
                  ]}
                  onPress={() => onFormChange({ tag })}
                  activeOpacity={0.75}
                >
                  <View
                    style={[
                      s.tileIcon,
                      active
                        ? { backgroundColor: '#F5A300' }
                        : { backgroundColor: t.glassHi },
                    ]}
                  >
                    <Feather
                      name={icon}
                      size={18}
                      color={active ? t.ink : t.textMuted}
                    />
                  </View>
                  <Text
                    style={[
                      s.tileLbl,
                      { color: active ? t.amber : t.textMuted },
                      active && { fontFamily: FontFamily.bold },
                    ]}
                  >
                    {tag}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* 02 - Address */}
          <View style={s.sectionTitle}>
            <Text style={s.sectionNum}>02</Text>
            <Text style={[s.sectionLbl, { color: t.text }]}>Address</Text>
          </View>
          <View style={s.fieldStack}>
            <View style={s.fieldRow}>
              <FloatingField
                label="Flat / House no."
                required
                value={form.flatNo}
                onChangeText={(v) => onFormChange({ flatNo: v })}
                t={t}
                isDark={isDark}
              />
              <FloatingField
                label="Floor"
                optional
                value={form.floor}
                onChangeText={(v) => onFormChange({ floor: v })}
                t={t}
                isDark={isDark}
                keyboardType="number-pad"
              />
            </View>
            <FloatingField
              label="Apartment / Building name"
              required
              value={form.buildingName}
              onChangeText={(v) => onFormChange({ buildingName: v })}
              t={t}
              isDark={isDark}
            />
            <FloatingField
              label="Nearby landmark"
              optional
              value={form.landmark}
              onChangeText={(v) => onFormChange({ landmark: v })}
              t={t}
              isDark={isDark}
            />
          </View>

          {/* 03 - Receiver */}
          <View style={s.sectionTitle}>
            <Text style={s.sectionNum}>03</Text>
            <Text style={[s.sectionLbl, { color: t.text }]}>Receiver</Text>
            <Text style={[s.sectionHint, { color: t.textMuted }]}>
              Your pro will call this number
            </Text>
          </View>
          <View style={s.fieldStack}>
            <FloatingField
              label="Receiver's name"
              required
              value={form.receiverName}
              onChangeText={(v) => onFormChange({ receiverName: v })}
              t={t}
              isDark={isDark}
              autoCapitalize="words"
            />
            {/* Phone grouped */}
            <View
              style={[
                s.phoneGrouped,
                { backgroundColor: t.glass, borderColor: phoneError ? t.danger : t.border },
              ]}
            >
              <View style={[s.ccSel, { borderRightColor: t.border }]}>
                <Text style={s.flagEmoji}>🇮🇳</Text>
                <Text style={[s.ccText, { color: t.text }]}>+91</Text>
              </View>
              <TextInput
                style={[s.phoneInput, { color: t.text }]}
                placeholder="Phone number"
                placeholderTextColor={t.textMuted}
                value={form.receiverPhone}
                onChangeText={(v) => onFormChange({ receiverPhone: v })}
                keyboardType="phone-pad"
                maxLength={10}
                keyboardAppearance={isDark ? 'dark' : 'light'}
                onBlur={() => setPhoneBlurred(true)}
              />
            </View>
            {phoneError && (
              <Text style={[s.errorText, { color: t.danger }]}>
                Enter a valid 10-digit Indian mobile number
              </Text>
            )}
          </View>

          {/* Default toggle */}
          <View style={[s.defaultRow, { backgroundColor: t.glass, borderColor: t.glassBorder }]}>
            <View style={s.drBody}>
              <Text style={[s.drTitle, { color: t.text }]}>Set as default address</Text>
              <Text style={[s.drSub, { color: t.textMuted }]}>Use this for new bookings</Text>
            </View>
            <AppSwitch
              value={form.setAsDefault}
              onValueChange={(v) => onFormChange({ setAsDefault: v })}
            />
          </View>

          <View style={{ height: 120 }} />
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Save dock */}
      <View
        style={[
          s.saveDock,
          {
            backgroundColor: isDark
              ? 'rgba(19,19,21,0.92)'
              : 'rgba(250,247,241,0.95)',
            borderTopColor: isDark
              ? 'rgba(255,255,255,0.04)'
              : 'rgba(13,13,15,0.04)',
          },
        ]}
      >
        <TouchableOpacity
          style={[
            s.saveBtn,
            canSave && !saving
              ? s.saveBtnEnabled
              : [s.saveBtnDisabled, { backgroundColor: t.glassHi, borderColor: t.glassBorderHi }],
          ]}
          onPress={handleSave}
          disabled={!canSave || saving}
          activeOpacity={0.85}
        >
          {saving ? (
            <LoadingBars size="small" color={canSave ? '#0D0D0F' : t.textMuted} />
          ) : (
            <>
              <Text
                style={[
                  s.saveBtnText,
                  !canSave && { color: t.textMuted },
                ]}
              >
                {isEdit ? 'Save changes' : 'Save address'}
              </Text>
              {canSave && <Feather name="arrow-right" size={16} color="#0D0D0F" />}
            </>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

function FloatingField({
  label,
  required,
  optional,
  value,
  onChangeText,
  t,
  isDark,
  keyboardType = 'default',
  autoCapitalize = 'sentences',
}: {
  label: string;
  required?: boolean;
  optional?: boolean;
  value: string;
  onChangeText: (v: string) => void;
  t: LSThemeTokens;
  isDark: boolean;
  keyboardType?: 'default' | 'number-pad' | 'phone-pad';
  autoCapitalize?: 'none' | 'sentences' | 'words';
}) {
  const inputRef = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);
  const placeholderText = `${label}${required ? '*' : ''}${optional ? ' (optional)' : ''}`;

  return (
    <TouchableOpacity
      activeOpacity={1}
      onPress={() => inputRef.current?.focus()}
      style={[
        s.ff,
        { backgroundColor: t.glass, borderColor: focused ? '#F5A300' : t.border },
        focused && s.ffFocused,
      ]}
    >
      <TextInput
        ref={inputRef}
        style={[s.ffInput, { color: t.text }]}
        value={value}
        onChangeText={onChangeText}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        keyboardAppearance={isDark ? 'dark' : 'light'}
        placeholder={placeholderText}
        placeholderTextColor={focused ? t.amber : t.textMuted}
      />
    </TouchableOpacity>
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
    gap: 12,
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
    fontSize: 18,
    letterSpacing: -0.3,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: 16,
    marginBottom: 4,
  },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingTop: 4 },

  savingTo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    paddingHorizontal: 14,
    borderRadius: 14,
    marginTop: 2,
    borderWidth: 1,
    backgroundColor: 'rgba(245,163,0,0.06)',
  },
  stPin: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  stBody: { flex: 1, minWidth: 0 },
  stLabel: {
    fontFamily: FontFamily.bold,
    fontSize: 9.5,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  stVal: {
    fontFamily: FontFamily.bold,
    fontSize: 14,
    letterSpacing: -0.1,
    marginTop: 1,
  },
  stChange: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  stChangeText: {
    fontFamily: FontFamily.bold,
    fontSize: 12,
  },

  sectionTitle: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
    marginTop: 22,
    marginBottom: 10,
    marginHorizontal: 2,
  },
  sectionNum: {
    fontFamily: FontFamily.bold,
    fontSize: 10,
    letterSpacing: 1.4,
    color: '#F5A300',
  },
  sectionLbl: {
    fontFamily: FontFamily.bold,
    fontSize: 14,
    letterSpacing: -0.1,
  },
  sectionHint: {
    fontFamily: FontFamily.medium,
    fontSize: 11,
    marginLeft: 'auto',
  },

  typeGrid: {
    flexDirection: 'row',
    gap: 8,
  },
  typeTile: {
    flex: 1,
    borderRadius: 14,
    padding: 14,
    paddingBottom: 12,
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
  },
  tileIcon: {
    width: 34,
    height: 34,
    borderRadius: 99,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileLbl: {
    fontFamily: FontFamily.semibold,
    fontSize: 12.5,
  },

  fieldStack: { gap: 10 },
  fieldRow: { flexDirection: 'row', gap: 10 },

  ff: {
    flex: 1,
    height: 52,
    borderRadius: 13,
    paddingHorizontal: 14,
    justifyContent: 'center',
    borderWidth: 1,
  },
  ffFocused: {
    shadowColor: '#F5A300',
    shadowOpacity: 0.14,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 },
    elevation: 3,
  },
  ffInput: {
    fontFamily: FontFamily.medium,
    fontSize: 14,
    height: 44,
    paddingVertical: 0,
  },
  optTag: {
    position: 'absolute',
    top: 10,
    right: 12,
    fontFamily: FontFamily.semibold,
    fontSize: 9.5,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },

  phoneGrouped: {
    flexDirection: 'row',
    height: 58,
    borderRadius: 13,
    overflow: 'hidden',
    borderWidth: 1,
  },
  ccSel: {
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRightWidth: 1,
  },
  flagEmoji: { fontSize: 18 },
  ccText: {
    fontFamily: FontFamily.bold,
    fontSize: 14,
  },
  phoneInput: {
    flex: 1,
    fontFamily: FontFamily.medium,
    fontSize: 14,
    paddingHorizontal: 14,
    paddingVertical: 0,
  },
  errorText: {
    fontFamily: FontFamily.medium,
    fontSize: 11,
    marginTop: -4,
    marginLeft: 4,
  },

  defaultRow: {
    marginTop: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 14,
    paddingHorizontal: 16,
    borderRadius: 14,
    borderWidth: 1,
  },
  drBody: { flex: 1 },
  drTitle: {
    fontFamily: FontFamily.bold,
    fontSize: 13.5,
    letterSpacing: -0.1,
  },
  drSub: {
    fontFamily: FontFamily.medium,
    fontSize: 11.5,
    marginTop: 2,
  },

  saveDock: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    paddingBottom: Platform.OS === 'ios' ? 22 : 16,
    paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  saveBtn: {
    height: 56,
    borderRadius: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  saveBtnEnabled: {
    backgroundColor: '#F5A300',
    shadowColor: '#F5A300',
    shadowOpacity: 0.4,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  },
  saveBtnDisabled: {
    borderWidth: 1,
  },
  saveBtnText: {
    fontFamily: FontFamily.bold,
    fontSize: 15,
    letterSpacing: 0.1,
    color: '#0D0D0F',
  },
});
