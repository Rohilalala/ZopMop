// ChatScreen — in-app messaging between the customer and the assigned pro.
// Dark theme matching BookingConfirmed / TrackLive (amber accent, glass header).
//
// Polls GET /bookings/:id/messages every 5 s; POST on send. Optimistic append
// keeps the UX snappy without waiting for the round trip.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextStyle,
} from 'react-native';
import { LoadingSkeleton } from '../../components/skeletons/LoadingSkeleton';
import { FlashList } from '@shopify/flash-list';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import { Feather } from '@expo/vector-icons';

import type { MainStackParamList } from '../../types/navigation';
import { useAuth } from '../../context/AuthContext';
import { listMessages, sendMessage, type BookingMessage } from '../../api/messages';

const fontMed:   TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };
const fontBold:  TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };

const AMBER = '#F5A300';

export default function ChatScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const route = useRoute<RouteProp<MainStackParamList, 'Chat'>>();
  const insets = useSafeAreaInsets();
  const { token, user } = useAuth();

  const { bookingId, helperName } = route.params;
  const myId = user?.id;

  const [messages, setMessages] = useState<BookingMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const listRef = useRef<FlashList<BookingMessage>>(null);

  // ── Poll history ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!token || token === '__guest__' || !bookingId) return;
    let alive = true;

    const tick = async () => {
      try {
        const next = await listMessages(token, bookingId);
        if (!alive) return;
        setMessages((prev) => mergeById(prev, next));
        setLoaded(true);
        setError(null);
      } catch (e: any) {
        if (!alive) return;
        if (!loaded) setError(e?.message ?? 'Failed to load chat');
      }
    };

    tick();
    const id = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(id); };
  }, [token, bookingId, loaded]);

  // Scroll to bottom whenever messages grow.
  useEffect(() => {
    if (messages.length === 0) return;
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: true });
    });
  }, [messages.length]);

  const onSend = useCallback(async () => {
    const body = draft.trim();
    if (!body || sending || !token || token === '__guest__') return;
    setSending(true);
    setDraft('');

    // Optimistic message — replaced once server responds.
    const tempId = `tmp-${Date.now()}`;
    const optimistic: BookingMessage = {
      id: tempId,
      booking_id: bookingId,
      sender_id: myId ?? '',
      sender_role: 'customer',
      body,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);

    try {
      const real = await sendMessage(token, bookingId, body);
      setMessages((prev) => prev.map((m) => (m.id === tempId ? real : m)));
    } catch (e: any) {
      // Roll back optimistic message + restore draft so user can retry.
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      setDraft(body);
      setError(e?.message ?? 'Failed to send');
    } finally {
      setSending(false);
    }
  }, [draft, sending, token, bookingId, myId]);

  const headerName = helperName ?? 'Your pro';
  const headerInitial = headerName[0].toUpperCase();

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" />

      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable
          onPress={() => navigation.goBack()}
          style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.6 }]}
        >
          <Feather name="chevron-left" size={20} color="#FFFFFF" />
        </Pressable>
        <View style={styles.headerAvatar}>
          <Text style={[fontExtra, { color: '#0D0D0F', fontSize: 15 }]}>{headerInitial}</Text>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[fontExtra, styles.headerName]} numberOfLines={1}>{headerName}</Text>
          <Text style={[fontMed, styles.headerSub]} numberOfLines={1}>In-app chat</Text>
        </View>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
      >
        {/* Messages */}
        {!loaded && !error ? (
          <LoadingSkeleton variant="bubbles" rows={6} />
        ) : error && messages.length === 0 ? (
          <View style={styles.loadingWrap}>
            <Text style={[fontMed, styles.errorText]}>{error}</Text>
          </View>
        ) : (
          <FlashList
            ref={listRef}
            data={messages}
            keyExtractor={(m) => m.id}
            contentContainerStyle={styles.listContent}
            estimatedItemSize={80}
            renderItem={({ item }) => (
              <Bubble msg={item} mine={item.sender_id === myId} />
            )}
            ListEmptyComponent={
              <View style={styles.emptyWrap}>
                <Feather name="message-circle" size={28} color="rgba(255,255,255,0.3)" />
                <Text style={[fontMed, styles.emptyText]}>
                  Say hi — share gate code, parking notes or anything {headerName.split(' ')[0]} should know.
                </Text>
              </View>
            }
          />
        )}

        {/* Composer */}
        <View style={[styles.composer, { paddingBottom: insets.bottom + 10 }]}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Message your pro…"
            placeholderTextColor="rgba(255,255,255,0.35)"
            style={[fontMed, styles.input]}
            multiline
            maxLength={2000}
          />
          <Pressable
            onPress={onSend}
            disabled={sending || draft.trim().length === 0}
            style={({ pressed }) => [
              styles.sendBtn,
              (sending || draft.trim().length === 0) && { opacity: 0.4 },
              pressed && { opacity: 0.8 },
            ]}
          >
            <Feather name="send" size={16} color="#0D0D0F" />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

// ── Bubble ───────────────────────────────────────────────────────────────────

function Bubble({ msg, mine }: { msg: BookingMessage; mine: boolean }) {
  const time = formatTime(msg.created_at);
  return (
    <View style={[styles.row, mine ? styles.rowMine : styles.rowTheirs]}>
      <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
        <Text style={[fontMed, mine ? styles.bodyMine : styles.bodyTheirs]}>{msg.body}</Text>
      </View>
      <Text style={[fontMed, styles.time]}>{time}</Text>
    </View>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function mergeById(prev: BookingMessage[], next: BookingMessage[]): BookingMessage[] {
  // Keep optimistic temp messages that haven't been confirmed yet.
  const temp = prev.filter((m) => m.id.startsWith('tmp-'));
  const seen = new Set(next.map((m) => m.id));
  const tempUnconfirmed = temp.filter((m) => !seen.has(m.id));
  return [...next, ...tempUnconfirmed].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0A0A0A' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingBottom: 14,
    borderBottomWidth: 0.5,
    borderBottomColor: 'rgba(255,255,255,0.06)',
    backgroundColor: 'rgba(15,15,17,0.95)',
  },
  iconBtn: {
    width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  headerAvatar: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: AMBER,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.5)',
  },
  headerName: {
    color: '#FFFFFF', fontSize: 15, letterSpacing: -0.2,
  },
  headerSub: {
    color: 'rgba(255,255,255,0.5)', fontSize: 11, marginTop: 2,
  },

  listContent: { padding: 16, paddingBottom: 24, gap: 6 },

  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  errorText: { color: 'rgba(255,255,255,0.6)', fontSize: 13 },

  emptyWrap: {
    paddingVertical: 80,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 36,
  },
  emptyText: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
  },

  row: {
    marginVertical: 4,
    maxWidth: '85%',
    gap: 3,
  },
  rowMine:   { alignSelf: 'flex-end', alignItems: 'flex-end' },
  rowTheirs: { alignSelf: 'flex-start', alignItems: 'flex-start' },

  bubble: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
  },
  bubbleMine: {
    backgroundColor: AMBER,
    borderTopRightRadius: 6,
  },
  bubbleTheirs: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderTopLeftRadius: 6,
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  bodyMine:   { color: '#0D0D0F', fontSize: 14, lineHeight: 20 },
  bodyTheirs: { color: '#FFFFFF', fontSize: 14, lineHeight: 20 },
  time: {
    color: 'rgba(255,255,255,0.35)',
    fontSize: 10,
    paddingHorizontal: 4,
  },

  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 10,
    borderTopWidth: 0.5,
    borderTopColor: 'rgba(255,255,255,0.06)',
    backgroundColor: 'rgba(15,15,17,0.95)',
  },
  input: {
    flex: 1,
    minHeight: 42,
    maxHeight: 120,
    paddingHorizontal: 14,
    paddingTop: 11,
    paddingBottom: 11,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.08)',
    color: '#FFFFFF',
    fontSize: 14,
  },
  sendBtn: {
    width: 42, height: 42, borderRadius: 21,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: AMBER,
    shadowColor: AMBER,
    shadowOpacity: 0.4,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
});
