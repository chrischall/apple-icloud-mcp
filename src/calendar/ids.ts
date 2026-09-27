import { InvalidArgumentError } from '../errors.js';

/**
 * Identifiers the calendar tools print and accept.
 *
 *  - A calendar id is the collection's last path segment (`home`, or an
 *    opaque `2b0158b9-…`) — never the full DAV URL, whose first segment is the
 *    account's numeric DSID.
 *  - An event id is `<calendarId>/<resource file name>` (`home/ABC.ics`): it
 *    locates the iCalendar resource without a UID search (iCloud answers a
 *    UID-filtered calendar-query with 412).
 *  - An OCCURRENCE of a recurring series appends `#occ=<RECURRENCE-ID>`: the
 *    occurrence's ORIGINAL start in UTC (`2026-10-20T13:00:00Z`) or, for an
 *    all-day series, its date (`2026-10-20`). The original start is stable when
 *    that one occurrence is moved, so the id keeps naming it.
 *
 * A bare series id never silently stands for "the first occurrence": acting on
 * a series through it would hit the whole series, which is refused unless the
 * caller asks for `allEvents`.
 *
 * Both parts are escaped (`%` → `%25`, `/` → `%2F`, `#` → `%23`) so a name
 * containing either separator still round-trips, and so a literal `#` in an id
 * can only ever be the occurrence marker.
 */

export function encodeIdPart(part: string): string {
  return part.replace(/%/g, '%25').replace(/\//g, '%2F').replace(/#/g, '%23');
}

export function decodeIdPart(part: string): string {
  return part.replace(/%(25|2F|23)/gi, (_m, code: string) => (code === '25' ? '%' : code.toUpperCase() === '2F' ? '/' : '#'));
}

/**
 * `<calendarId>/<resourceName>`. `calendarId` is the calendar's id AS PRINTED
 * (`CalendarInfo.id`, already escaped); only the resource name is escaped
 * here. Escaping the printed id a second time would turn `a%25b` into
 * `a%2525b`, and `parseEventId` (which unescapes once) would then name a
 * calendar that does not exist.
 */
export function formatEventId(calendarId: string, resourceName: string): string {
  return `${calendarId}/${encodeIdPart(resourceName)}`;
}

/** Append the occurrence marker to a series id. */
export function formatOccurrenceId(baseId: string, occ: string): string {
  return `${baseId}#occ=${occ}`;
}

export interface ParsedEventId {
  /** The series (resource) id, without any `#occ=`. */
  baseId: string;
  calendarId: string;
  resourceName: string;
  /** The occurrence value (`YYYY-MM-DDTHH:MM:SSZ` or `YYYY-MM-DD`) when the id names one occurrence. */
  occ?: string;
}

const OCC_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})Z)?$/;

/** Whether `value` is a real calendar date, optionally with a real UTC time. */
export function isValidOcc(value: string): boolean {
  const m = OCC_RE.exec(value);
  if (!m) return false;
  const [y, mo, d, h, mi, s] = m.slice(1).map((x) => Number(x ?? '0')) as [number, number, number, number, number, number];
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  t.setUTCHours(h, mi, s, 0);
  return (
    t.getUTCFullYear() === y &&
    t.getUTCMonth() === mo - 1 &&
    t.getUTCDate() === d &&
    t.getUTCHours() === h &&
    t.getUTCMinutes() === mi &&
    t.getUTCSeconds() === s
  );
}

const ID_HINT = 'Pass an eventId exactly as apple_calendar_list_events or apple_calendar_search_events printed it.';

/**
 * Parse an event id. The occurrence marker is looked for from the END and is
 * honoured only when a valid value follows it; since every `#` inside an id we
 * print is escaped, a marker with an invalid value is refused rather than
 * treated as part of a file name.
 */
export function parseEventId(id: string): ParsedEventId {
  let base = id;
  let occ: string | undefined;
  const at = id.lastIndexOf('#occ=');
  if (at >= 0) {
    const value = id.slice(at + 5);
    if (!isValidOcc(value)) {
      throw new InvalidArgumentError(
        `eventId "${id}" ends in "#occ=${value}", which is not an occurrence date (expected YYYY-MM-DDTHH:MM:SSZ or YYYY-MM-DD).`,
        ID_HINT,
      );
    }
    occ = value;
    base = id.slice(0, at);
  }
  const parts = base.split('/');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '' || base.includes('#')) {
    throw new InvalidArgumentError(`"${id}" is not an event id (expected <calendarId>/<file>.ics, optionally with #occ=…).`, ID_HINT);
  }
  const calendarId = decodeIdPart(parts[0] as string);
  const resourceName = decodeIdPart(parts[1] as string);
  return { baseId: base, calendarId, resourceName, ...(occ !== undefined ? { occ } : {}) };
}
