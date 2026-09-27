import { describe, expect, it } from 'vitest';
import { createMailHealth, mailHealth } from '../../src/mail/health.js';
import { REJECTED_HINT } from '../../src/icloud-auth.js';
import { FakeMailServer, imapError } from './fake-imap.js';
import { useMailEnv } from './harness.js';

useMailEnv();

describe('mailHealth', () => {
  it('is the mail probe', () => {
    expect(mailHealth.service).toBe('mail');
  });

  it('reports unconfigured without touching the network', async () => {
    delete process.env.ICLOUD_USERNAME;
    delete process.env.ICLOUD_APP_PASSWORD;
    const server = new FakeMailServer();
    const h = await createMailHealth(server.factory).check();
    expect(h).toMatchObject({ service: 'mail', configured: false, missing: ['ICLOUD_USERNAME', 'ICLOUD_APP_PASSWORD'] });
    expect(server.created).toHaveLength(0);
  });

  it('signs in, reads STATUS INBOX, logs out', async () => {
    const server = new FakeMailServer();
    server.addMessage('INBOX', { flags: ['\\Seen'] });
    server.addMessage('INBOX');
    const h = await createMailHealth(server.factory).check();
    expect(h).toMatchObject({
      service: 'mail',
      configured: true,
      ok: true,
      credential: {
        source: 'ICLOUD_USERNAME + ICLOUD_APP_PASSWORD',
        detail: { address: 'me@icloud.com', imap: 'imap.mail.me.com:993', smtp: 'smtp.mail.me.com:587', viaProxy: false },
      },
      probe: 'IMAP sign-in + STATUS INBOX (imap.mail.me.com:993)',
      notes: [
        'INBOX: 2 messages, 1 unread.',
        'IMAP accepted the name part of the address as the username.',
        'SMTP (sending) is not probed here; it is used only by apple_mail_send.',
      ],
    });
    expect(server.clients[0]?.loggedOut).toBe(true);
    expect(server.callsOf('getMailboxLock')).toHaveLength(0);
  });

  it('names the explicit address source, the full-address login and the proxy', async () => {
    process.env.ICLOUD_USERNAME = 'jane@gmail.com';
    process.env.ICLOUD_MAIL_ADDRESS = 'jane@icloud.com';
    process.env.HTTPS_PROXY = 'http://127.0.0.1:3128';
    const server = new FakeMailServer();
    server.acceptUsers = ['jane@icloud.com'];
    server.override('status', () => ({ path: 'INBOX', messages: 5 }));
    const h = await createMailHealth(server.factory).check();
    expect(h.credential).toMatchObject({ source: 'ICLOUD_MAIL_ADDRESS + ICLOUD_USERNAME + ICLOUD_APP_PASSWORD', detail: { viaProxy: true } });
    expect(h.notes?.slice(0, 2)).toEqual(['INBOX: 5 messages.', 'IMAP accepted the full address as the username.']);
  });

  it('fails with the rejected-credential hint', async () => {
    const server = new FakeMailServer();
    server.acceptUsers = [];
    const h = await createMailHealth(server.factory).check();
    expect(h).toMatchObject({ configured: true, ok: false, error: { code: 'CREDENTIALS_REJECTED', status: 401 }, hint: REJECTED_HINT });
  });

  it('fails when STATUS fails or says nothing', async () => {
    const server = new FakeMailServer();
    server.override('status', () => {
      throw imapError({ responseStatus: 'NO', responseText: 'try later' });
    }, 1);
    const a = await createMailHealth(server.factory).check();
    expect(a).toMatchObject({ ok: false, error: { code: 'UPSTREAM_ERROR', message: 'iCloud Mail refused STATUS INBOX: try later.' } });
    server.override('status', () => false, 1);
    const b = await createMailHealth(server.factory).check();
    expect(b).toMatchObject({ ok: false, error: { message: 'iCloud Mail signed in but did not report the INBOX status.' } });
  });
});
