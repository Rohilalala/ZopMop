// SDUI types — single source of truth for the wire format.
// Bump CACHE_SCHEMA_VERSION in useSduiPage.ts whenever SduiSection shape changes.

import type { ApiService } from '../api/services';

// ── Design token refs ────────────────────────────────────────────────────────

export type ColorToken =
  | 'brand-primary'
  | 'brand-secondary'
  | 'surface'
  | 'surface-alt'
  | 'text-primary'
  | 'text-muted'
  | 'border';

// ── Layout (whitelist — server cannot send arbitrary ViewStyle) ──────────────

export interface SduiLayout {
  height?:            number;
  width?:             number | string;   // number or "100%"
  flex?:              number;
  flexDirection?:     'row' | 'column';
  alignItems?:        'flex-start' | 'center' | 'flex-end' | 'stretch';
  justifyContent?:    'flex-start' | 'center' | 'flex-end' | 'space-between';
  gap?:               number;
  zIndex?:            number;
  marginTop?:         number;
  marginBottom?:      number;
  marginHorizontal?:  number;
  paddingHorizontal?: number;
  paddingVertical?:   number;
  borderRadius?:      number;
  overflow?:          'hidden' | 'visible';
}

export interface SduiStyle {
  bg?:     ColorToken;
  fg?:     ColorToken;
  radius?: 'sm' | 'md' | 'lg' | 'full';
}

// ── Actions (discriminated union) ────────────────────────────────────────────

export type Trigger = 'tap' | 'long_press' | 'auto';

export type SduiAction =
  | { trigger: Trigger; type: 'navigate';     screen: string; params?: Record<string, unknown> }
  | { trigger: Trigger; type: 'bottom_sheet'; sheet_id: string; props?: Record<string, unknown> }
  | { trigger: Trigger; type: 'toast';        message: string; variant?: 'info' | 'success' | 'error' }
  | { trigger: Trigger; type: 'api_call';     endpoint: string; method: 'POST' | 'DELETE'; body?: Record<string, unknown> }
  | { trigger: Trigger; type: 'deep_link';    url: string }
  | { trigger: Trigger; type: 'load_more';    section_id: string; cursor: string; endpoint: string };

// ── Section data shapes ──────────────────────────────────────────────────────

export interface PromoSlide {
  key: string;
  eyebrow: string;
  title: string;
  body: string;
  cta: string;
  bg: string;
  accent: string;
  action: SduiAction;
  image_url?: string;
  /** Per-card autoplay dwell in ms (overrides carousel-level interval_ms). */
  duration_ms?: number;
}

export interface HeroCarouselData {
  greeting_name: string;
  slides: PromoSlide[];
  /** Auto-advance through pages. Default true. */
  autoplay?: boolean;
  /** Default dwell per page in ms when a slide has no duration_ms. Default 4000. */
  interval_ms?: number;
  /** Wrap from the last page back to the first. Default true. */
  loop?: boolean;
  /** For animated cards: remount (restart the animation) each time a card
   *  becomes the active page. Default false (animations run continuously). */
  restart_on_focus?: boolean;
}
export interface UsualsRowData     { services: ApiService[] }
export interface ServiceGridData   { title: string; services: ApiService[]; has_more?: boolean; cursor?: string }
export interface FooterScheduleCard { title: string; subtitle: string; action: SduiAction }
export interface FooterTrustColumn  { value: string; label: string }
export interface FooterSignoff      { lines: string[]; brand: string; badges: string[]; tagline: string }
export interface FooterData {
  schedule_card?: FooterScheduleCard | null;
  trust?:         { columns: FooterTrustColumn[] } | null;
  signoff:        FooterSignoff;
}
export interface GreetingHeroData { greeting?: string; title_lines?: string[]; show_mascot?: boolean }
export interface HeaderPromoData { label: string; amount_label?: string; action: SduiAction; visible?: boolean }
export interface UpcomingBookingData { visible?: boolean }

// ── Rollout control ──────────────────────────────────────────────────────────

export interface SduiRollout {
  min_client_version?: string;
  user_segment?:       'all' | 'premium' | 'new_user' | 'returning';
  percentage?:         number;
}

// ── Section (discriminated union) ────────────────────────────────────────────

export interface SduiSectionBase {
  id:             string;
  layout?:        SduiLayout;
  style?:         SduiStyle;
  actions?:       SduiAction[];
  visible:        boolean;       // BFF resolves any $ref before sending to client
  hydration?:     'eager' | 'lazy';
  lazy_endpoint?: string;
  rollout?:       SduiRollout;
  priority?:      'high' | 'medium' | 'low';
}

export type SduiSection =
  | (SduiSectionBase & { type: 'hero_carousel'; data: HeroCarouselData })
  | (SduiSectionBase & { type: 'usuals_row';    data: UsualsRowData })
  | (SduiSectionBase & { type: 'service_grid';  data: ServiceGridData })
  | (SduiSectionBase & { type: 'footer';        data: FooterData })
  | (SduiSectionBase & { type: 'greeting_hero'; data: GreetingHeroData })
  | (SduiSectionBase & { type: 'header_promo';  data: HeaderPromoData })
  | (SduiSectionBase & { type: 'upcoming_booking'; data: UpcomingBookingData });

export type SduiSectionType = SduiSection['type'];

// ── Page ────────────────────────────────────────────────────────────────────

export interface SduiPage {
  page_id:            string;
  version:            string;
  min_client_version: string;
  config_hash:        string;
  snapshot_at:        string;
  config_version:     string;
  experiment_id?:     string;
  sections:           SduiSection[];
}

// ── Lazy section response ────────────────────────────────────────────────────

export interface SduiLazySectionResponse {
  section_id: string;
  type:       SduiSectionType;
  data:       SduiSection['data'];
  cursor?:    string;
  has_more?:  boolean;
}
