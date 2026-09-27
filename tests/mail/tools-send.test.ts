import { describe, expect, it, vi } from 'vitest';
import PostalMime from 'postal-mime';
import { SmtpPhaseError } from '../../src/mail/smtp.js';
import { latchRejection } from '../../src/icloud-auth.js';
import { NO_ELICIT_CTX, callConfirmed, callPreview, type GatedHandler } from '../tools/_confirm-helpers.js';
import { harness, useMailEnv } from './harness.js';
import { PASS, imapError } from './fake-imap.js';

useMailEnv();

function gated(h: ReturnType<typeof harness>): GatedHandler {
  return h.tools.get('apple_mail_send')?.cb as unknown as GatedHandler;
}

const parse = (text: string): any => JSON.parse(text);

describe('apple_mail_send — new message', () => {
  it('phase 1 previews without connecting anywhere', async () => {
    const h = harness();
    const p = await callPreview(gated(h), {
      to: ['Bob <bob@example.com>'],
      cc: ['carol@example.com'],
      bcc: ['dan@example.com'],
      subject: 'Plans',
      body: 'See you at 6.',
    });
    expect(p.action).toBe('apple.mail.message.send');
    expect(p.preview).toEqual({
      from: 'me@icloud.com',
      to: ['Bob <bob@example.com>'],
      cc: ['carol@example.com'],
      bcc: ['dan@example.com'],
      subject: 'Plans',
      body: 'See you at 6.',
      bodyChars: 13,
      attachments: 'none',
    });
    expect(h.imap.created).toHaveLength(0);
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('phase 2 submits over SMTP (STARTTLS, full address), then files a \\Seen copy in Sent', async () => {
    const h = harness();
    vi.useFakeTimers({ now: new Date('2026-09-26T16:00:00Z'), toFake: ['Date'] });
    const r = await callConfirmed(gated(h), {
      to: ['Bob <bob@example.com>'],
      cc: ['carol@example.com'],
      bcc: ['dan@example.com'],
      subject: 'Plans',
      body: 'See you at 6.',
    });
    expect(r.isError).toBeUndefined();
    const out = parse(r.content[0]?.text as string);
    expect(out).toMatchObject({
      sent: true,
      verified: true,
      from: 'me@icloud.com',
      to: ['Bob <bob@example.com>'],
      cc: ['carol@example.com'],
      bcc: ['dan@example.com'],
      subject: 'Plans',
      accepted: ['bob@example.com', 'carol@example.com', 'dan@example.com'],
      savedToSent: true,
      sentMailbox: 'Sent Messages',
      sentUid: 1,
    });
    expect(out.messageId).toMatch(/@icloud\.com>$/);
    expect(out).not.toHaveProperty('warnings');
    expect(out).not.toHaveProperty('rejected');
    expect(h.smtpOptions).toEqual([
      { host: 'smtp.mail.me.com', port: 587, secure: false, requireTLS: true, user: 'me@icloud.com', pass: 'abcd-efgh-ijkl-mnop', timeoutMs: 30_000 },
    ]);
    const sub = h.submitted[0];
    expect(sub?.from).toBe('me@icloud.com');
    expect(sub?.to).toEqual(['bob@example.com', 'carol@example.com', 'dan@example.com']);
    expect(sub?.raw.toString()).not.toMatch(/^Bcc:/m);
    const saved = h.imap.mailboxes.get('Sent Messages')?.messages.get(1);
    expect(saved?.flags.has('\\Seen')).toBe(true);
    expect(saved?.internalDate.toISOString()).toBe('2026-09-26T16:00:00.000Z');
    expect(saved?.source.toString()).toMatch(/^Bcc: dan@example.com/m);
    const parsed = await PostalMime.parse(sub?.raw as Buffer);
    expect(parsed.messageId).toBe(out.messageId);
    expect(parsed.text?.trim()).toBe('See you at 6.');
  });

  it('refuses bad input before anything is sent', async () => {
    const h = harness();
    const cb = gated(h);
    const err = async (args: Record<string, unknown>): Promise<any> => parse((await cb(args)).content[0]?.text as string).error;
    expect(await err({ to: ['bob'], subject: 's', body: 'b' })).toMatchObject({ code: 'INVALID_ARGUMENT', message: 'to[0]: "bob" is not a single email address.' });
    expect((await err({ to: ['a@b.com'], body: 'b' })).message).toMatch(/subject is required/);
    expect((await err({ to: ['a@b.com'], subject: 's', body: 'b', quoteOriginal: true })).message).toBe('quoteOriginal needs replyTo.');
    const many = Array.from({ length: 60 }, (_, i) => `u${i}@x.com`);
    expect((await err({ to: many, cc: many, subject: 's', body: 'b' })).message).toMatch(/120 recipients/);
    expect((await err({ to: ['a@b.com'], subject: 's', body: 'b', timeZone: 'Nowhere/X' })).code).toBe('INVALID_ARGUMENT');
    delete process.env.ICLOUD_USERNAME;
    expect((await err({ to: ['a@b.com'], subject: 's', body: 'b' })).code).toBe('NOT_CONFIGURED');
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('shows a long body cut in the preview', async () => {
    const h = harness();
    const p = await callPreview(gated(h), { to: ['a@b.com'], subject: 's', body: 'x'.repeat(2500) });
    expect(p.preview.body).toBe(`${'x'.repeat(2000)}…`);
    expect(p.preview).toMatchObject({ bodyChars: 2500, bodyTruncatedInPreview: true });
  });

  it('tunnels SMTP through HTTPS_PROXY, and refuses a SOCKS proxy before asking the user to confirm', async () => {
    const h = harness();
    process.env.HTTPS_PROXY = 'http://127.0.0.1:3128';
    await callConfirmed(gated(h), { to: ['a@b.com'], subject: 's', body: 'b' });
    expect(h.smtpOptions[0]?.proxy).toBe('http://127.0.0.1:3128');
    h.submit.mockClear();
    process.env.HTTPS_PROXY = 'socks5://127.0.0.1:1080';
    // Phase 1 already refuses: no preview (and no token) for a message that cannot be sent.
    const r = await gated(h)({ to: ['a@b.com'], subject: 's', body: 'b' }, NO_ELICIT_CTX);
    expect(r.isError).toBe(true);
    expect(parse(r.content[0]?.text as string).error.code).toBe('UNSUPPORTED');
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('refuses a latched credential before asking, and before SMTP', async () => {
    const h = harness();
    latchRejection({ username: 'me@icloud.com', password: 'abcd-efgh-ijkl-mnop' });
    const r = await gated(h)({ to: ['a@b.com'], subject: 's', body: 'b' }, NO_ELICIT_CTX);
    expect(parse(r.content[0]?.text as string).error.code).toBe('CREDENTIALS_REJECTED');
    expect(parse(r.content[0]?.text as string)).not.toHaveProperty('confirmToken');
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('classifies SMTP failures: auth (latched), refused (nothing sent), lost after data (unconfirmed)', async () => {
    const h = harness();
    const run = async (err: unknown): Promise<any> => {
      h.submit.mockRejectedValueOnce(err);
      const r = await callConfirmed(gated(h), { to: ['a@b.com'], subject: 's', body: 'b' });
      return parse(r.content[0]?.text as string).error;
    };
    expect(await run(new SmtpPhaseError('data', { code: 'ECONNECTION', message: 'Connection closed' }))).toMatchObject({ code: 'UNCONFIRMED_WRITE' });
    expect(await run(new SmtpPhaseError('envelope', { code: 'EENVELOPE', responseCode: 550, response: '550 no' }))).toMatchObject({
      code: 'UPSTREAM_ERROR',
      message: expect.stringContaining('Nothing was sent'),
    });
    expect(h.imap.mailboxes.get('Sent Messages')?.messages.size).toBe(0);
    expect(await run(new SmtpPhaseError('auth', { code: 'EAUTH', responseCode: 535 }))).toMatchObject({ code: 'CREDENTIALS_REJECTED', service: 'mail' });
    const after = await gated(h)({ to: ['a@b.com'], subject: 's', body: 'b' }, NO_ELICIT_CTX);
    expect(parse(after.content[0]?.text as string).error.message).toMatch(/already rejected/);
  });

  it('reports refused recipients and a Sent copy that could not be saved — as warnings, not failure', async () => {
    const h = harness();
    h.submit.mockImplementationOnce(async (m) => ({ accepted: [m.to[0] as string], rejected: ['bad@x.com'] }));
    h.imap.override('append', () => false, 1);
    const r = await callConfirmed(gated(h), { to: ['a@b.com', 'bad@x.com'], subject: 's', body: 'b' });
    const out = parse(r.content[0]?.text as string);
    expect(out).toMatchObject({ sent: true, accepted: ['a@b.com'], rejected: ['bad@x.com'], savedToSent: false });
    expect(out.warnings).toEqual([
      'iCloud refused these recipients, so they will not get it: bad@x.com.',
      'The message was sent, but iCloud did not save the copy to "Sent Messages".',
    ]);
  });

  it('still reports success when IMAP is unavailable afterwards', async () => {
    const h = harness();
    h.imap.connectError = imapError({ code: 'ECONNREFUSED' }, 'connect ECONNREFUSED');
    const r = await callConfirmed(gated(h), { to: ['a@b.com'], subject: 's', body: 'b' });
    const out = parse(r.content[0]?.text as string);
    expect(out).toMatchObject({ sent: true, savedToSent: false });
    expect(out.warnings[0]).toMatch(/^The message was sent, but a copy could not be saved to Sent Messages: iCloud Mail \(imap\.mail\.me\.com:993\) connection failed/);
    h.imap.connectError = undefined;
    h.imap.mailboxes.delete('Sent Messages');
    const noSent = parse((await callConfirmed(gated(h), { to: ['a@b.com'], subject: 's', body: 'b' })).content[0]?.text as string);
    expect(noSent.warnings[0]).toMatch(/This account has no sent mailbox/);
  });
});

describe('apple_mail_send — replies', () => {
  function seeded(): ReturnType<typeof harness> {
    const h = harness();
    h.imap.addMessage('INBOX', {
      from: 'bob@example.com',
      fromName: 'Bob',
      subject: 'Dinner?',
      messageId: '<m2@example.com>',
      references: '<m1@example.com>',
      date: 'Mon, 21 Sep 2026 14:30:00 +0000',
      text: 'Are you free Friday?\r\nBob',
    });
    return h;
  }

  it('previews the reply target by name and threads the sent message', async () => {
    const h = seeded();
    const args = { to: ['bob@example.com'], body: 'Yes!', replyTo: { uid: 1 } };
    const p = await callPreview(gated(h), args);
    expect(p.preview).toMatchObject({
      subject: 'Re: Dinner?',
      inReplyTo: { mailbox: 'INBOX', uid: 1, subject: 'Dinner?', from: 'Bob <bob@example.com>', date: 'Mon, Sep 21, 2026, 10:30 AM EDT' },
    });
    expect(h.imap.callsOf('fetchOne')[0]?.[1]).toEqual({ uid: true, headers: true });
    const r = await callConfirmed(gated(h), args);
    const out = parse(r.content[0]?.text as string);
    expect(out).toMatchObject({ sent: true, subject: 'Re: Dinner?', repliedTo: { mailbox: 'INBOX', uid: 1, markedAnswered: true } });
    const raw = h.submitted[0]?.raw.toString() as string;
    expect(raw).toContain('In-Reply-To: <m2@example.com>');
    expect(raw).toContain('References: <m1@example.com> <m2@example.com>');
    expect(h.imap.mailboxes.get('INBOX')?.messages.get(1)?.flags.has('\\Answered')).toBe(true);
    expect(h.imap.mailboxes.get('INBOX')?.messages.get(1)?.flags.has('\\Seen')).toBe(false);
  });

  it('quotes the original on request and keeps an explicit subject', async () => {
    const h = seeded();
    const args = { to: ['bob@example.com'], subject: 'Friday', body: 'Yes!  \n', replyTo: { mailbox: 'inbox', uid: 1, uidValidity: 1001 }, quoteOriginal: true };
    const p = await callPreview(gated(h), args);
    expect(p.preview).toMatchObject({ subject: 'Friday', quotesOriginal: true });
    expect(p.preview.body).toBe('Yes!\n\nOn Mon, Sep 21, 2026, 10:30 AM EDT, Bob <bob@example.com> wrote:\n> Are you free Friday?\n> Bob\n');
    await callConfirmed(gated(h), args);
    const parsed = await PostalMime.parse(h.submitted[0]?.raw as Buffer);
    expect(parsed.text).toContain('> Are you free Friday?');
  });

  it('warns about a very long quoted original', async () => {
    const h = harness();
    h.imap.addMessage('INBOX', { text: 'y'.repeat(25_000) });
    const p = await callPreview(gated(h), { to: ['a@b.com'], body: 'ok', replyTo: { uid: 1 }, quoteOriginal: true });
    expect(p.preview.warnings).toEqual(['The quoted original was cut to its first 20,000 characters.']);
  });

  it('warns when the original cannot be threaded, and handles a bare original', async () => {
    const h = harness();
    h.imap.addMessage('INBOX', { raw: 'Subject: \r\n\r\n' });
    const p = await callPreview(gated(h), { to: ['a@b.com'], body: 'ok', replyTo: { uid: 1 }, quoteOriginal: true });
    expect(p.preview.subject).toBe('Re:');
    expect(p.preview.inReplyTo).toEqual({ mailbox: 'INBOX', uid: 1 });
    expect(p.preview.body).toBe('ok\n\nOn an earlier date, the sender wrote:\n>\n');
    expect(p.preview.warnings).toEqual(['The original message has no Message-ID, so mail apps may not thread this reply with it.']);
    const r = await callConfirmed(gated(h), { to: ['a@b.com'], body: 'ok', replyTo: { uid: 1 } });
    expect(h.submitted[0]?.raw.toString()).not.toMatch(/^In-Reply-To:/m);
    expect(parse(r.content[0]?.text as string).warnings).toEqual(['The original message has no Message-ID, so mail apps may not thread this reply with it.']);
  });

  it('errors when the original is gone or renumbered', async () => {
    const h = seeded();
    const missing = await gated(h)({ to: ['a@b.com'], body: 'x', replyTo: { uid: 9 } });
    expect(parse(missing.content[0]?.text as string).error).toMatchObject({ code: 'NOT_FOUND', message: 'replyTo: no message with uid 9 in "INBOX".' });
    const stale = await gated(h)({ to: ['a@b.com'], body: 'x', replyTo: { uid: 1, uidValidity: 7 } });
    expect(parse(stale.content[0]?.text as string).error.code).toBe('INVALID_ARGUMENT');
    h.imap.override('fetchOne', () => false, 1);
    const falsy = await gated(h)({ to: ['a@b.com'], body: 'x', replyTo: { uid: 1 } });
    expect(parse(falsy.content[0]?.text as string).error.code).toBe('NOT_FOUND');
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('refuses a confirm token once the original changed underneath it', async () => {
    const h = seeded();
    const args = { to: ['bob@example.com'], body: 'Yes!', replyTo: { uid: 1 } };
    const { confirmToken } = await callPreview(gated(h), args);
    const box = h.imap.mailboxes.get('INBOX');
    if (box) box.uidValidity = 5000;
    const r = await gated(h)({ ...args, confirmToken });
    expect(r.content[0]?.text).not.toContain('"sent":true');
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('a refused \\Answered flag is a warning', async () => {
    const h = seeded();
    h.imap.override('messageFlagsAdd', () => false);
    const r = await callConfirmed(gated(h), { to: ['bob@example.com'], body: 'Yes!', replyTo: { uid: 1 } });
    const out = parse(r.content[0]?.text as string);
    expect(out.repliedTo).toEqual({ mailbox: 'INBOX', uid: 1, markedAnswered: false });
    expect(out.warnings).toEqual(['The original could not be marked answered.']);
  });

  it('when IMAP is gone after sending a reply, says both follow-ups were skipped', async () => {
    const h = seeded();
    let connects = 0;
    h.imap.override('connect', () => {
      connects++;
      if (connects === 3) throw imapError({ code: 'ECONNRESET' }, 'socket hang up');
      return PASS;
    });
    const r = await callConfirmed(gated(h), { to: ['bob@example.com'], body: 'Yes!', replyTo: { uid: 1 } });
    const out = parse(r.content[0]?.text as string);
    expect(out).toMatchObject({ sent: true, savedToSent: false, repliedTo: { mailbox: 'INBOX', uid: 1 } });
    expect(out.repliedTo).not.toHaveProperty('markedAnswered');
    expect(out.warnings[0]).toMatch(/^The message was sent, but a copy could not be saved to Sent Messages \(nor the original marked answered\): /);
  });

  it('a failure to mark the original answered is a warning', async () => {
    const h = seeded();
    h.imap.override('messageFlagsAdd', () => {
      throw imapError({ responseStatus: 'NO', responseText: 'read-only' });
    });
    const r = await callConfirmed(gated(h), { to: ['bob@example.com'], body: 'Yes!', replyTo: { uid: 1 } });
    const out = parse(r.content[0]?.text as string);
    expect(out.repliedTo).toEqual({ mailbox: 'INBOX', uid: 1, markedAnswered: false });
    expect(out.warnings).toEqual(['The original could not be marked answered: iCloud Mail refused marking the original answered: read-only.']);
    expect(out.savedToSent).toBe(true);
  });
});
