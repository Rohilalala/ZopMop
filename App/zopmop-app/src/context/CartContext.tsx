import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Animated } from 'react-native';
import { getCart, addToCart, removeFromCart, type ApiCart, type ApiCartItem } from '../api/cart';
import { useAuth } from './AuthContext';
import { showError } from '../utils/toast';
import { haptics } from '../utils/haptics';

// ── Types ─────────────────────────────────────────────────────────────────────

interface CartContextValue {
  items: ApiCartItem[];
  itemCount: number;
  subtotalCents: number;
  addItem: (serviceId: string, durationMinutes: number, serviceName: string, priceCents: number) => Promise<void>;
  removeItem: (itemId: string) => Promise<void>;
  refreshCart: () => Promise<void>;
  cartBadgeAnim: Animated.Value;
}

// ── Context ───────────────────────────────────────────────────────────────────

const CartContext = createContext<CartContextValue | null>(null);

export function CartProvider({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  const [cart, setCart] = useState<ApiCart | null>(null);
  const cartBadgeAnim = useRef(new Animated.Value(1)).current;

  const refreshCart = useCallback(async () => {
    if (!token) return;
    try {
      const data = await getCart(token);
      setCart(data);
    } catch {
      // Silently fail — cart is a convenience feature
    }
  }, [token]);

  useEffect(() => {
    refreshCart();
  }, [refreshCart]);

  const pulseBadge = useCallback(() => {
    Animated.sequence([
      Animated.timing(cartBadgeAnim, { toValue: 1.4, duration: 120, useNativeDriver: true }),
      Animated.spring(cartBadgeAnim, { toValue: 1, useNativeDriver: true }),
    ]).start();
  }, [cartBadgeAnim]);

  const addItem = useCallback(async (serviceId: string, durationMinutes: number, serviceName: string, priceCents: number) => {
    if (!token) return;
    haptics.medium();
    const snapshot = cart;
    const now = new Date().toISOString();
    const tempItem: ApiCartItem = {
      id: `tmp-${Date.now()}`,
      cart_id: snapshot?.id ?? 'tmp-cart',
      service_id: serviceId,
      service_name: serviceName,
      duration_minutes: durationMinutes,
      price_paise: priceCents,
    };
    const optimistic: ApiCart = snapshot
      ? { ...snapshot, items: [...snapshot.items, tempItem], updated_at: now }
      : { id: 'tmp-cart', user_id: '', items: [tempItem], created_at: now, updated_at: now };
    setCart(optimistic);
    pulseBadge();
    try {
      const updated = await addToCart(token, serviceId, durationMinutes);
      setCart(updated);
    } catch {
      setCart(snapshot);
      showError('Failed to update cart');
    }
  }, [token, cart, pulseBadge]); // serviceName + priceCents are args, not closured deps

  const removeItem = useCallback(async (itemId: string) => {
    if (!token) return;
    haptics.medium();
    const snapshot = cart;
    if (snapshot) {
      setCart({ ...snapshot, items: snapshot.items.filter(i => i.id !== itemId) });
    }
    try {
      const updated = await removeFromCart(token, itemId);
      setCart(updated);
    } catch {
      setCart(snapshot);
      showError('Failed to update cart');
    }
  }, [token, cart]);

  const items = cart?.items ?? [];
  const itemCount = items.length;
  const subtotalCents = items.reduce((sum, item) => sum + item.price_paise, 0);

  return (
    <CartContext.Provider value={{ items, itemCount, subtotalCents, addItem, removeItem, refreshCart, cartBadgeAnim }}>
      {children}
    </CartContext.Provider>
  );
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used within CartProvider');
  return ctx;
}
