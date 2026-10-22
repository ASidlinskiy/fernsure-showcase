// FernSure: excerpt shared for review. The setup and two of the 31 tests in this file; some imports serve the others. Test helpers are not included.
// Source: test/lead.test.mjs in the private FernSure repository, commit 154dea9.
// Copyright (c) 2026 Alex Sidlinskiy. All rights reserved. Not licensed for reuse: see NOTICE.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_BODY_BYTES, createLeadHandler } from '../netlify/lib/lead-handler.mjs';
import { upstreamForContext } from '../netlify/lib/upstream.mjs';
import { sha256Hex } from '../netlify/lib/hash.mjs';
import { CONSENT } from '../src/js/core/catalog.js';
import { isUuid } from '../src/js/core/ids.js';
import { MAX_VALUE_LENGTH, TRACKING_KEYS } from '../src/js/core/tracking-keys.js';
import {
  CONTEXT, INSTAGRAM, NOW, PII, TIKTOK, captureLogs, jsonRequest, leadBody, newSim, simUpstream, touch,
} from './helpers/backend.mjs';

/**
 * A lead handler wired to an in-memory simulator.
 * @param {{ sim?: ReturnType<typeof newSim>, fault?: string, secret?: string, timeoutMs?: number }} [options]
 */
function setup({ sim = newSim(), fault = '', secret, timeoutMs } = {}) {
  const logs = captureLogs();
  const upstream = simUpstream(sim, { fault, secret });
  const handler = createLeadHandler({ getUpstream: () => upstream, now: () => NOW, log: logs.log, timeoutMs });
  /** @param {unknown} body @param {Record<string, string>} [headers] */
  const post = async (body, headers) => {
    const res = await handler(jsonRequest('/api/lead', body, headers), CONTEXT);
    return { res, status: res.status, json: await res.json() };
  };
  return { sim, logs, post };
}

const generateLeadEvents = (sim) => sim.records('Events').filter((e) => e.event_name === 'generate_lead');

// ... (lines omitted) ...

test('an identical replay x3 gives one lead, one event, created:false and the same lead_id', async () => {
  const { sim, post } = setup();
  const body = leadBody();
  const first = await post(body);
  for (let i = 0; i < 3; i++) {
    const again = await post(body);
    assert.equal(again.status, 200);
    assert.equal(again.json.code, 'duplicate');
    assert.equal(again.json.created, false);
    assert.equal(again.json.lead_id, first.json.lead_id);
    assert.equal(again.json.event_id, first.json.event_id);
    assert.equal(again.json.received_at, first.json.received_at, 'a duplicate reports the original time');
  }
  assert.equal(sim.records('Leads').length, 1);
  assert.equal(generateLeadEvents(sim).length, 1);
});

test('a lost response followed by a retry still gives exactly one lead', async () => {
  const { sim, post } = setup({ fault: 'lose_response' });
  const body = leadBody();

  const lost = await post(body);
  assert.equal(lost.status, 502);
  assert.deepEqual(lost.json, { ok: false, code: 'upstream_error', retryable: true });
  assert.equal(sim.records('Leads').length, 1, 'the write happened; only the reply was lost');

  const retry = await post(body);
  assert.equal(retry.status, 200);
  assert.equal(retry.json.created, false);
  assert.equal(retry.json.lead_id, sim.records('Leads')[0].lead_id);
  assert.equal(sim.records('Leads').length, 1);
  assert.equal(generateLeadEvents(sim).length, 1);
});
