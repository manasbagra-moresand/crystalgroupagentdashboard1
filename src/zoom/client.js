// Thin wrapper around the bits of the Zoom Phone / Zoom User Management REST API this
// dashboard needs. Kept isolated here so field names/endpoints can be corrected in one
// place if they differ slightly from what's below once tested against a real account —
// Zoom renames granular scopes and tweaks response shapes fairly often.
//
// Docs: https://developers.zoom.us/docs/api/phone/
const { getAccessToken } = require('./s2sAuth');

// Overridable for local testing against a mock Zoom server; defaults to the real endpoint.
const BASE = process.env.ZOOM_API_BASE || 'https://api.zoom.us/v2';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Zoom rate-limits the Phone API per second and per day. A dashboard polling a few hundred
// agents sits close enough to the per-second ceiling that the occasional 429 is normal rather
// than exceptional, so honour Retry-After and retry a couple of times before giving up.
const MAX_429_RETRIES = 3;

async function zoomGet(path, params = {}) {
  const url = new URL(BASE + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });

  for (let attempt = 0; ; attempt += 1) {
    const token = await getAccessToken();
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.ok) return res.json();

    if (res.status === 429 && attempt < MAX_429_RETRIES) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * (attempt + 1));
      continue;
    }

    const body = await res.text().catch(() => '');
    const err = new Error(`Zoom API ${path} failed (${res.status}): ${body}`);
    err.status = res.status;
    // Zoom reports a missing OAuth scope as a 400 whose body names the scope it wanted, so
    // callers can tell "you didn't grant this" apart from "this request was wrong".
    err.missingScope = /does not contain scopes/i.test(body);
    throw err;
  }
}

// Follows Zoom's next_page_token pagination, concatenating `listKey` across pages.
async function zoomGetAllPages(path, params, listKey) {
  let out = [];
  let nextPageToken = '';
  do {
    const page = await zoomGet(path, { ...params, page_size: 100, next_page_token: nextPageToken });
    out = out.concat(page[listKey] || []);
    nextPageToken = page.next_page_token || '';
  } while (nextPageToken);
  return out;
}

/** All Zoom Phone-licensed users (the agents). */
async function listPhoneUsers() {
  return zoomGetAllPages('/phone/users', { status: 'activate' }, 'users');
}

/** All call queues on the account. */
async function listCallQueues() {
  return zoomGetAllPages('/phone/call_queues', {}, 'call_queues');
}

/**
 * The members of one call queue, with each member's live opt-in/opt-out state.
 *
 * Zoom has no "give me this user's queues" endpoint — `/phone/users/{id}/call_queues` does
 * not exist and 404s — so membership has to be read the other way round, per queue, and
 * inverted into a per-user view (see agentStatus.loadQueueMembership).
 *
 * Each entry looks like:
 *   { id, name, level: 'user'|'commonArea', receive_call: boolean, extension_id }
 *
 * `receive_call` is the opt-in flag: false means the member has opted out of this queue
 * (via the Zoom client's "Call Queue Opt Out" toggle or the *8x code). `id` is the same
 * Zoom user id that /phone/users returns, so it joins straight onto the agent roster.
 */
async function listCallQueueMembers(queueId) {
  return zoomGetAllPages(`/phone/call_queues/${queueId}/members`, {}, 'call_queue_members');
}

/**
 * Zoom IM/user presence for a user: Available | Away | Do_Not_Disturb | Offline |
 * In_A_Zoom_Meeting | On_A_Call | ... plus, when the user set one, a free-text custom
 * status message (e.g. "Lunch"). Used as the "are they actually at their desk" signal that
 * the dashboard cross-references against opted-in queue membership to raise the
 * "opted in but away" alert.
 */
async function getUserPresence(userId) {
  const json = await zoomGet(`/users/${userId}/presence_status`);
  return {
    status: json.presence_status || json.status || 'Offline',
    statusMessage: json.status_message || null,
  };
}

/**
 * Today's call logs for a user (used to derive "attended" vs "abandoned/missed" counts).
 * `from`/`to` are YYYY-MM-DD.
 */
async function getUserCallLogs(userId, from, to) {
  return zoomGetAllPages(`/phone/users/${userId}/call_logs`, { from, to, type: 'all' }, 'call_logs');
}

/** Account-wide call logs for a date range — used by the opt-out/report tab's call stats. */
async function getAccountCallLogs(from, to) {
  return zoomGetAllPages('/phone/call_logs', { from, to, type: 'all' }, 'call_logs');
}

module.exports = {
  listPhoneUsers,
  listCallQueues,
  listCallQueueMembers,
  getUserPresence,
  getUserCallLogs,
  getAccountCallLogs,
};
