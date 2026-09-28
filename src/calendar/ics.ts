import ICAL from 'ical.js';
import { tzlib_get_ical_block, tzlib_get_timezones } from 'timezones-ical-library';
import { canonicalTimeZone } from '../config.js';
import { InvalidArgumentError, UpstreamError } from '../errors.js';
import { addDaysYmd, formatInstant, startOfDay, zonedParts, zonedToInstant } from '../time.js';

/**
 * iCalendar handling on top of ical.js: parsing a resource, resolving its
 * times to instants, and building the values a write puts back.
 *
 * Three rules this file exists to enforce:
 *
 *  1. **Every TZID resolves to a real zone.** RFC 5545 requires a VTIMEZONE
 *     for every TZID, but some writers omit it; ical.js then treats the time as
 *     FLOATING, and its `toUnixTime()` reads a floating time as UTC — a 9 AM
 *     New York meeting would become 5 AM. Before any value is read, every TZID
 *     without a definition that `timezones-ical-library` knows gets its
 *     VTIMEZONE injected into the parsed tree.
 *  2. **Floating times are wall clock in the display zone**, never UTC, and
 *     `instantOf` is the one place that decides it.
 *  3. **Edits are made on the parsed component and serialized**, so every
 *     property this server does not understand (Apple's X-APPLE-* props,
 *     SCHEDULE-STATUS, …) round-trips untouched.
 */

export type Component = InstanceType<typeof ICAL.Component>;
export type Time = InstanceType<typeof ICAL.Time>;
export type Timezone = InstanceType<typeof ICAL.Timezone>;
export type Property = InstanceType<typeof ICAL.Property>;
export type Recur = InstanceType<typeof ICAL.Recur>;
export type Duration = InstanceType<typeof ICAL.Duration>;

export const PRODID = '-//chrischall//apple-icloud-mcp//EN';

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse an iCalendar resource. Throws `UpstreamError` when the text is not a
 * VCALENDAR — an unreadable event is reported, never skipped silently.
 */
export function parseCalendar(ics: string, what: string): Component {
  let root: Component;
  try {
    root = ICAL.Component.fromString(ics);
  } catch (err) {
    throw new UpstreamError('calendar', 200, `calendar: ${what} is not valid iCalendar (${(err as Error).message}).`);
  }
  if (root.name !== 'vcalendar') {
    throw new UpstreamError('calendar', 200, `calendar: ${what} holds a ${root.name.toUpperCase()}, not a VCALENDAR.`);
  }
  // Before any value is read (a zone is resolved, and cached, on first use).
  for (const tz of root.getAllSubcomponents('vtimezone')) {
    if (boundedTimezone(tz)) continue;
    console.error(
      `[apple-icloud-mcp] WARNING: calendar: ${what} defines time zone "${String(tz.getFirstPropertyValue('tzid'))}" with a rule that cannot ` +
        'be evaluated safely; the standard definition of that zone is used instead (or none, if it is not a known zone).',
    );
    root.removeSubcomponent(tz);
  }
  injectMissingTimezones(root);
  return root;
}

const TIME_EXPANDING_PARTS = ['BYHOUR', 'BYMINUTE', 'BYSECOND'];

/**
 * Whether ical.js can evaluate a VTIMEZONE in bounded time. It expands every
 * observance rule, from the observance's DTSTART up to the year it needs plus
 * five, with no other limit: a sub-yearly rule whose filters never match
 * (`FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30`) never returns — one event carrying
 * one would hang the whole server — and `FREQ=MINUTELY`, or BYHOUR/BYMINUTE/
 * BYSECOND on a yearly rule, yields millions of transitions. Real zone
 * definitions are yearly rules (`FREQ=YEARLY;BYMONTH=3;BYDAY=2SU`), whose
 * iteration ical.js does bound.
 */
export function boundedTimezone(tz: Component): boolean {
  return tz.getAllSubcomponents().every((observance) =>
    observance.getAllProperties('rrule').every((prop) => {
      const rule = prop.getFirstValue() as Recur;
      return String(rule.freq) === 'YEARLY' && TIME_EXPANDING_PARTS.every((part) => rule.getComponent(part).length === 0);
    }),
  );
}

/** The VEVENTs of a resource: the master (no RECURRENCE-ID) and the per-occurrence overrides. */
export interface EventParts {
  master?: Component;
  overrides: Component[];
}

export function eventParts(vcal: Component): EventParts {
  let master: Component | undefined;
  const overrides: Component[] = [];
  for (const ev of vcal.getAllSubcomponents('vevent')) {
    if (!ev.hasProperty('dtstart')) continue;
    if (ev.hasProperty('recurrence-id')) overrides.push(ev);
    else master ??= ev;
  }
  return { ...(master ? { master } : {}), overrides };
}

/** Whether a master VEVENT defines a recurrence set. */
export function isRecurringMaster(master: Component): boolean {
  return master.hasProperty('rrule') || master.hasProperty('rdate');
}

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

let knownZones: Set<string> | undefined;

/** IANA names `timezones-ical-library` can supply a VTIMEZONE for. */
function zoneNames(): Set<string> {
  knownZones ??= new Set(tzlib_get_timezones() as string[]);
  return knownZones;
}

/**
 * The name the library knows `zone` by: the name itself, else the runtime's
 * canonical spelling of it. The library's lookup is case-sensitive while
 * `Intl` is not, so `america/new_york` — a zone every other layer accepts —
 * would otherwise miss, and a write would silently fall back to UTC (a
 * repeating event then drifts an hour at every DST change).
 */
function libraryZone(zone: string): string | undefined {
  if (zoneNames().has(zone)) return zone;
  const canonical = canonicalTimeZone(zone);
  return canonical !== undefined && zoneNames().has(canonical) ? canonical : undefined;
}

/**
 * A VTIMEZONE component for an IANA zone, with its TZID set to `tzid` (the
 * library resolves aliases — `US/Eastern` comes back as `America/New_York` —
 * and a reference must find a definition under the name it used). Undefined
 * when the zone is unknown.
 */
export function vtimezoneFor(zone: string, tzid: string = zone): Component | undefined {
  const known = libraryZone(zone);
  if (known === undefined) return undefined;
  const [block] = tzlib_get_ical_block(known) as string[];
  const comp = ICAL.Component.fromString(block as string);
  comp.updatePropertyWithValue('tzid', tzid);
  return comp;
}

/** The TZID the library uses for `zone` (its canonical name), or undefined when unknown. */
function canonicalTzid(zone: string): string | undefined {
  const known = libraryZone(zone);
  if (known === undefined) return undefined;
  const [, line] = tzlib_get_ical_block(known) as string[];
  return (line as string).replace(/^TZID=/, '');
}

type JCal = [string, Array<[string, Record<string, unknown>, ...unknown[]]>, JCal[]];

function collectTzids(jcal: JCal, out: Set<string>): void {
  if (jcal[0] === 'vtimezone') return;
  for (const prop of jcal[1]) {
    const tzid = prop[1].tzid;
    if (typeof tzid === 'string') out.add(tzid);
  }
  for (const child of jcal[2]) collectTzids(child, out);
}

/** Add a VTIMEZONE for every referenced TZID the resource does not define (see rule 1 above). */
export function injectMissingTimezones(vcal: Component): void {
  const defined = new Set(vcal.getAllSubcomponents('vtimezone').map((z) => String(z.getFirstPropertyValue('tzid'))));
  const referenced = new Set<string>();
  collectTzids(vcal.jCal as JCal, referenced);
  for (const tzid of referenced) {
    if (defined.has(tzid)) continue;
    const comp = vtimezoneFor(tzid);
    if (comp) vcal.addSubcomponent(comp);
  }
}

const UTC_NAMES = /^(?:Etc\/)?(?:UTC|UCT|GMT0?|Zulu|Universal|Greenwich)$/i;

/** How new times are written: UTC (`…Z`), with a TZID + VTIMEZONE, or floating. */
export type WriteZone = { kind: 'utc' } | { kind: 'tz'; tz: Timezone } | { kind: 'floating'; zone: string };

/**
 * The write zone for an IANA zone name: UTC for a UTC alias, otherwise a
 * TZID backed by a VTIMEZONE added to `vcal` when it lacks one. A zone the
 * VTIMEZONE library does not know is written as UTC — the instant is still
 * exact; only a recurring series would then follow UTC across DST.
 */
export function zoneForWrite(vcal: Component, zone: string): WriteZone {
  if (UTC_NAMES.test(zone)) return { kind: 'utc' };
  const tzid = canonicalTzid(zone);
  if (tzid === undefined) return { kind: 'utc' };
  let tz = vcal.getTimeZoneByID(tzid) as Timezone | null;
  if (!tz) {
    vcal.addSubcomponent(vtimezoneFor(zone, tzid) as Component);
    tz = vcal.getTimeZoneByID(tzid) as Timezone;
  }
  return { kind: 'tz', tz };
}

/** The write zone an existing date-time value is in (a DATE value has none). */
export function zoneOfTime(t: Time, displayZone: string): WriteZone {
  if (t.zone === ICAL.Timezone.utcTimezone) return { kind: 'utc' };
  if (t.zone === ICAL.Timezone.localTimezone) return { kind: 'floating', zone: displayZone };
  return { kind: 'tz', tz: t.zone as Timezone };
}

/** The IANA-style name of a value's zone when it has a named one (not UTC, not floating). */
export function tzidOf(t: Time): string | undefined {
  if (t.isDate || t.zone === ICAL.Timezone.utcTimezone || t.zone === ICAL.Timezone.localTimezone) return undefined;
  return (t.zone as Timezone).tzid;
}

// ---------------------------------------------------------------------------
// Values → instants
// ---------------------------------------------------------------------------

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** `YYYY-MM-DD` of a value's own (wall-clock) date. */
export function ymdOf(t: Time): string {
  return `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}`;
}

/**
 * The instant a value denotes. A DATE is the start of that day in `zone`; a
 * FLOATING date-time is wall-clock time in `zone`; anything else carries its
 * own zone (UTC or a VTIMEZONE).
 */
export function instantOf(t: Time, zone: string): Date {
  if (t.isDate) return startOfDay(ymdOf(t), zone);
  if (t.zone === ICAL.Timezone.localTimezone) {
    return zonedToInstant({ year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second }, zone);
  }
  return new Date(t.toUnixTime() * 1000);
}

/** `YYYY-MM-DDTHH:MM:SSZ` (whole seconds). */
export function utcStamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * The occurrence key of a value: its date for a DATE, else its instant in UTC.
 * It is what `#occ=` carries, and how overrides are matched to the instances
 * they replace (by instant, whatever zone each side was written in).
 */
export function occKey(t: Time, zone: string): string {
  return t.isDate ? ymdOf(t) : utcStamp(instantOf(t, zone));
}

// ---------------------------------------------------------------------------
// Instants → values
// ---------------------------------------------------------------------------

/** A date-time value for `instant` in the write zone. */
export function timeAt(instant: Date, wz: WriteZone): Time {
  const utc = ICAL.Time.fromJSDate(new Date(Math.floor(instant.getTime() / 1000) * 1000), true);
  if (wz.kind === 'utc') return utc;
  if (wz.kind === 'tz') return zoneTime(utc, wz.tz);
  const p = zonedParts(instant, wz.zone);
  return ICAL.Time.fromData({ year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second, isDate: false });
}

/** One of a zone's changes as ical.js keeps them: the UTC instant it happens, and the offsets (seconds) either side. */
interface ZoneChange {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  utcOffset: number;
  prevUtcOffset: number;
}

/**
 * The UTC offset (seconds) in force in `tz` at an instant, from the zone's
 * own list of changes — ical.js expands a VTIMEZONE's observances into UTC
 * instants. Not `tz.utcOffset`, which is keyed by a LOCAL time, so it cannot
 * say which pass of a repeated hour an instant is (or what a skipped time is).
 */
function offsetAt(tz: Timezone, unixSeconds: number): number {
  const year = new Date(unixSeconds * 1000).getUTCFullYear();
  tz._ensureCoverage(year + 1);
  const changes = tz.changes as ZoneChange[];
  if (changes.length === 0) return 0; // as ical.js: a zone without observances
  const instant = (c: ZoneChange) => Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second) / 1000;
  // The last change at or before the instant (they are sorted).
  let lo = 0;
  let hi = changes.length - 1;
  // Before the zone's first change ical.js reads every wall time at offset 0 (not the first TZOFFSETFROM): what it
  // reads is what a written value means here, so a value from before a VTIMEZONE's first observance reads back.
  if (instant(changes[0] as ZoneChange) > unixSeconds) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (instant(changes[mid] as ZoneChange) <= unixSeconds) lo = mid;
    else hi = mid - 1;
  }
  return (changes[lo] as ZoneChange).utcOffset;
}

/**
 * `utc` as a wall-clock time in `tz`: its fields plus the offset in force at
 * that instant. Not ical.js's `convertToZone`, which reads the offset at the
 * UTC wall clock as though it were local time — an hour off for the hours
 * next to a DST change (half a day of them in a zone far from UTC).
 */
function zoneTime(utc: Time, tz: Timezone): Time {
  const t = ICAL.Time.fromData({ year: utc.year, month: utc.month, day: utc.day, hour: utc.hour, minute: utc.minute, second: utc.second, isDate: false }, tz);
  t.adjust(0, 0, 0, offsetAt(tz, utc.toUnixTime()));
  return t;
}

/** Whether two date-time values have the same wall-clock fields. */
function sameWall(a: Time, b: Time): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute && a.second === b.second;
}

/**
 * Whether a TZID value names a wall time its zone skips (02:30 on a
 * spring-forward day). ical.js reads one with the offset AFTER the change —
 * an hour early, at a time whose true wall clock is another — and RFC 5545
 * (§3.3.5) with the offset before it, so readers disagree on its instant and
 * on how long it lasts until an end written as a wall time.
 */
export function skippedWall(t: Time): boolean {
  if (t.isDate || t.zone === ICAL.Timezone.utcTimezone || t.zone === ICAL.Timezone.localTimezone) return false;
  return !sameWall(timeAt(new Date(t.toUnixTime() * 1000), { kind: 'tz', tz: t.zone as Timezone }), t);
}

/**
 * The instant RFC 5545 gives a value: `instantOf`, except for a wall time a
 * DST change skips, which it reads with the offset before the change — where
 * that wall time would have been — not ical.js's (see `skippedWall`).
 */
export function rfcInstantOf(t: Time, zone: string): Date {
  if (!skippedWall(t)) return instantOf(t, zone);
  return new Date(Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second) - offsetAt(t.zone as Timezone, t.toUnixTime()) * 1000);
}

/**
 * Refusal for a series whose new start is a wall-clock time the zone skips:
 * the series would repeat at the time the clocks jumped to, not the one asked for.
 */
export function skippedStartError(zone: string): InvalidArgumentError {
  return new InvalidArgumentError(
    `startDate is a time of day that does not exist that day in ${zone} (the clocks skip it for daylight saving), and a repeating ` +
      'event keeps its start\'s wall-clock time on every day, so it would repeat at the wrong time. Nothing was changed.',
    'Start the series on another day, or at another time of day.',
  );
}

/**
 * Why a series' occurrence is an hour from the instant asked for: its wall
 * clock comes twice as the clocks go back, and a series keeps its wall time,
 * which is read as the other pass (see `setEventTimes`).
 */
export function otherPassNote(what: string, read: Date, asked: Date, zone: string): string {
  return (
    `${what} at ${formatInstant(read, zone).display}, not ${formatInstant(asked, zone).display}: that wall-clock time comes twice as ` +
    "the clocks go back, and a repeating event keeps its wall-clock time, which is read as the other one."
  );
}

/** The instant a value is read as, with floating values in the write zone's own zone. */
function readAs(t: Time, wz: WriteZone): number {
  return instantOf(t, wz.kind === 'floating' ? wz.zone : 'UTC').getTime();
}

/** A value's own wall-clock fields, as milliseconds of a zone-free (UTC) carrier. */
export function ownWallMs(t: Time): number {
  return Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
}

/**
 * How long a timed event lasts (RFC 5545 §3.8.5.3): a DURATION as written —
 * nominal, so each instance of a series ends by its own start's calendar (see
 * `endAfter`) — or an exact span that every instance shares: DTEND less
 * DTSTART, for a floating pair by its wall times (floating is wall clock: the
 * author's 02:30–03:30 is an hour, even on a day a DST change makes it none).
 */
export type Length = { duration: Duration } | { ms: number };

function durationOf(comp: Component): Duration | null {
  return comp.hasProperty('dtend') ? null : (comp.getFirstPropertyValue('duration') as Duration | null);
}

/** A timed event's length, from its own values (see `Length`). */
export function lengthOf(comp: Component, zone: string): Length {
  const start = startTimeOf(comp);
  const duration = durationOf(comp);
  if (duration) return { duration };
  const end = endTimeOf(comp, start);
  const floating = (t: Time) => t.zone === ICAL.Timezone.localTimezone;
  if (floating(start) && floating(end)) return { ms: ownWallMs(end) - ownWallMs(start) };
  return { ms: instantOf(end, zone).getTime() - instantOf(start, zone).getTime() };
}

/** Whether two lengths are the same length, written the same way. */
export function sameLength(a: Length, b: Length): boolean {
  if ('ms' in a) return 'ms' in b && a.ms === b.ms;
  return !('ms' in b) && a.duration.toString() === b.duration.toString();
}

/** A length in milliseconds, roughly: a DURATION's days as 24 hours (for margins, not for ends). */
export function roughMs(length: Length): number {
  return 'ms' in length ? length.ms : length.duration.toSeconds() * 1000;
}

/**
 * The instant an event starting at `start` ends when it lasts `length`. A
 * DURATION's weeks and days are nominal (the same wall time that many days
 * on) and its hours, minutes and seconds exact (RFC 5545 §3.3.6) — not
 * ical.js's reading, which adds them all to the wall clock, an hour off
 * across a DST change.
 */
export function endAfter(start: Time, length: Length, zone: string): Date {
  if ('ms' in length) return new Date(instantOf(start, zone).getTime() + length.ms);
  const d = length.duration;
  const sign = d.isNegative ? -1 : 1;
  const day = start.clone();
  day.adjust(sign * (d.weeks * 7 + d.days), 0, 0, 0);
  return new Date(instantOf(day, zone).getTime() + sign * (d.hours * 3600 + d.minutes * 60 + d.seconds) * 1000);
}

/** The instant a timed event ends (see `endAfter` for a DURATION). */
export function endInstantOf(comp: Component, zone: string): Date {
  const start = startTimeOf(comp);
  const duration = durationOf(comp);
  return duration ? endAfter(start, { duration }, zone) : instantOf(endTimeOf(comp, start), zone);
}

/** A DURATION of exactly `ms`, in hours, minutes and seconds — never days, which are nominal (see `endAfter`). */
function exactDuration(ms: number): Duration {
  const total = Math.round(Math.abs(ms) / 1000);
  return ICAL.Duration.fromData({ hours: Math.floor(total / 3600), minutes: Math.floor((total % 3600) / 60), seconds: total % 60, isNegative: ms < 0 });
}

/** Set a timed event's length after `start`: a DURATION as it is written, an exact span by `setEnd`. */
export function setLength(comp: Component, start: Time, length: Length, wz: WriteZone): void {
  if ('ms' in length) return setEnd(comp, start, length.ms, wz);
  comp.removeAllProperties('dtend');
  comp.removeAllProperties('duration');
  comp.addPropertyWithValue('duration', length.duration.clone());
}

/**
 * Set a timed event's end, exactly `ms` after `start` (a value already
 * written, in write zone `wz`), so that every reader agrees on the length:
 *  - floating (RFC 5545 has DTEND floating exactly when DTSTART is): as DTEND,
 *    the start's wall time plus the length — unless a DST change in the zone
 *    it is read in comes between, where the wall times would last longer or
 *    shorter than that: then as DURATION, which lasts exactly `ms` anywhere;
 *  - after a start whose wall time the zone skips, as DURATION (readers
 *    disagree on that start's instant, so no DTEND could keep the length);
 *  - otherwise as DTEND, measured from the start as read: a wall time in the
 *    zone when one reads back as the end, else in UTC — in an hour a DST
 *    change repeats a zone's wall time is read as one pass, so the other has
 *    none of its own.
 */
export function setEnd(comp: Component, start: Time, ms: number, wz: WriteZone): void {
  comp.removeAllProperties('duration');
  const asDuration = () => {
    comp.removeAllProperties('dtend');
    comp.addPropertyWithValue('duration', exactDuration(ms));
  };
  if (wz.kind === 'floating') {
    const end = wallTime(new Date(ownWallMs(start) + ms), wz);
    if (readAs(end, wz) - readAs(start, wz) === ms) setTimeProp(comp, 'dtend', end);
    else asDuration();
    return;
  }
  if (skippedWall(start)) return asDuration();
  const endAt = new Date(readAs(start, wz) + ms);
  const end = timeAt(endAt, wz);
  setTimeProp(comp, 'dtend', readAs(end, wz) === endAt.getTime() ? end : timeAt(endAt, { kind: 'utc' }));
}

/**
 * Set DTSTART and DTEND (or DURATION, see `setEnd`) for [start, end) in the
 * write zone. A wall time names one instant, except in an hour a DST change
 * repeats: there ical.js (and so this server) reads it as one pass, and the
 * other pass has no wall time of its own. A single event starting at an
 * instant it cannot name is written in UTC. A series keeps its wall time — its
 * repeats follow DTSTART's wall clock — and so may start on the other pass;
 * whether it does is returned (always false for a single event).
 */
export function setEventTimes(comp: Component, start: Date, end: Date, wz: WriteZone, series: boolean): boolean {
  // Whole seconds, as values hold them.
  const whole = (d: Date) => Math.floor(d.getTime() / 1000) * 1000;
  let s = timeAt(start, wz);
  const unnamed = readAs(s, wz) !== whole(start);
  if (!series && unnamed) s = timeAt(start, { kind: 'utc' });
  setTimeProp(comp, 'dtstart', s);
  setEnd(comp, s, whole(end) - whole(start), zoneOfTime(s, wz.kind === 'floating' ? wz.zone : 'UTC'));
  return series && unnamed;
}

/**
 * A date-time value with the given WALL-CLOCK fields in the write zone. The
 * fields are read from `wall` as UTC fields (a zone-free carrier).
 */
export function wallTime(wall: Date, wz: WriteZone): Time {
  const fields = {
    year: wall.getUTCFullYear(),
    month: wall.getUTCMonth() + 1,
    day: wall.getUTCDate(),
    hour: wall.getUTCHours(),
    minute: wall.getUTCMinutes(),
    second: wall.getUTCSeconds(),
    isDate: false,
  };
  if (wz.kind === 'utc') return ICAL.Time.fromData(fields, ICAL.Timezone.utcTimezone);
  return wz.kind === 'tz' ? ICAL.Time.fromData(fields, wz.tz) : ICAL.Time.fromData(fields);
}

/** A DATE value for `YYYY-MM-DD`. */
export function dateValue(ymd: string): Time {
  const [year, month, day] = ymd.split('-').map(Number) as [number, number, number];
  return ICAL.Time.fromData({ year, month, day, isDate: true });
}

/** Set a DTSTART / DTEND / RECURRENCE-ID-style property, keeping TZID in step with the value. */
export function setTimeProp(comp: Component, name: string, value: Time): void {
  comp.removeAllProperties(name);
  const prop = comp.addPropertyWithValue(name, value) as Property;
  if (!value.isDate && value.zone !== ICAL.Timezone.utcTimezone && value.zone !== ICAL.Timezone.localTimezone) {
    prop.setParameter('tzid', (value.zone as Timezone).tzid);
  }
}

/** Add one value of a multi-valued date property (EXDATE, RDATE) as its own line. */
export function addTimeProp(comp: Component, name: string, value: Time): void {
  const prop = comp.addPropertyWithValue(name, value) as Property;
  if (!value.isDate && value.zone !== ICAL.Timezone.utcTimezone && value.zone !== ICAL.Timezone.localTimezone) {
    prop.setParameter('tzid', (value.zone as Timezone).tzid);
  }
}

/** Every value of every `name` property (EXDATE / RDATE lines may carry several). */
export function timeValues(comp: Component, name: string): Time[] {
  const out: Time[] = [];
  for (const prop of comp.getAllProperties(name)) {
    for (const v of prop.getValues()) if (v instanceof ICAL.Time) out.push(v);
  }
  return out;
}

/** The component's end value: DTEND, else DTSTART + DURATION, else one day for a DATE, else DTSTART. */
export function endTimeOf(comp: Component, start: Time): Time {
  const dtend = comp.getFirstPropertyValue('dtend') as Time | null;
  if (dtend) return dtend;
  const end = start.clone();
  const duration = comp.getFirstPropertyValue('duration') as Duration | null;
  if (duration) end.addDuration(duration);
  else if (start.isDate) end.day += 1;
  return end;
}

/** Start value of a VEVENT (every VEVENT this module keeps has one). */
export function startTimeOf(comp: Component): Time {
  return comp.getFirstPropertyValue('dtstart') as Time;
}

/** Whole days from `a` to `b` (`YYYY-MM-DD`, zone-free). */
export function daysBetween(a: string, b: string): number {
  const ms = (ymd: string) => {
    const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

export { addDaysYmd };

// ---------------------------------------------------------------------------
// Text properties
// ---------------------------------------------------------------------------

/** A text property's value; absent or empty → undefined. */
export function textProp(comp: Component, name: string): string | undefined {
  const v = comp.getFirstPropertyValue(name);
  if (v == null) return undefined;
  const s = String(v);
  return s.length > 0 ? s : undefined;
}

/**
 * Set a text property; undefined or `''` removes it. A CRLF, a bare CR and a
 * U+2028 / U+2029 separator are stored as LF: ical.js escapes LF in a TEXT
 * value but writes the others raw, and each is a line break to some parser
 * that splits on it.
 */
export function setTextProp(comp: Component, name: string, value: string | undefined): void {
  if (value === undefined || value === '') comp.removeAllProperties(name);
  else comp.updatePropertyWithValue(name, value.replace(/\r\n?|[\u2028\u2029]/g, '\n'));
}

/** Bump SEQUENCE and restamp DTSTAMP / LAST-MODIFIED — what calendar clients do on every change. */
export function touch(comp: Component, now: Date): void {
  const seq = comp.getFirstPropertyValue('sequence');
  comp.updatePropertyWithValue('sequence', typeof seq === 'number' ? seq + 1 : 1);
  const stamp = ICAL.Time.fromJSDate(now, true);
  comp.updatePropertyWithValue('dtstamp', stamp);
  comp.updatePropertyWithValue('last-modified', stamp.clone());
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export interface Person {
  name?: string;
  email?: string;
}

export interface Attendee extends Person {
  status: string;
  role?: string;
}

/** The e-mail of an ORGANIZER / ATTENDEE: its `mailto:` value, else its EMAIL parameter (iCloud rewrites the owner to a principal path). */
export function emailOf(prop: Property): string | undefined {
  const value = String(prop.getFirstValue());
  if (/^mailto:/i.test(value)) return value.slice(7);
  const param = prop.getFirstParameter('email');
  return typeof param === 'string' && param.length > 0 ? param : undefined;
}

function personOf(prop: Property): Person {
  const name = prop.getFirstParameter('cn');
  const email = emailOf(prop);
  return {
    ...(typeof name === 'string' && name.length > 0 ? { name } : {}),
    ...(email !== undefined ? { email } : {}),
  };
}

const ROLES: Record<string, string> = {
  'REQ-PARTICIPANT': 'required',
  'OPT-PARTICIPANT': 'optional',
  'NON-PARTICIPANT': 'non-participant',
  CHAIR: 'chair',
};

export function readOrganizer(comp: Component): Person | undefined {
  const prop = comp.getFirstProperty('organizer');
  if (!prop) return undefined;
  const p = personOf(prop);
  return p.name === undefined && p.email === undefined ? undefined : p;
}

export function readAttendees(comp: Component): Attendee[] {
  return comp.getAllProperties('attendee').map((prop) => {
    const partstat = prop.getFirstParameter('partstat');
    const role = prop.getFirstParameter('role');
    const roleName = typeof role === 'string' ? (ROLES[role.toUpperCase()] ?? role.toLowerCase()) : undefined;
    return {
      ...personOf(prop),
      status: typeof partstat === 'string' ? partstat.toLowerCase() : 'needs-action',
      ...(roleName !== undefined ? { role: roleName } : {}),
    };
  });
}

/** Normalised calendar-user address: `mailto:` lower-cased, anything else reduced to its path. */
export function normalizeAddress(value: string): string {
  if (/^mailto:/i.test(value)) return `mailto:${value.slice(7).toLowerCase()}`;
  const m = /^https?:\/\/[^/]+(\/.*)$/i.exec(value);
  return m ? (m[1] as string) : value;
}

/** Whether an ATTENDEE / ORGANIZER property names the account owner (`self` = normalised addresses). */
export function isSelf(prop: Property, self: ReadonlySet<string>): boolean {
  if (self.has(normalizeAddress(String(prop.getFirstValue())))) return true;
  const email = emailOf(prop);
  return email !== undefined && self.has(`mailto:${email.toLowerCase()}`);
}

/**
 * Replace the invitees. An attendee already on the event keeps its property
 * (and so its PARTSTAT) when listed again; new ones are added as required
 * participants awaiting a reply. The owner's own entry is kept while anyone
 * else is invited, and dropped with the rest when the list is emptied.
 */
export function setAttendees(comp: Component, list: ReadonlyArray<{ email: string; name?: string }>, self: ReadonlySet<string>): void {
  const existing = comp.getAllProperties('attendee');
  const byEmail = new Map<string, Property>();
  const keepSelf: Property[] = [];
  for (const prop of existing) {
    if (isSelf(prop, self)) keepSelf.push(prop);
    else {
      const email = emailOf(prop);
      if (email !== undefined) byEmail.set(email.toLowerCase(), prop);
    }
  }
  comp.removeAllProperties('attendee');
  if (list.length === 0) return;
  for (const prop of keepSelf) comp.addProperty(prop);
  for (const a of list) {
    const prior = byEmail.get(a.email.toLowerCase());
    if (prior) {
      if (a.name !== undefined) prior.setParameter('cn', a.name);
      comp.addProperty(prior);
      continue;
    }
    const prop = new ICAL.Property('attendee', comp);
    prop.setValue(`mailto:${a.email}`);
    if (a.name !== undefined) prop.setParameter('cn', a.name);
    prop.setParameter('cutype', 'INDIVIDUAL');
    prop.setParameter('role', 'REQ-PARTICIPANT');
    prop.setParameter('partstat', 'NEEDS-ACTION');
    prop.setParameter('rsvp', 'TRUE');
    comp.addProperty(prop);
  }
}

/** Set ORGANIZER to the account's address (only when the event has none). */
export function ensureOrganizer(comp: Component, address: string): void {
  if (comp.hasProperty('organizer')) return;
  comp.addPropertyWithValue('organizer', `mailto:${address}`);
}

// ---------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------

/**
 * Alarm offsets in minutes before the start (negative = after it). A trigger
 * relative to the END is converted with the occurrence's length; an absolute
 * trigger is measured against this occurrence's start. Apple's `ACTION:NONE`
 * placeholder alarms are skipped.
 */
export function readAlarms(comp: Component, start: Date, end: Date, zone: string): number[] {
  const out: number[] = [];
  for (const alarm of comp.getAllSubcomponents('valarm')) {
    if (String(alarm.getFirstPropertyValue('action') ?? '').toUpperCase() === 'NONE') continue;
    const trigger = alarm.getFirstProperty('trigger');
    if (!trigger) continue;
    const value = trigger.getFirstValue();
    let offsetMs: number;
    if (value instanceof ICAL.Time) {
      offsetMs = instantOf(value, zone).getTime() - start.getTime();
    } else {
      const related = String(trigger.getFirstParameter('related') ?? '').toUpperCase();
      offsetMs = (value as Duration).toSeconds() * 1000 + (related === 'END' ? end.getTime() - start.getTime() : 0);
    }
    out.push(Math.round(-offsetMs / 60_000) + 0);
  }
  return out;
}

/** Replace every VALARM with display alarms `minutesBefore` the start. */
export function setAlarms(comp: Component, minutes: readonly number[]): void {
  comp.removeAllSubcomponents('valarm');
  for (const m of minutes) {
    const alarm = new ICAL.Component('valarm');
    alarm.addPropertyWithValue('action', 'DISPLAY');
    alarm.addPropertyWithValue('description', 'Reminder');
    alarm.addPropertyWithValue('trigger', ICAL.Duration.fromSeconds(-m * 60));
    comp.addSubcomponent(alarm);
  }
}

// ---------------------------------------------------------------------------
// Recurrence rules
// ---------------------------------------------------------------------------

export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const DAY_NAMES: Record<string, string> = {
  MO: 'Monday',
  TU: 'Tuesday',
  WE: 'Wednesday',
  TH: 'Thursday',
  FR: 'Friday',
  SA: 'Saturday',
  SU: 'Sunday',
};
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const UNITS: Record<string, string> = {
  SECONDLY: 'second',
  MINUTELY: 'minute',
  HOURLY: 'hour',
  DAILY: 'day',
  WEEKLY: 'week',
  MONTHLY: 'month',
  YEARLY: 'year',
};

function ordinal(n: number): string {
  if (n === -1) return 'last';
  if (n < 0) return `${ordinal(-n)}-to-last`;
  const words = ['first', 'second', 'third', 'fourth', 'fifth'];
  if (n <= 5) return words[n - 1] as string;
  const suffix = n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function dayPhrase(byday: string): string {
  const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(byday.toUpperCase());
  if (!m) return byday;
  const name = DAY_NAMES[m[2] as string] ?? (m[2] as string);
  return m[1] ? `the ${ordinal(Number(m[1]))} ${name}` : name;
}

/**
 * A plain-English reading of an RRULE ("Every 2 weeks on Monday and
 * Wednesday, until Fri, Dec 31, 2027"). Rule parts it does not phrase are
 * named rather than dropped, and the raw rule is always returned beside it.
 */
export function describeRule(recur: Recur, untilLabel?: string): string {
  const unit = UNITS[String(recur.freq)] ?? String(recur.freq).toLowerCase();
  const interval = recur.interval > 1 ? recur.interval : 1;
  let text = interval === 1 ? `Every ${unit}` : `Every ${interval} ${unit}s`;
  const byday = recur.getComponent('BYDAY').map(String);
  const bymonthday = recur.getComponent('BYMONTHDAY').map(Number);
  const bymonth = recur.getComponent('BYMONTH').map(Number);
  const weekdaysOnly = ['MO', 'TU', 'WE', 'TH', 'FR'];
  if (byday.length === 5 && weekdaysOnly.every((d) => byday.includes(d)) && (recur.freq === 'DAILY' || recur.freq === 'WEEKLY')) {
    text = interval === 1 ? 'Every weekday' : `${text} on weekdays`;
  } else if (byday.length > 0) {
    text += ` on ${list(byday.map(dayPhrase))}`;
  }
  if (bymonthday.length > 0) {
    text += ` on ${list(bymonthday.map((d) => (d === -1 ? 'the last day' : d < 0 ? `the ${ordinal(-d)}-to-last day` : `day ${d}`)))}`;
  }
  if (bymonth.length > 0) text += ` in ${list(bymonth.map((m) => MONTH_NAMES[m - 1] ?? String(m)))}`;
  const other = Object.keys(recur.parts).filter((k) => !['BYDAY', 'BYMONTHDAY', 'BYMONTH'].includes(k));
  if (other.length > 0) text += ` (also ${other.join(', ')})`;
  if (recur.count) text += `, ${recur.count} time${recur.count === 1 ? '' : 's'}`;
  else if (untilLabel !== undefined) text += `, until ${untilLabel}`;
  return text;
}

/** The first RRULE of a master, if any. */
export function ruleOf(master: Component): Recur | undefined {
  return (master.getFirstPropertyValue('rrule') as Recur | null) ?? undefined;
}

export interface RecurrenceInput {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval?: number;
  count?: number;
  byWeekday?: readonly string[];
}

/** Build an RRULE from tool input; `until` is already a value of the right type. */
export function buildRule(input: RecurrenceInput, until: Time | undefined): Recur {
  const data: Record<string, unknown> = { freq: input.frequency.toUpperCase() };
  if (input.interval !== undefined && input.interval > 1) data.interval = input.interval;
  if (input.count !== undefined) data.count = input.count;
  if (until !== undefined) data.until = until;
  const days = input.byWeekday;
  if (days !== undefined && days.length > 0) data.byday = WEEKDAYS.filter((d) => days.includes(d));
  return ICAL.Recur.fromData(data as Parameters<typeof ICAL.Recur.fromData>[0]);
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/** An empty VCALENDAR carrying this server's PRODID. */
export function newCalendar(): Component {
  const vcal = new ICAL.Component(['vcalendar', [], []]);
  vcal.updatePropertyWithValue('version', '2.0');
  vcal.updatePropertyWithValue('prodid', PRODID);
  vcal.updatePropertyWithValue('calscale', 'GREGORIAN');
  return vcal;
}

/** A new VEVENT with its identity and stamps set. */
export function newEvent(uid: string, now: Date): Component {
  const ev = new ICAL.Component('vevent');
  ev.updatePropertyWithValue('uid', uid);
  const stamp = ICAL.Time.fromJSDate(now, true);
  ev.updatePropertyWithValue('dtstamp', stamp);
  ev.updatePropertyWithValue('created', stamp.clone());
  ev.updatePropertyWithValue('last-modified', stamp.clone());
  ev.updatePropertyWithValue('sequence', 0);
  return ev;
}

/** A deep copy of a component (for a new override or series built from a master). */
export function cloneComponent(comp: Component): Component {
  return new ICAL.Component(JSON.parse(JSON.stringify(comp.toJSON())));
}

/**
 * Serialize a VCALENDAR (CRLF line endings, lines folded at 75 octets), with
 * every VTIMEZONE ahead of the events — where clients expect them, and where
 * a zone added during an edit would otherwise end up last.
 */
export function serialize(vcal: Component): string {
  const [name, props, comps] = vcal.toJSON() as JCal;
  const zones = comps.filter((c) => c[0] === 'vtimezone');
  return ICAL.stringify([name, props, [...zones, ...comps.filter((c) => c[0] !== 'vtimezone')]]);
}

/** Properties whose VALUE decides who iCloud emails (and which event it is), compared by value, not just by name. */
const IDENTITY_PROPS = new Set(['organizer', 'attendee', 'uid']);

/**
 * A comparable outline of a component tree: every component, and in each the
 * names of its properties — with the value, for ORGANIZER / ATTENDEE / UID.
 * Order-insensitive (serialize moves VTIMEZONEs first).
 */
function outline(comp: Component): string {
  const props = comp
    .getAllProperties()
    .map((p) => (IDENTITY_PROPS.has(p.name) ? `${p.name}=${String(p.getFirstValue())}` : p.name))
    .sort();
  const children = comp.getAllSubcomponents().map(outline).sort();
  return JSON.stringify([comp.name, props, children]);
}

/**
 * `serialize` for a write, checked: the text is parsed back and must describe
 * exactly the tree it was made from — the same components, the same
 * properties, the same ORGANIZER / ATTENDEEs — with no line break inside a
 * line. Every value is validated at the tool's schema, but ical.js writes a
 * URI value (URL) unescaped and a CR in a TEXT value raw, so one that got
 * through would end its line and start another property: an injected
 * ATTENDEE is an invitation iCloud emails, which neither the confirm gate nor
 * APPLE_WRITE_MODE=additive (both of which read the ATTENDEEs they were
 * given) would ever see. Refused before anything is sent.
 */
export function serializeForWrite(vcal: Component): string {
  const text = serialize(vcal);
  let intact = !/\r(?!\n)|(?<!\r)\n/.test(text);
  if (intact) {
    try {
      intact = outline(ICAL.Component.fromString(text)) === outline(vcal);
    } catch {
      intact = false;
    }
  }
  if (!intact) {
    // "Or already stored": an update rewrites the whole event, so a stray CR that another app left inside one of
    // its values trips this too — and the caller cannot remove it by changing their request.
    throw new InvalidArgumentError(
      'calendar: a value in this request, or one already stored in the event, contains a line break or control character ' +
        'that would change the event\'s structure (it would add properties — such as an ATTENDEE, whom iCloud would ' +
        'email — or break the event). Nothing was written.',
      'Remove line breaks and control characters from title, location, url and attendee names. If the request has none, ' +
        'the stored event already holds one (written by another app): change that event in Apple Calendar instead.',
    );
  }
  return text;
}

export { ICAL };
