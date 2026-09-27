import { beforeEach, describe, expect, it } from 'vitest';
import { calendarHealth, createCalendarHealth } from '../../src/calendar/health.js';
import { REJECTED_HINT } from '../../src/icloud-auth.js';
import { FakeCalDav, PASS, USER } from './fake-caldav.js';

let dav: FakeCalDav;

beforeEach(() => {
  dav = new FakeCalDav().install();
});

describe('calendarHealth', () => {
  it('is not configured without iCloud credentials (and does no I/O)', async () => {
    const r = await calendarHealth.check();
    expect(r).toMatchObject({ service: 'calendar', configured: false, missing: ['ICLOUD_USERNAME', 'ICLOUD_APP_PASSWORD'] });
    expect(dav.requests).toEqual([]);
  });

  it('probes the calendar home with one Depth-0 PROPFIND', async () => {
    process.env.ICLOUD_USERNAME = USER;
    process.env.ICLOUD_APP_PASSWORD = PASS;
    process.env.ICLOUD_DEFAULT_CALENDAR = 'Work';
    const r = await createCalendarHealth(async () => dav.context()).check();
    expect(r).toMatchObject({
      configured: true,
      ok: true,
      credential: { source: 'ICLOUD_USERNAME + ICLOUD_APP_PASSWORD', detail: { appleId: USER, defaultCalendar: 'Work' } },
      probe: 'CalDAV discovery + PROPFIND calendar home (Depth 0)',
      notes: ['Calendar home reached (discovery: memory).'],
    });
    expect(dav.requests.map((q) => [q.method, q.headers.depth])).toEqual([['PROPFIND', '0']]);
    const noSource = await createCalendarHealth(async () => ({ ...dav.context(), source: undefined })).check();
    expect(noSource.notes).toEqual(['Calendar home reached (discovery: discovered).']);
  });

  it('reports a rejected credential with the app-specific-password hint', async () => {
    process.env.ICLOUD_USERNAME = USER;
    process.env.ICLOUD_APP_PASSWORD = PASS;
    dav.hooks.push(() => ({ status: 401 }));
    const r = await createCalendarHealth(async () => dav.context()).check();
    expect(r).toMatchObject({ configured: true, ok: false, error: { code: 'CREDENTIALS_REJECTED', status: 401 }, hint: REJECTED_HINT });
    expect(r.credential?.detail).toEqual({ appleId: USER });
  });
});
