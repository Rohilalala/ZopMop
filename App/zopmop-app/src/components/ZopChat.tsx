// ZopChat — floating glass-morphism toast that hovers above the BottomTabBar.
//
// Replaces the previous full-screen Modal. Pops up just above the navbar with
// a dark glass panel (linear gradient + amber radial glow + inner highlight
// border, mirroring BottomTabBar). Animates in/out via Reanimated.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Dimensions,
  FlatList,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';
import Svg, {
  Defs,
  LinearGradient as SvgLinearGradient,
  Rect,
  Stop,
} from 'react-native-svg';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Feather } from '@expo/vector-icons';
import ZopFull from '../../assets/zop/zop-full.svg';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { clearZopHistory, sendZopMessage } from '../services/zopService';
import ZopChatBubble from './ZopChatBubble';
import ZopBookingCard, { type ZopBookingData } from './ZopBookingCard';
import ZopSlotCard, { type ZopSlot, type ZopSlotPeriod } from './ZopSlotCard';
import ZopBookingsList, { type ZopBookingSummary } from './ZopBookingsList';
import ZopQuickReplies from './ZopQuickReplies';
import type { ZopQuickReply } from '../services/zopService';

const AMBER = '#F5A300';

const STORAGE_SESSION = 'zop_session_id';
const STORAGE_MESSAGES = 'zop_messages';
const STORAGE_LAST_ACTIVE = 'zop_last_active';
const STALE_AFTER_MS = 6 * 60 * 60 * 1000; // 6h

const SCREEN_H = Dimensions.get('window').height;
// Sits just above the BottomTabBar pill + Zop mascot overhang.
const TOAST_BOTTOM = 124;
const TOAST_MAX_HEIGHT = Math.min(600, SCREEN_H * 0.70);
// Reserve space at the top so the toast never collides with status bar /
// notch when the keyboard pushes it up.
const TOP_SAFE = 60;

interface ZopChatProps {
  visible: boolean;
  onClose: () => void;
}

interface UIMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isTyping?: boolean;
  booking?: ZopBookingData;
  slots?: ZopSlotPeriod[];
  slotsInitialPeriod?: string;
  bookingsList?: ZopBookingSummary[];
  quickReplies?: ZopQuickReply[];
}

const BOOKING_CREATE_ACTIONS = new Set([
  'create_booking',
  'create_scheduled_booking',
  'create_instant_booking',
]);

function bookingFromAction(
  action: string | null,
  data: unknown,
): ZopBookingData | undefined {
  if (!action || !BOOKING_CREATE_ACTIONS.has(action)) return undefined;
  if (!data || typeof data !== 'object') return undefined;
  const obj = data as Record<string, unknown>;
  if (typeof obj.id !== 'string') return undefined;
  return obj as unknown as ZopBookingData;
}

/**
 * Parse the get_available_slots response shape into the card's input. Returns
 * undefined when action isn't a slots fetch or data doesn't look right.
 */
function slotsFromAction(
  action: string | null,
  data: unknown,
): ZopSlotPeriod[] | undefined {
  if (action !== 'get_available_slots') return undefined;
  if (!Array.isArray(data)) return undefined;
  const periods: ZopSlotPeriod[] = [];
  for (const p of data as unknown[]) {
    if (!p || typeof p !== 'object') continue;
    const o = p as Record<string, unknown>;
    if (typeof o.label !== 'string' || !Array.isArray(o.slots)) continue;
    const slots: ZopSlot[] = [];
    for (const s of o.slots as unknown[]) {
      if (!s || typeof s !== 'object') continue;
      const so = s as Record<string, unknown>;
      if (typeof so.id !== 'string' || typeof so.start_time !== 'string') continue;
      slots.push(so as unknown as ZopSlot);
    }
    if (slots.length) periods.push({ label: o.label, slots });
  }
  return periods.length ? periods : undefined;
}

/**
 * Parse the get_bookings response into the bookings-list card input. Returns
 * undefined when action isn't a bookings fetch or the data is empty.
 */
function bookingsListFromAction(
  action: string | null,
  data: unknown,
): ZopBookingSummary[] | undefined {
  if (action !== 'get_bookings') return undefined;
  if (!Array.isArray(data) || data.length === 0) return undefined;
  const out: ZopBookingSummary[] = [];
  for (const b of data as unknown[]) {
    if (!b || typeof b !== 'object') continue;
    const o = b as Record<string, unknown>;
    if (typeof o.id !== 'string') continue;
    out.push(o as unknown as ZopBookingSummary);
  }
  return out.length ? out : undefined;
}

/**
 * Pick the period the user most recently named in their own messages. Returns
 * the matching period label (capitalized) or undefined. Used to seed the slot
 * card on the right tab.
 */
function detectPeriodFromText(text: string): string | undefined {
  const t = text.toLowerCase();
  if (/\bevening\b/.test(t)) return 'Evening';
  if (/\bafternoon\b/.test(t)) return 'Afternoon';
  if (/\bmorning\b/.test(t)) return 'Morning';
  return undefined;
}

function newSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const WELCOME: UIMessage = {
  id: 'welcome',
  role: 'assistant',
  content: "Hey! I'm Zop — what can I help you sort out today?",
};

async function clearStorage() {
  await Promise.all([
    AsyncStorage.removeItem(STORAGE_SESSION),
    AsyncStorage.removeItem(STORAGE_MESSAGES),
    AsyncStorage.removeItem(STORAGE_LAST_ACTIVE),
  ]);
}

export default function ZopChat({ visible, onClose }: ZopChatProps) {
  const { token } = useAuth();
  const { isDark, colors: c } = useTheme();
  const sessionIdRef = useRef<string>('');
  const listRef = useRef<FlatList<UIMessage>>(null);

  const [messages, setMessages] = useState<UIMessage[]>([WELCOME]);
  const [inputText, setInputText] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  // Mounted flag — keeps the toast in the tree during the slide-out animation
  // before unmounting.
  const [mounted, setMounted] = useState(visible);

  const progress = useSharedValue(visible ? 1 : 0);
  // Tracks keyboard height so the toast can lift above it. KeyboardAvoidingView
  // doesn't behave well with bottom-anchored absolute layouts — manual offset
  // keeps the entire toast (including input bar) on-screen on every device.
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, (e) => {
      setKeyboardHeight(e.endCoordinates?.height ?? 0);
    });
    const hideSub = Keyboard.addListener(hideEvt, () => setKeyboardHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      progress.value = withTiming(1, {
        duration: 240,
        easing: Easing.out(Easing.cubic),
      });
    } else {
      progress.value = withTiming(
        0,
        { duration: 200, easing: Easing.in(Easing.cubic) },
        (finished) => {
          if (finished) runOnJS(setMounted)(false);
        },
      );
    }
  }, [visible, progress]);

  const animStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [
      { translateY: (1 - progress.value) * 24 },
      { scale: 0.98 + progress.value * 0.02 },
    ],
  }));

  // ── Persistence + hydration ─────────────────────────────────────────────
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    (async () => {
      try {
        const [sid, raw, lastActive] = await Promise.all([
          AsyncStorage.getItem(STORAGE_SESSION),
          AsyncStorage.getItem(STORAGE_MESSAGES),
          AsyncStorage.getItem(STORAGE_LAST_ACTIVE),
        ]);
        const lastTs = lastActive ? parseInt(lastActive, 10) : 0;
        const stale = !lastTs || Date.now() - lastTs > STALE_AFTER_MS;
        if (cancelled) return;
        if (stale || !sid || !raw) {
          await clearStorage();
          const fresh = newSessionId();
          sessionIdRef.current = fresh;
          await AsyncStorage.setItem(STORAGE_SESSION, fresh);
          setMessages([WELCOME]);
        } else {
          sessionIdRef.current = sid;
          try {
            const parsed = JSON.parse(raw) as UIMessage[];
            setMessages(Array.isArray(parsed) && parsed.length ? parsed : [WELCOME]);
          } catch {
            setMessages([WELCOME]);
          }
        }
      } catch {
        sessionIdRef.current = newSessionId();
        setMessages([WELCOME]);
      } finally {
        if (!cancelled) {
          setInputText('');
          setIsTyping(false);
          setHydrated(true);
        }
      }
    })();
    return () => {
      cancelled = true;
      setHydrated(false);
    };
  }, [visible]);

  useEffect(() => {
    if (!visible || !hydrated) return;
    const persistable = messages.filter((m) => !m.isTyping);
    AsyncStorage.setItem(STORAGE_MESSAGES, JSON.stringify(persistable)).catch(() => {});
    AsyncStorage.setItem(STORAGE_LAST_ACTIVE, String(Date.now())).catch(() => {});
  }, [messages, visible, hydrated]);

  // ── Send ────────────────────────────────────────────────────────────────
  const sendText = useCallback(async (text: string) => {
    if (!text || isTyping || !token) return;

    const userMsg: UIMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: text,
    };
    const typingMsg: UIMessage = {
      id: `t-${Date.now()}`,
      role: 'assistant',
      content: '',
      isTyping: true,
    };
    setMessages((prev) => [...prev, userMsg, typingMsg]);
    setIsTyping(true);

    try {
      const resp = await sendZopMessage(token, text, sessionIdRef.current);
      const booking = bookingFromAction(resp.action_taken, resp.data);
      const slots = slotsFromAction(resp.action_taken, resp.data);
      const bookingsList = bookingsListFromAction(resp.action_taken, resp.data);
      const initialPeriod = slots ? detectPeriodFromText(text) : undefined;
      // Quick-reply chips suppress the slot-card carousel — chips already
      // cover the period question; once user picks, follow-up turn shows
      // the slot card.
      const quickReplies = resp.quick_replies ?? undefined;
      const useSlots = slots && (!quickReplies || quickReplies.length === 0);
      setMessages((prev) =>
        prev
          .filter((m) => !m.isTyping)
          .concat({
            id: `a-${Date.now()}`,
            role: 'assistant',
            content: booking ? '' : resp.reply,
            booking,
            slots: useSlots ? slots : undefined,
            slotsInitialPeriod: initialPeriod,
            bookingsList,
            quickReplies,
          }),
      );
    } catch (err) {
      const serverMsg = err instanceof Error ? err.message : '';
      const fallback = "I'm having a little trouble right now. Please try again!";
      setMessages((prev) =>
        prev
          .filter((m) => !m.isTyping)
          .concat({
            id: `e-${Date.now()}`,
            role: 'assistant',
            content: serverMsg || fallback,
          }),
      );
    } finally {
      setIsTyping(false);
    }
  }, [isTyping, token]);

  // Wrapper used by the input bar — drains the input text and forwards.
  const handleSend = useCallback(() => {
    const text = inputText.trim();
    if (!text) return;
    setInputText('');
    void sendText(text);
  }, [inputText, sendText]);

  // Slot card pick — fires user message in a friendly format the LLM can
  // map back to a real time_slot_id (its tool result already has the IDs).
  const sendSlotPick = useCallback(
    (slot: ZopSlot) => {
      const label = `${slot.start_time} - ${slot.end_time}`;
      void sendText(label);
    },
    [sendText],
  );

  const handleClearChat = useCallback(async () => {
    if (token) {
      await clearZopHistory(token);
    }
    await clearStorage();
    const fresh = newSessionId();
    sessionIdRef.current = fresh;
    await AsyncStorage.setItem(STORAGE_SESSION, fresh);
    setMessages([WELCOME]);
    setInputText('');
    setIsTyping(false);
  }, [token]);

  if (!mounted) return null;

  const data = [...messages].reverse();
  const sendDisabled = inputText.trim().length === 0 || isTyping;

  // When keyboard is up, lift toast just above it (with a small gap). Otherwise
  // park it at the original resting spot above the BottomTabBar.
  const dynamicBottom = keyboardHeight > 0 ? keyboardHeight + 8 : TOAST_BOTTOM;
  // Cap height so the top of the toast never falls behind the status bar.
  const dynamicMaxHeight = Math.min(
    TOAST_MAX_HEIGHT,
    SCREEN_H - dynamicBottom - TOP_SAFE,
  );
  // FlatList carves out room for the input bar (~56) + corner buttons (~36) +
  // padding. Subtract a generous chunk so cards never get clipped.
  const listMaxHeight = Math.max(120, dynamicMaxHeight - 110);

  return (
    <View
      pointerEvents="box-none"
      style={{
        // Extend up over the whole screen — the toast is mounted inside the
        // BottomTabBar's bottom-anchored container, so we negative-offset the
        // wrapper to cover the full viewport for the tap-out scrim.
        position: 'absolute',
        top: -SCREEN_H,
        left: 0, right: 0, bottom: 0,
      }}
    >
      {/* Tap-out scrim — closes the toast on outside taps */}
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />

      <Animated.View
        pointerEvents="box-none"
        style={[
          {
            position: 'absolute',
            left: 12,
            right: 12,
            bottom: dynamicBottom,
            maxHeight: dynamicMaxHeight,
          },
          animStyle,
        ]}
      >
        <View style={[
          styles.glass,
          !isDark && {
            // Near-solid so chat text stays readable over busy content (0.75
            // let the home screen bleed through too much).
            backgroundColor: 'rgba(255,255,255,0.985)',
            borderColor: 'rgba(13,13,15,0.08)',
          },
        ]}>
            {/* Glass background — base gradient (dark only; light uses solid bg) */}
            {isDark && (
            <Svg
              width="100%"
              height="100%"
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            >
              <Defs>
                <SvgLinearGradient id="zopGlassBg" x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0%"   stopColor="#1C1C22" stopOpacity="0.94" />
                  <Stop offset="100%" stopColor="#15151A" stopOpacity="0.94" />
                </SvgLinearGradient>
              </Defs>
              <Rect width="100%" height="100%" fill="url(#zopGlassBg)" />
            </Svg>
            )}

            {/* Floating controls — trash on left, close on right. No header
                bar, no title. */}
            <Pressable
              onPress={handleClearChat}
              hitSlop={10}
              style={[
                styles.cornerLeft,
                !isDark && {
                  backgroundColor: 'rgba(13,13,15,0.05)',
                  borderColor: 'rgba(13,13,15,0.08)',
                },
              ]}
            >
              <Feather name="trash-2" size={16} color={isDark ? 'rgba(255,255,255,0.55)' : 'rgba(13,13,15,0.45)'} />
            </Pressable>
            <Pressable
              onPress={onClose}
              hitSlop={10}
              style={[
                styles.cornerRight,
                !isDark && {
                  backgroundColor: 'rgba(13,13,15,0.05)',
                  borderColor: 'rgba(13,13,15,0.08)',
                },
              ]}
            >
              <Feather name="x" size={18} color={isDark ? '#FFFFFF' : c.text} />
            </Pressable>

            {/* Messages */}
            <FlatList
              ref={listRef}
              data={data}
              inverted
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.listContent}
              ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
              renderItem={({ item }) => {
                if (item.booking) {
                  return (
                    <View style={styles.cardRow}>
                      <View style={styles.cardAvatar}>
                        <ZopFull width={26} height={26} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <ZopBookingCard booking={item.booking} onCloseChat={onClose} />
                      </View>
                    </View>
                  );
                }
                if (item.slots) {
                  return (
                    <View style={styles.cardRow}>
                      <View style={styles.cardAvatar}>
                        <ZopFull width={26} height={26} />
                      </View>
                      <View style={{ flex: 1 }}>
                        {item.content ? (
                          <View style={{ marginBottom: 8 }}>
                            <ZopChatBubble role="assistant" content={item.content} />
                          </View>
                        ) : null}
                        <ZopSlotCard
                          periods={item.slots}
                          initialPeriod={item.slotsInitialPeriod}
                          onPick={(slot) => sendSlotPick(slot)}
                        />
                      </View>
                    </View>
                  );
                }
                if (item.bookingsList) {
                  return (
                    <View style={styles.cardRow}>
                      <View style={styles.cardAvatar}>
                        <ZopFull width={26} height={26} />
                      </View>
                      <View style={{ flex: 1 }}>
                        {item.content ? (
                          <View style={{ marginBottom: 8 }}>
                            <ZopChatBubble role="assistant" content={item.content} />
                          </View>
                        ) : null}
                        <ZopBookingsList
                          bookings={item.bookingsList}
                          onCloseChat={onClose}
                        />
                      </View>
                    </View>
                  );
                }
                return (
                  <View>
                    <ZopChatBubble
                      role={item.role}
                      content={item.content}
                      isTyping={item.isTyping}
                    />
                    {item.role === 'assistant' && item.quickReplies?.length ? (
                      <View style={{ paddingLeft: 34 }}>
                        <ZopQuickReplies
                          replies={item.quickReplies}
                          onPick={(r) => void sendText(r.value)}
                        />
                      </View>
                    ) : null}
                  </View>
                );
              }}
              keyboardShouldPersistTaps="handled"
              style={{
                maxHeight: listMaxHeight,
                marginTop: 36, // clear absolute trash / close icons
              }}
            />

            {/* Input */}
            <View style={styles.inputBar}>
              <TextInput
                style={[styles.input, !isDark && { color: c.text }]}
                placeholder="Ask Zop anything…"
                placeholderTextColor={isDark ? 'rgba(255,255,255,0.35)' : c.textMuted}
                value={inputText}
                onChangeText={setInputText}
                onSubmitEditing={handleSend}
                returnKeyType="send"
                editable={!isTyping}
                multiline
                keyboardAppearance={isDark ? 'dark' : 'light'}
              />
              <Pressable
                onPress={handleSend}
                disabled={sendDisabled}
                hitSlop={10}
                style={[styles.sendBtn, sendDisabled && styles.sendBtnDisabled]}
              >
                <Feather name="send" size={20} color={AMBER} />
              </Pressable>
            </View>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  glass: {
    borderRadius: 22,
    overflow: 'hidden',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.10)',
    backgroundColor: '#1A1A1F',
    // iOS shadow
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.55,
    shadowRadius: 28,
    // Android
    elevation: 18,
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  cardAvatar: {
    width: 26,
    height: 26,
    marginRight: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cornerLeft: {
    position: 'absolute',
    top: 10,
    left: 10,
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.10)',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.22)',
    zIndex: 5,
  },
  cornerRight: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.10)',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.22)',
    zIndex: 5,
  },
  listContent: {
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    minHeight: 56,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  input: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 13,
    lineHeight: 18,
    fontFamily: 'PlusJakartaSans_400Regular',
    maxHeight: 80,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  sendBtn: {
    width: 36,
    height: 36,
    marginLeft: 6,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  sendBtnDisabled: {
    opacity: 1,
  },
});
