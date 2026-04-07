/**
 * Holds the currently applied promo code across the Offers → Cart flow.
 * A simple module-level singleton avoids prop-drilling or extra context.
 */
let _code: string | null = null;

export const promoStore = {
  set(code: string) { _code = code; },
  get(): string | null { return _code; },
  clear() { _code = null; },
};
