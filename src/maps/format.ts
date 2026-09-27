/**
 * Human-readable distances and durations for the compact Maps views.
 *
 * Both units are always given ("12.3 mi / 19.8 km"): the server cannot know
 * which one the person reading the answer thinks in, and picking one from a
 * locale guess is how "5" ends up meaning the wrong thing. The raw
 * `distanceMeters` / `durationSeconds` always travel alongside, so nothing is
 * lost to the rounding here.
 */

const METERS_PER_MILE = 1609.344;
const FEET_PER_METER = 3.280839895;

function oneDecimal(n: number): string {
  return n >= 100 ? String(Math.round(n)) : (Math.round(n * 10) / 10).toFixed(1);
}

/** `"12.3 mi / 19.8 km"`, or `"121 ft / 37 m"` under a tenth of a mile. */
export function formatDistance(meters: number): string {
  if (meters < METERS_PER_MILE / 10) {
    return `${Math.round(meters * FEET_PER_METER)} ft / ${Math.round(meters)} m`;
  }
  return `${oneDecimal(meters / METERS_PER_MILE)} mi / ${oneDecimal(meters / 1000)} km`;
}

/** `"45 s"`, `"12 min"`, `"1 h 5 min"`, `"3 h"`. Minutes are rounded to the nearest. */
export function formatDuration(seconds: number): string {
  if (Math.round(seconds) < 60) return `${Math.round(seconds)} s`;
  const totalMin = Math.round(seconds / 60);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
