// The call-queue opt-out reasons Zoom offers agents, worded exactly as they appear in the
// Zoom admin dashboard. Keep this list identical to Zoom's: the report breaks its totals
// down by these, and anything not on the list is bucketed as UNSPECIFIED.
const ZOOM_REASONS = ['Break', 'Meal', 'Training', 'End Shift'];

// Zoom's REST API does not expose which reason an agent actually picked — the reason lives
// in the Zoom admin dashboard but appears on none of the Phone endpoints this app can read
// (call queue members return only `receive_call`; see README). So an opt-out period we
// can't attribute is labelled honestly rather than being assigned a plausible-looking Zoom
// reason it never had, which would turn a gap in the data into a confident wrong number.
const UNSPECIFIED = 'Unspecified';

const REASONS = [...ZOOM_REASONS, UNSPECIFIED];

// Reasons written by earlier versions of this app, before the vocabulary was aligned with
// Zoom's. Mapped so history already on disk (data/events.json keeps past dates) keeps its
// meaning instead of silently collapsing into "Unspecified".
const LEGACY_ALIASES = {
  'Shift over': 'End Shift',
  'Tea break': 'Break',
  'Lunch': 'Meal',
  'Meeting': 'Unspecified',
  'Admin work': 'Unspecified',
  'Away': 'Unspecified',
};

/** Normalises any stored/derived reason onto the current vocabulary. */
function canonicalReason(reason) {
  if (REASONS.includes(reason)) return reason;
  return LEGACY_ALIASES[reason] || UNSPECIFIED;
}

module.exports = { REASONS, ZOOM_REASONS, UNSPECIFIED, canonicalReason };
