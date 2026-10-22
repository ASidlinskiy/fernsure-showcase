// FernSure: excerpt shared for review. Complete file. pickTrackingParams (the 19-key allowlist) lives in tracking-keys.js, not included.
// Source: src/js/core/attribution.js in the private FernSure repository, commit 154dea9.
// Copyright (c) 2026 Alex Sidlinskiy. All rights reserved. Not licensed for reuse: see NOTICE.md.

// @ts-check
/**
 * Attribution rules as pure functions, so they can be tested without a browser.
 *
 * Policy: last tagged click, 30-day window.
 * - Only a visit carrying an allowlisted UTM, click ID or affiliate param is a
 *   touch. That is the affiliate-network rule, not GA's last non-direct click,
 *   where organic search and referrals would take the credit.
 * - A tagged visit replaces the whole last touch. It never merges, so an old
 *   Instagram fbclid can't ride along on a later Google click.
 * - Untagged visits (direct, organic search, untagged referral, internal
 *   navigation) change nothing.
 * - The window slides: every tagged click restarts the 30 days. The first
 *   touch is the first click of the current unbroken chain, so it can be
 *   older than 30 days. It resets only after 30 days with no tagged click.
 */
import { pickTrackingParams } from './tracking-keys.js';

export const WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * @typedef {{
 *   params: Record<string, string>,
 *   dropped: string[],
 *   captured_at: string,
 *   landing_path: string,
 *   referrer: string,
 * }} Touch
 */
/**
 * @typedef {{
 *   last_touch: Touch,
 *   first_touch: Touch,
 *   touch_count: number,
 *   expires_at: string,
 * }} Attribution
 */

/**
 * Keeps the referrer's origin and path only: another site's query string is
 * none of our business, and it can carry their visitors' data.
 * @param {string} referrer
 */
export function cleanReferrer(referrer) {
  if (!referrer) return '';
  try {
    const r = new URL(referrer);
    return r.origin + r.pathname;
  } catch {
    return '';
  }
}

/**
 * @param {string} url
 * @param {{ referrer?: string, now?: Date }} [opts]
 * @returns {Touch | null} null when the URL carries no allowlisted params
 */
export function touchFromUrl(url, { referrer = '', now = new Date() } = {}) {
  const u = new URL(url);
  const { params, dropped } = pickTrackingParams(u.searchParams);
  if (Object.keys(params).length === 0) return null;
  return {
    params,
    dropped,
    captured_at: now.toISOString(),
    landing_path: u.pathname,
    referrer: cleanReferrer(referrer),
  };
}

/**
 * @param {Attribution | null | undefined} state
 * @param {Date} [now]
 */
export function isExpired(state, now = new Date()) {
  return !state || !(Date.parse(state.expires_at) > now.getTime());
}

/** @param {unknown} v @returns {v is Record<string, any>} */
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** @param {unknown} t */
const isTouch = (t) => isRecord(t) && isRecord(t.params);

/**
 * Storage is editable in DevTools, and a later deploy could change the shape:
 * a record counts only if it is unexpired and has the shape this code writes.
 * @param {unknown} state whatever storage held
 * @param {Date} [now]
 * @returns {Attribution | null}
 */
export function liveAttribution(state, now = new Date()) {
  if (!isRecord(state) || !isTouch(state.last_touch) || !isTouch(state.first_touch)) return null;
  const attribution = /** @type {Attribution} */ (state);
  return isExpired(attribution, now) ? null : attribution;
}

/**
 * @param {unknown} state current stored state (may be expired or malformed)
 * @param {Touch} touch a new tagged visit
 * @param {Date} [now]
 * @returns {Attribution}
 */
export function applyTouch(state, touch, now = new Date()) {
  const live = liveAttribution(state, now);
  return {
    last_touch: touch,
    first_touch: live ? live.first_touch : touch,
    touch_count: (live && Number.isInteger(live.touch_count) ? live.touch_count : 0) + 1,
    expires_at: new Date(now.getTime() + WINDOW_DAYS * DAY_MS).toISOString(),
  };
}

/**
 * The whole capture decision for one page load.
 * @param {{
 *   state: unknown,
 *   url: string,
 *   navigationType: string,
 *   referrer?: string,
 *   now?: Date,
 * }} input
 * @returns {{ state: Attribution | null, captured: boolean }}
 */
export function resolveAttribution({ state, url, navigationType, referrer = '', now = new Date() }) {
  const live = liveAttribution(state, now);
  // A reload or Back/Forward revisits a URL the visitor already arrived on. It is not a new click.
  if (navigationType === 'reload' || navigationType === 'back_forward') {
    return { state: live, captured: false };
  }
  const touch = touchFromUrl(url, { referrer, now });
  if (!touch) return { state: live, captured: false };
  return { state: applyTouch(live, touch, now), captured: true };
}
