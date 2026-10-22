// FernSure: excerpt shared for review. Selected functions: auth before the lock, the lock, the idempotent submit, repeat-lead flagging, event rows, lookup, RAW writes.
// Source: apps-script/Code.gs in the private FernSure repository, commit 154dea9.
// Copyright (c) 2026 Alex Sidlinskiy. All rights reserved. Not licensed for reuse: see NOTICE.md.

/**
 * FernSure lead endpoint: a Google Apps Script web app, bound to the lead
 * spreadsheet. The Netlify functions are its only intended caller.
 *
 * Contract (PLAN.md 4.5): every reply is JSON { ok, code, ..., script_version }.
 * doPost can't read request headers or set an HTTP status, so the shared
 * secret travels in the body and the Netlify function maps codes to statuses.
 *
 * Idempotency: one script lock serializes writers. A submission_id is looked
 * up before anything is written, and a lead row and its event row are appended
 * in the same execution, so a retried submit can't create a second lead.
 *
 * Repeat leads: a new submission from an email that produced a lead in the
 * last 30 days is saved but flagged (repeat_of), and its dry-run conversion
 * payloads are marked suppressed_repeat, so one person isn't paid for twice.
 * Replies say only repeat: true/false. Which lead it repeats stays in the
 * Sheet: strangers can type the same test address, and a lead_id is all
 * activate needs.
 *
 * Literal writes: rows go through the Sheets API with valueInputOption RAW,
 * so "=1+1" stays text and ZIP 02134 keeps its leading zero.
 *
 * Plain V8 Apps Script. The same file runs unchanged in netlify/lib/gas-sim.mjs
 * for local development and the tests.
 */

// ... (lines omitted) ...

function route_(request) {
  if (!request) return { ok: false, code: 'bad_request' };
  // Checked before taking the lock, so unauthenticated traffic never queues behind real leads.
  if (!secretMatches_(request.secret)) return { ok: false, code: 'auth' };
  if (SCHEMA_VERSIONS.indexOf(request.schema_version) === -1) return { ok: false, code: 'schema_mismatch' };

  let handler = null;
  if (request.action === 'submit_lead') handler = submitLead_;
  if (request.action === 'activate') handler = activate_;
  if (!handler) return { ok: false, code: 'bad_request' };

  return withScriptLock_(function () {
    return handler(request);
  });
}

/**
 * Apps Script runs up to 30 executions at once. Without the lock, two copies
 * of one submit could both miss the lookup and both append.
 */
function withScriptLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) return { ok: false, code: 'busy', retryable: true };
  try {
    return fn();
  } finally {
    // Flush before releasing, so the next execution reads what this one wrote.
    try {
      SpreadsheetApp.flush();
    } finally {
      lock.releaseLock();
    }
  }
}

function submitLead_(req) {
  if (!isText_(req.submission_id) || !isText_(req.payload_sha256) || !isObject_(req.lead) || !isObject_(req.quote)) {
    return { ok: false, code: 'bad_request' };
  }
  // Event IDs are deterministic. The function sends the same one; a mismatch is a bug, so refuse it loudly.
  const eventId = 'lead:' + req.submission_id;
  if (!isObject_(req.event) || req.event.event_id !== eventId) return { ok: false, code: 'bad_request' };

  const ss = spreadsheet_();
  const leads = openTable_(ss, LEADS_SHEET, LEADS_HEADERS);
  const events = openTable_(ss, EVENTS_SHEET, EVENTS_HEADERS);
  const outbound = isObject_(req.outbound) ? req.outbound : null;

  const existing = findRecord_(leads, 'submission_id', req.submission_id);
  if (existing) {
    // Same ID, different answers: not a retry. The browser mints a new ID and resubmits.
    if (existing.payload_sha256 !== req.payload_sha256) return { ok: false, code: 'submission_changed' };
    // If an earlier execution saved the lead but failed before its event row, the retry repairs it.
    // The row describes the original conversion, so its context and time come from the lead row.
    if (!findRecord_(events, 'event_id', eventId)) {
      appendRecord_(events, eventRecord_(existing, {
        event_id: eventId, event_name: 'generate_lead', occurred_at: existing.received_at_utc,
        deploy_context: existing.deploy_context, outbound: withEventTime_(outbound, existing.received_at_utc),
      }));
    }
    return {
      ok: true, code: 'duplicate', created: false, lead_id: existing.lead_id,
      occurred_at: existing.received_at_utc, repeat: Boolean(existing.repeat_of),
    };
  }

  const props = PropertiesService.getScriptProperties();
  const receivedAt = receivedAt_(req);
  const today = receivedAt.slice(0, 10);
  const countToday = dailyCount_(props, today);
  if (countToday >= dailyCap_(props)) return { ok: false, code: 'capacity', retryable: true };

  // The function mints a candidate lead_id. It's used only here, for a new lead; a retry gets the original.
  const leadId = isText_(req.lead_id_candidate) ? req.lead_id_candidate : Utilities.getUuid();
  const lead = leadRecord_(req, leadId, receivedAt);
  // A new submission from an email we've seen recently is still saved, so the
  // visitor gets a quote, but it's flagged and its conversion isn't dispatched.
  lead.repeat_of = findRepeatOf_(leads, lead, receivedAt);
  appendRecord_(leads, lead);
  // Counted as soon as the lead row exists, so a failed event append can't leave it uncounted.
  props.setProperty('DAILY_LEAD_COUNT', JSON.stringify({ date: today, count: countToday + 1 }));
  appendRecord_(events, eventRecord_(lead, {
    event_id: eventId, event_name: 'generate_lead', occurred_at: receivedAt,
    deploy_context: lead.deploy_context, outbound: outbound,
  }));
  return { ok: true, code: 'created', created: true, lead_id: leadId, occurred_at: receivedAt, repeat: Boolean(lead.repeat_of) };
}

/**
 * Lead-level dedup, as lead buyers do it: '' unless this email (trimmed,
 * lowercased) already has a lead from the same deploy context, the most
 * recent of which is at most 30 days older than this one. Then the first
 * lead of that chain: a repeat never points at another repeat. "Most recent"
 * goes by received_at_utc, not row position, so sorting the tab can't change
 * the answer, and a preview test sharing the production Sheet can't flag a
 * production lead. Not the same as a duplicate submission, which is one
 * request arriving twice and never gets a second row.
 */
function findRepeatOf_(table, lead, receivedAt) {
  const key = normalizeEmail_(lead.email);
  const lastRow = table.sheet.getLastRow();
  if (!key || lastRow < 2) return '';
  const column = function (h) {
    return table.sheet.getRange(2, table.headers.indexOf(h) + 1, lastRow - 1, 1).getValues();
  };
  const emails = column('email');
  const times = column('received_at_utc');
  const contexts = column('deploy_context');
  let newest = -1;
  let newestAt = -Infinity;
  for (let i = 0; i < emails.length; i++) {
    if (normalizeEmail_(emails[i][0]) !== key || String(contexts[i][0]) !== lead.deploy_context) continue;
    // An unparseable time is NaN, which never compares true, so that row is skipped.
    const at = Date.parse(String(times[i][0]));
    if (at >= newestAt) {
      newest = i;
      newestAt = at;
    }
  }
  if (newest === -1 || !(Date.parse(receivedAt) - newestAt <= REPEAT_WINDOW_MS)) return '';
  const row = table.sheet.getRange(newest + 2, 1, 1, table.headers.length).getValues()[0];
  const cell = function (h) { return String(row[table.headers.indexOf(h)]); };
  return cell('repeat_of') || cell('lead_id');
}

function normalizeEmail_(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

// ... (lines omitted) ...

/** One Events row. Attribution is copied from the lead's own row, never from the request. */
function eventRecord_(lead, event) {
  const record = {
    event_id: event.event_id,
    event_name: event.event_name,
    lead_id: lead.lead_id,
    occurred_at_utc: event.occurred_at,
    value_cents: Number(lead.total_cents),
    currency: CURRENCY,
    deploy_context: event.deploy_context,
    // A repeat lead keeps its payloads for the record, marked as not to be sent.
    dispatch_status: event.outbound ? (lead.repeat_of ? 'suppressed_repeat' : 'dry_run') : 'none',
    outbound_json: event.outbound ? JSON.stringify(event.outbound) : '',
  };
  TRACKING_KEYS.forEach(function (key) {
    record[key] = lead[key] || '';
  });
  return record;
}

// ... (lines omitted) ...

/** The first row whose column equals value exactly (case-sensitive), as { header: string }, or null. */
function findRecord_(table, header, value) {
  const lastRow = table.sheet.getLastRow();
  if (lastRow < 2) return null;
  const column = table.headers.indexOf(header) + 1;
  const cells = table.sheet.getRange(2, column, lastRow - 1, 1).getValues();
  for (let i = 0; i < cells.length; i++) {
    if (String(cells[i][0]) !== value) continue;
    const row = table.sheet.getRange(i + 2, 1, 1, table.headers.length).getValues()[0];
    const record = {};
    table.headers.forEach(function (h, j) {
      if (h) record[h] = String(row[j]);
    });
    return record;
  }
  return null;
}

/**
 * RAW is the only documented write path that stores values exactly as sent.
 * appendRow() and setValues() parse them like typed input.
 */
function appendRecord_(table, record) {
  const row = table.headers.map(function (h) {
    const has = Object.prototype.hasOwnProperty.call(record, h) && record[h] !== null && record[h] !== undefined;
    return has ? record[h] : '';
  });
  Sheets.Spreadsheets.Values.append(
    { values: [row] },
    table.spreadsheetId,
    a1_(table.sheet.getName()),
    { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' }
  );
}
