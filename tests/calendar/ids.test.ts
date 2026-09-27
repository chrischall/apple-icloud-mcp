import { describe, expect, it } from 'vitest';
import { InvalidArgumentError } from '../../src/errors.js';
import { decodeIdPart, encodeIdPart, formatEventId, formatOccurrenceId, isValidOcc, parseEventId } from '../../src/calendar/ids.js';

describe('event ids', () => {
  it('escapes the separators and % so every name round-trips', () => {
    expect(encodeIdPart('a/b#c%d')).toBe('a%2Fb%23c%25d');
    expect(decodeIdPart('a%2Fb%23c%25d')).toBe('a/b#c%d');
    expect(decodeIdPart('x%2fy')).toBe('x/y');
    // The calendar id is passed as PRINTED (already escaped) and is not escaped again.
    const id = formatEventId(encodeIdPart('cal/1%#'), 'we#ird%.ics');
    expect(id).toBe('cal%2F1%25%23/we%23ird%25.ics');
    expect(parseEventId(id)).toEqual({ baseId: id, calendarId: 'cal/1%#', resourceName: 'we#ird%.ics' });
  });

  it('parses an occurrence marker from the end', () => {
    const occ = formatOccurrenceId('home/abc.ics', '2026-10-20T13:00:00Z');
    expect(occ).toBe('home/abc.ics#occ=2026-10-20T13:00:00Z');
    expect(parseEventId(occ)).toEqual({ baseId: 'home/abc.ics', calendarId: 'home', resourceName: 'abc.ics', occ: '2026-10-20T13:00:00Z' });
    expect(parseEventId('home/bday.ics#occ=2026-10-23').occ).toBe('2026-10-23');
  });

  it('refuses a marker with an invalid value rather than treating it as part of a name', () => {
    expect(() => parseEventId('home/a.ics#occ=tomorrow')).toThrow(InvalidArgumentError);
    expect(() => parseEventId('home/a.ics#occ=2026-02-30')).toThrow(/not an occurrence date/);
    expect(() => parseEventId('home/a.ics#occ=2026-10-20T25:00:00Z')).toThrow(/not an occurrence date/);
  });

  it('refuses shapes that are not event ids', () => {
    for (const bad of ['abc.ics', 'a/b/c.ics', '/abc.ics', 'home/', 'home/a#b.ics']) {
      expect(() => parseEventId(bad), bad).toThrow(/is not an event id/);
    }
  });

  it('validates occurrence values strictly', () => {
    expect(isValidOcc('2024-02-29')).toBe(true);
    expect(isValidOcc('2023-02-29')).toBe(false);
    expect(isValidOcc('2026-10-20T23:59:59Z')).toBe(true);
    expect(isValidOcc('2026-10-20T23:60:00Z')).toBe(false);
    expect(isValidOcc('2026-10-20T13:00:00')).toBe(false);
    expect(isValidOcc('2026-13-01')).toBe(false);
  });
});
