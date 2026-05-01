// SDUI analytics emitter. logEvent is the single sink for every sdui_* event;
// today it just writes a structured console.info line, but keeping every call
// site funnelled through one helper makes a real backend integration a one-
// file swap later.
//
// Impression tracking is module-scoped so it survives across screens for the
// life of the JS bundle (i.e. one session). Each (page, section) fires once.

import { analyticsContext } from './context';

const firedImpressions = new Set<string>();

/** Single sink for all SDUI analytics. Replace the body when wiring a real
 *  analytics SDK; every sdui_* event in the codebase already routes here. */
export function logEvent(name: string, payload: object): void {
  // Structured log so log scrapers can pick the events up before a real
  // analytics SDK is wired.
  // eslint-disable-next-line no-console
  console.info(`[analytics] ${name}`, payload);
}

/** Fires `sdui_section_impression` exactly once per session for a given
 *  sectionId. Safe to call from a useEffect on every mount. */
export function trackImpression(
  sectionId: string,
  sectionType: string,
  position: number,
): void {
  if (firedImpressions.has(sectionId)) return;
  firedImpressions.add(sectionId);

  logEvent('sdui_section_impression', {
    section_id:   sectionId,
    section_type: sectionType,
    position,
    ...analyticsContext,
  });
}

/** Test/dev helper — clears the per-session impression set. Use sparingly:
 *  most production code should never need this. */
export function resetImpressionsForSession(): void {
  firedImpressions.clear();
}
