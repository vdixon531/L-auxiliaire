// srs.js
// Leitner box scheduler. Box 1..5 map to increasing review intervals; a
// correct review promotes to the next box (capped at 5), a wrong review
// drops back to box 1. Phase 3 wires RECORD_REVIEW through here; for now
// this only supplies the interval table so a new card gets a real dueAt
// instead of that constant being duplicated wherever one is created.

const DAY_MS = 24 * 60 * 60 * 1000;

const BOX_INTERVALS_MS = [
  1 * DAY_MS, // box 1 -> 1 day
  3 * DAY_MS, // box 2 -> 3 days
  7 * DAY_MS, // box 3 -> 1 week
  14 * DAY_MS, // box 4 -> 2 weeks
  30 * DAY_MS // box 5 -> 1 month
];

export function dueAtForBox(box, from = Date.now()) {
  const clamped = Math.min(Math.max(box, 1), BOX_INTERVALS_MS.length);
  return from + BOX_INTERVALS_MS[clamped - 1];
}
