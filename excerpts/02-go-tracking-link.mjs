// FernSure: excerpt shared for review. Complete file. The Netlify function entry point that wraps it is a few lines of route config.
// Source: netlify/lib/go-handler.mjs in the private FernSure repository, commit 6af5403.
// Copyright (c) 2026 Alex Sidlinskiy. All rights reserved. Not licensed for reuse: see NOTICE.md.

// @ts-check
/**
 * GET /go, the tracking link. A real 302 rather than a JavaScript redirect:
 * the browser keeps the original referrer, and ad platforms see a server-side
 * hop. It forwards allowlisted params only and mints a click_id, the way an
 * affiliate network mints a transaction ID. No storage, cookie or write.
 */
import { randomUUID } from 'node:crypto';
import { pickTrackingParams } from '../../src/js/core/tracking-keys.js';

/**
 * @param {{ newId?: () => string, warn?: (...args: unknown[]) => void }} [deps] injectable for tests
 */
export function createGoHandler({ newId = randomUUID, warn = console.warn } = {}) {
  /** @param {Request} req */
  return async function handleGo(req) {
    // Decoded once by URLSearchParams and re-encoded below, so the values
    // arrive unchanged even where the encoding differs (%20 becomes +).
    const { params, dropped } = pickTrackingParams(new URL(req.url).searchParams);
    // A dropped key never reaches the landing page, so the browser can't report
    // it: this is the only trace. Key names only; the values are the visitor's.
    if (dropped.length) warn('[go] dropped tracking keys (over-long or invalid):', dropped.join(', '));
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      // Every click gets a fresh ID; one carried in on a shared link is replaced.
      if (key !== 'click_id') query.set(key, value);
    }
    query.set('click_id', newId());

    // Built by hand because Response.redirect() rejects relative URLs in Node 24.
    // A relative Location also means no request data can choose the host.
    return new Response(null, {
      status: 302,
      headers: {
        Location: `/?${query}`,
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex',
      },
    });
  };
}
