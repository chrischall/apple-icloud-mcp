import { describe, expect, it } from 'vitest';
import { contactsHealth, createContactsHealth } from '../../src/contacts/health.js';
import { DSID, FakeICloud, PASS, USER, useContactsEnv } from './fake-icloud.js';

useContactsEnv();

describe('contactsHealth', () => {
  it('not configured: names the missing variables without any request', async () => {
    delete process.env.ICLOUD_USERNAME;
    delete process.env.ICLOUD_APP_PASSWORD;
    const h = await contactsHealth.check();
    expect(h).toMatchObject({ service: 'contacts', configured: false, missing: ['ICLOUD_USERNAME', 'ICLOUD_APP_PASSWORD'] });
    expect(h.ok).toBeUndefined();
  });

  it('configured: discovery + one PROPFIND Depth 0 on the home; a second check reuses discovery', async () => {
    const fake = new FakeICloud();
    const probe = createContactsHealth({ request: fake.request });
    const first = await probe.check();
    expect(first).toMatchObject({
      service: 'contacts',
      configured: true,
      ok: true,
      credential: { source: 'ICLOUD_USERNAME + ICLOUD_APP_PASSWORD', detail: { appleId: USER } },
      notes: ['CardDAV discovery ran now and was cached.'],
    });
    expect(fake.log()).toEqual(['PROPFIND /', `PROPFIND /${DSID}/principal/`, `PROPFIND /${DSID}/carddavhome/`]);
    expect(fake.calls[2]!.headers!.Depth).toBe('0');
    const second = await probe.check();
    expect(second.notes).toEqual(['CardDAV discovery was reused from the memory cache.']);
    expect(JSON.stringify(first)).not.toContain(PASS);
  });

  it('the default probe goes through httpRequest (here the test network refuses, and that is reported)', async () => {
    const h = await contactsHealth.check();
    expect(h).toMatchObject({ configured: true, ok: false, error: { code: 'NETWORK_ERROR' } });
    expect(fetch).toHaveBeenCalled();
  });

  it('a rejected credential is reported with the app-specific-password hint', async () => {
    const fake = new FakeICloud();
    fake.fail({ method: 'PROPFIND', url: 'https://contacts.icloud.com/', status: 401 });
    const h = await createContactsHealth({ request: fake.request }).check();
    expect(h).toMatchObject({ configured: true, ok: false, error: { code: 'CREDENTIALS_REJECTED', status: 401 } });
    expect(h.hint).toContain('App-specific passwords are revoked');
  });
});
