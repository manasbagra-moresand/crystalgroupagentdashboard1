// Tiny JSON-file-backed store for the opt-out event log the report tab reads from.
// Zoom doesn't expose a ready-made "give me every opt-out period for this agent on this
// day" endpoint, so this app builds that history itself by polling live status
// (see optOutTracker.js) and recording state transitions here as they happen.
//
// Shape written to disk:
// {
//   "2026-09-09": {
//     "Priya Raghunathan": {
//       "ext": "Ext 2041",
//       "login": "08:12",        // first time seen online today
//       "lastSeen": "17:41",     // most recent time seen online today (proxy for logout)
//       "periods": [ { "start": "09:14", "end": "09:26", "reason": "Break" }, ... ],
//       "open": { "start": "13:02", "reason": "Meal" } | null    // in-progress opt-out period
//     }
//   }
// }
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'data', 'events.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

let store = load();
let saveTimer = null;

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(FILE, JSON.stringify(store, null, 2), () => {});
  }, 1000);
}

function dayFor(date) {
  if (!store[date]) store[date] = {};
  return store[date];
}

function agentFor(date, name, ext) {
  const day = dayFor(date);
  if (!day[name]) {
    day[name] = { ext, login: null, lastSeen: null, periods: [], open: null };
  }
  return day[name];
}

function getDay(date) {
  return store[date] || {};
}

function persist() {
  scheduleSave();
}

/**
 * Writes any pending change to disk immediately, synchronously.
 *
 * Saves are debounced by a second so that a 5s poll touching 60 agents doesn't rewrite the
 * file 60 times. That debounce is harmless until the process is asked to stop: a container
 * runtime sends SIGTERM and SIGKILLs a few seconds later, so without this the last second
 * of opt-out transitions — including the start of a break someone is still on — is lost.
 * Synchronous on purpose; an async write isn't guaranteed to finish during shutdown.
 */
function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
    return true;
  } catch (err) {
    console.error('Could not flush the event store to disk:', err.message);
    return false;
  }
}

module.exports = { agentFor, getDay, persist, flush };
