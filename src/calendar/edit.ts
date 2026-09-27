import { AppleToolError, InvalidArgumentError } from '../errors.js';
import { childUrl } from '../dav/client.js';
import { assertWritable, resolveCalendar, type CalendarInfo } from './caldav.js';
import { expandSeries, findOccurrence, rulePosition, seriesWalker, singleOccurrence, type Occurrence } from './expand.js';
import type { LoadedEvent } from './events.js';
import { formatOccurrence, recurrenceOf, whenLabel } from './format.js';
import { formatEventId, formatOccurrenceId } from './ids.js';
import {
  addTimeProp,
  eventParts,
  instantOf,
  isRecurringMaster,
  isSelf,
  parseCalendar,
  readAttendees,
  ruleOf,
  serializeForWrite,
  textProp,
  touch,
  type Component,
  type EventParts,
  type Time,
} from './ics.js';
import {
  applyField,
  changedFields,
  continuationSeries,
  createOverride,
  editSeries,
  isFirstInstance,
  occInstant,
  planTimes,
  recurrenceValue,
  truncateSeries,
  wantsTimeChange,
  writeTimes,
  writeZoneFor,
  type FieldChanges,
  type Identity,
  type TimeInput,
} from './series.js';

/**
 * Plans for update and delete: the complete set of writes, computed in
 * memory from a FRESH read before anything is sent, so the confirm gate can
 * show exactly what will happen and a phase-2 call recomputes it against the
 * current state.
 */

export type Span = 'thisEvent' | 'futureEvents' | 'allEvents';

export const SCOPE: Record<Span | 'single', string> = {
  single: 'this event',
  thisEvent: 'this occurrence only',
  futureEvents: 'this and all following occurrences',
  allEvents: 'every occurrence of the series',
};

function needsOccurrence(baseId: string): InvalidArgumentError {
  return new InvalidArgumentError(
    `${baseId} is a recurring series; acting on it by this id would change every occurrence. ` +
      'Pass the id of one occurrence (list or search the date you want; it ends in "#occ=…"), or span: "allEvents" to mean the whole series.',
  );
}

export interface PutOp {
  url: string;
  body: string;
  ifMatch?: string;
  ifNoneMatch?: '*';
  /** What this write is, for messages. */
  label: string;
}

export interface EditEnv {
  zone: string;
  now: Date;
  newUid: () => string;
  /** Needed only when attendees change. */
  who?: Identity;
}

/** The occurrence `key` names in `parts`, or — for a bare series id — the series' first instance. */
export function occurrenceFor(parts: EventParts, key: string | undefined, zone: string): Occurrence | undefined {
  if (key !== undefined) return findOccurrence(parts, key, zone);
  const master = parts.master;
  if (!master) return undefined;
  const single = singleOccurrence(master, zone);
  return isRecurringMaster(master) ? { ...single, master, recurring: true } : single;
}

function hasAttendees(vcal: Component): boolean {
  return vcal.getAllSubcomponents('vevent').some((ev) => ev.hasProperty('attendee'));
}

/**
 * Whether a master still yields an occurrence (a rule that cannot be walked
 * is assumed to). Deleting the last one by EXDATE would otherwise leave a
 * resource that shows nothing anywhere yet still exists.
 */
function hasInstance(master: Component, zone: string): boolean {
  try {
    return seriesWalker(master, zone)() !== null;
  } catch {
    return true;
  }
}

function ridInstant(comp: Component, zone: string): number {
  return instantOf(comp.getFirstPropertyValue('recurrence-id') as Time, zone).getTime();
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export interface UpdateInput extends FieldChanges, TimeInput {
  span: Span;
  calendar?: string;
}

export interface UpdatePlan {
  span: Span | 'single';
  scope: string;
  /** Writes in order; the first is always the loaded resource (re-targeted after a move). */
  puts: PutOp[];
  move?: CalendarInfo;
  /** Where the edited occurrence ends up, what it should read back as, and the occurrence itself (for the preview). */
  result: { calendar: CalendarInfo; resourceName: string; eventId: string; expected: Record<string, unknown>; occurrence: Occurrence };
  before: Record<string, unknown>;
  notes: string[];
  /** The event has attendees now or will after this change: iCloud emails them. */
  notifiesAttendees: boolean;
  /** futureEvents: the id of the new series the occurrence now belongs to. */
  newSeriesId?: string;
}

export function planUpdate(loaded: LoadedEvent, input: UpdateInput, env: EditEnv): UpdatePlan {
  const { calendar, parts, vcal, target, recurring, id, resource } = loaded;
  const { zone } = env;
  const fields = changedFields(input);
  const timeChange = wantsTimeChange(input);
  if (input.timeZone !== undefined && input.startDate === undefined && input.endDate === undefined) {
    throw new InvalidArgumentError('timeZone only applies together with startDate or endDate (it is the zone they are read and written in).');
  }
  if (!timeChange && fields.length === 0 && input.calendar === undefined) {
    throw new InvalidArgumentError('Nothing to change: pass at least one of title, startDate, endDate, isAllDay, location, notes, url, alarms, attendees or calendar.');
  }
  assertWritable(calendar);
  const span = input.span;
  if (recurring && id.occ === undefined && span !== 'allEvents') throw needsOccurrence(id.baseId);

  let move: CalendarInfo | undefined;
  if (input.calendar !== undefined) {
    const dest = resolveCalendar(loaded.calendars, input.calendar, 'calendar');
    if (dest !== calendar) {
      if (recurring && span !== 'allEvents') {
        throw new InvalidArgumentError('Moving a recurring event to another calendar moves the whole series; pass span: "allEvents".');
      }
      assertWritable(dest);
      move = dest;
    } else if (!timeChange && fields.length === 0) {
      throw new InvalidArgumentError(`Nothing to change: the event is already in "${calendar.name}".`);
    }
  }
  if (input.attendees !== undefined) {
    const who = env.who as Identity;
    const foreign = vcal
      .getAllSubcomponents('vevent')
      .map((ev) => ev.getFirstProperty('organizer'))
      .some((p) => p !== null && !isSelf(p, who.self));
    if (foreign) {
      throw new AppleToolError('UNSUPPORTED', 'Only the organizer can change who is invited, and this event is organised by someone else. Nothing was changed.');
    }
  }
  const destCal = move ?? calendar;
  const before = formatOccurrence(target, { calendar, baseId: id.baseId, zone });
  const times = planTimes(target, input, zone, recurring);
  const notifiesAttendees = hasAttendees(vcal) || (input.attendees?.length ?? 0) > 0;
  const ifMatch = resource.etag ?? '*';
  const notes: string[] = [];
  const checks: Array<() => void> = [];
  const edit = { times, timeInput: input, fields: input, who: env.who, zone, now: env.now, notes, checks };

  let effective: Span | 'single' = span;
  let resultVcal = vcal;
  let resultName = resource.name;
  let key: string | undefined = target.occ;
  const puts: PutOp[] = [{ url: resource.url, body: '', ifMatch, label: 'the event' }];
  let newSeriesId: string | undefined;

  const applyTo = (comp: Component) => {
    if (times) writeTimes(comp, times, writeZoneFor(vcal, comp, input, zone));
    for (const f of fields) applyField(comp, f, input, env.who);
    touch(comp, env.now);
  };

  if (!recurring) {
    effective = 'single';
    applyTo(parts.master as Component);
  } else if (!parts.master) {
    // Occurrences of a series organised elsewhere (an invitation): each override stands alone.
    if (times && span !== 'thisEvent') {
      throw new AppleToolError('UNSUPPORTED', 'This event holds only individual occurrences of a series organised elsewhere; change their times one at a time (span: "thisEvent").');
    }
    const from = span === 'futureEvents' ? ridInstant(target.comp, zone) : Number.NEGATIVE_INFINITY;
    const inScope = span === 'thisEvent' ? [target.comp] : parts.overrides.filter((o) => ridInstant(o, zone) >= from);
    for (const comp of inScope) applyTo(comp);
  } else if (span === 'thisEvent') {
    applyTo(target.isOverride ? target.comp : createOverride(vcal, parts.master, target, zone));
  } else if (span === 'allEvents' || isFirstInstance(parts.master, target.occ as string, zone)) {
    if (span === 'futureEvents') notes.push('This is the first occurrence of the series, so "this and all following" is the whole series.');
    effective = 'allEvents';
    key = editSeries({ ...edit, vcal, master: parts.master, overrides: parts.overrides, target });
  } else {
    const occ = target.occ as string;
    const at = occInstant(occ, zone).getTime();
    const position = rulePosition(parts.master, new Date(at), zone);
    if (ruleOf(parts.master) && position.next?.getTime() !== at) {
      // An occurrence added by RDATE: the continuation would start its rule there — on the wrong weekday, or (past a
      // COUNT) with no end at all — and list the occurrence twice.
      throw new AppleToolError(
        'UNSUPPORTED',
        `calendar: this occurrence was added to the series individually (an RDATE), not by its repeat rule, so the series cannot be split at it. Nothing was changed.`,
        { hint: 'Change this occurrence alone (span "thisEvent"), change the whole series (span "allEvents"), or split at an occurrence the rule produces.' },
      );
    }
    const used = position.before;
    const carried = parts.overrides.filter((o) => ridInstant(o, zone) >= at);
    const uid = env.newUid();
    const next = continuationSeries(vcal, parts.master, carried, target, used, { uid, now: env.now, zone });
    truncateSeries(vcal, parts.master, parts.overrides, occ, zone, env.now);
    const nextTarget = findOccurrence({ master: next.master, overrides: next.overrides }, occ, zone) as Occurrence;
    key = editSeries({ ...edit, vcal: next.vcal, master: next.master, overrides: next.overrides, target: nextTarget });
    resultVcal = next.vcal;
    resultName = `${uid}.ics`;
    newSeriesId = formatEventId(calendar.id, resultName);
    puts[0]!.label = 'the original series (ended just before this occurrence)';
    puts.push({ url: childUrl(calendar.url, resultName), body: serializeForWrite(next.vcal), ifNoneMatch: '*', label: 'the new series (this occurrence onwards)' });
    notes.push(`The series was split: earlier occurrences stay in ${id.baseId}; this occurrence and the rest now form the series ${newSeriesId}.`);
  }
  // A move alone changes no content: the MOVE is the whole write. Any other change is serialized CHECKED (see
  // serializeForWrite): the text iCloud stores must hold exactly the attendees the confirm gate was shown.
  if (!timeChange && fields.length === 0) puts.length = 0;
  else puts[0]!.body = serializeForWrite(vcal);

  const baseId = formatEventId(destCal.id, resultName);
  const edited = occurrenceFor(eventParts(resultVcal), key, zone);
  if (!edited) {
    // Planned in memory: nothing has been written yet, so refusing here leaves the event exactly as it was.
    throw new AppleToolError(
      'UNSUPPORTED',
      `calendar: after this change the occurrence would no longer fall on the series' repeat rule, so the result cannot be checked. Nothing was changed.`,
      { hint: 'Edit this occurrence alone (span "thisEvent"), or delete the series and create it again with the new times.' },
    );
  }
  // Then that every other occurrence moved with it (still in memory: a refusal writes nothing).
  for (const check of checks) check();
  const after = formatOccurrence(edited, { calendar: destCal, baseId, zone });
  return {
    span: effective,
    scope: SCOPE[effective],
    puts,
    ...(move ? { move } : {}),
    result: { calendar: destCal, resourceName: resultName, eventId: key !== undefined ? formatOccurrenceId(baseId, key) : baseId, expected: after, occurrence: edited },
    before,
    notes,
    notifiesAttendees,
    ...(newSeriesId !== undefined ? { newSeriesId } : {}),
  };
}

/**
 * The text that puts a series back after a split whose second half could not
 * be created. Without attendees it is the original, byte for byte. With them,
 * iCloud has already emailed the shortened series (`sent`, at a higher
 * SEQUENCE), and an attendee's calendar ignores an update whose SEQUENCE is
 * not above the one it holds (RFC 5546 §2.1.4) — so every component of the
 * restore carries a SEQUENCE above any the shortened series carried, or the
 * attendees would keep the shortened one.
 */
export function rollbackBody(original: string, sent: string, now: Date): { body: string; notifiesAttendees: boolean } {
  const vcal = parseCalendar(original, 'the original series');
  if (!hasAttendees(vcal)) return { body: original, notifiesAttendees: false };
  const sequences = (v: Component) => v.getAllSubcomponents('vevent').map((ev) => Number(ev.getFirstPropertyValue('sequence') ?? 0));
  const top = Math.max(...sequences(vcal), ...sequences(parseCalendar(sent, 'the shortened series')));
  for (const ev of vcal.getAllSubcomponents('vevent')) {
    ev.updatePropertyWithValue('sequence', top);
    touch(ev, now); // top + 1, with fresh DTSTAMP / LAST-MODIFIED
  }
  return { body: serializeForWrite(vcal), notifiesAttendees: true };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export interface DeletePlan {
  span: Span | 'single';
  scope: string;
  op: { kind: 'delete'; url: string; ifMatch: string } | { kind: 'put'; url: string; body: string; ifMatch: string };
  /** After the write: the whole resource is gone, or this occurrence no longer exists in it. */
  verify: { gone: true } | { occ: string };
  preview: Record<string, unknown>;
  notes: string[];
}

export function planDelete(loaded: LoadedEvent, span: Span, env: { zone: string; now: Date }): DeletePlan {
  const { calendar, parts, vcal, target, recurring, id, resource } = loaded;
  const { zone, now } = env;
  assertWritable(calendar);
  if (recurring && id.occ === undefined && span !== 'allEvents') throw needsOccurrence(id.baseId);
  const ifMatch = resource.etag ?? '*';
  const remove = { kind: 'delete' as const, url: resource.url, ifMatch };
  const notes: string[] = [];
  let effective: Span | 'single' = span;
  let scope: string;
  let op: DeletePlan['op'] = remove;
  let verify: DeletePlan['verify'] = { gone: true };

  if (!recurring) {
    effective = 'single';
    scope = SCOPE.single;
  } else if (span === 'allEvents' || (span === 'futureEvents' && parts.master && isFirstInstance(parts.master, id.occ as string, zone))) {
    effective = 'allEvents';
    const next = expandSeries(parts, { from: now, to: new Date(now.getTime() + 365 * 86_400_000), zone });
    const n = `${next.occurrences.length}${next.truncated ? '+' : ''}`;
    scope =
      next.truncated === 'rule'
        ? 'the whole series (its repeat rule cannot be expanded, so its occurrences cannot be counted)'
        : `the whole series (${n} occurrence${n === '1' ? '' : 's'} in the next year)`;
    if (span === 'futureEvents') notes.push('This is the first occurrence of the series, so "this and all following" deletes the whole series.');
  } else {
    const occ = id.occ as string;
    const master = parts.master;
    if (span === 'thisEvent') {
      if (master) {
        addTimeProp(master, 'exdate', recurrenceValue(master, target, zone));
        touch(master, now);
      }
      if (target.isOverride) vcal.removeSubcomponent(target.comp);
    } else if (master) {
      truncateSeries(vcal, master, parts.overrides, occ, zone, now);
    } else {
      const at = ridInstant(target.comp, zone);
      for (const o of parts.overrides) if (ridInstant(o, zone) >= at) vcal.removeSubcomponent(o);
    }
    scope = SCOPE[span];
    const left = eventParts(vcal);
    if (left.overrides.length > 0 || (left.master && hasInstance(left.master, zone))) {
      // Checked like every other write: a stored value holding a stray CR (another app's) is refused, never re-sent.
      op = { kind: 'put', url: resource.url, body: serializeForWrite(vcal), ifMatch };
      verify = { occ };
    } else notes.push('No occurrence would be left, so the whole event is deleted.');
  }

  const attendees = readAttendees(target.comp);
  const recurrence = parts.master && recurring ? recurrenceOf(parts.master, zone) : undefined;
  const preview: Record<string, unknown> = {
    event: textProp(target.comp, 'summary') ?? '(untitled)',
    when: whenLabel(target, zone),
    calendar: calendar.name,
    deletes: scope,
    ...(recurrence ? { repeats: recurrence.summary } : {}),
    ...(attendees.length > 0
      ? {
          attendees: attendees.map((a) => a.name ?? a.email ?? '(unknown)').join(', '),
          notice: 'The event has attendees: iCloud will email them a cancellation (or tell the organizer you are not attending).',
        }
      : {}),
  };
  return { span: effective, scope, op, verify, preview, notes };
}
