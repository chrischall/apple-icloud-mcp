import { describe, expect, it } from 'vitest';
import { harness, useMailEnv } from './harness.js';
import { PASS, droppedMidCommand, imapError } from './fake-imap.js';

useMailEnv();

function seeded(): ReturnType<typeof harness> {
  const h = harness();
  h.imap.addMessage('INBOX', { subject: 'one' });
  h.imap.addMessage('INBOX', { subject: 'two', flags: ['\\Seen'] });
  h.imap.addMessage('INBOX', { subject: 'three', flags: ['\\Flagged'] });
  return h;
}

const flagsOf = (h: ReturnType<typeof harness>, uid: number, box = 'INBOX'): string[] =>
  [...(h.imap.mailboxes.get(box)?.messages.get(uid)?.flags ?? [])].sort();

describe('apple_mail_update_flags', () => {
  it('changes only what needs changing, then verifies by re-reading', async () => {
    const h = seeded();
    const { json, isError } = await h.call('apple_mail_update_flags', { uids: [1, 2, 3], seen: true, flagged: false });
    expect(isError).toBe(false);
    expect(json).toEqual({
      mailbox: 'INBOX',
      uidValidity: 1001,
      requested: { seen: true, flagged: false },
      changed: 2,
      alreadySet: 1,
      verified: true,
      messages: [
        { uid: 1, seen: true, flagged: false },
        { uid: 2, seen: true, flagged: false },
        { uid: 3, seen: true, flagged: false },
      ],
    });
    expect(h.imap.callsOf('messageFlagsAdd')).toEqual([['1,3', ['\\Seen'], { uid: true }]]);
    expect(h.imap.callsOf('messageFlagsRemove')).toEqual([['3', ['\\Flagged'], { uid: true }]]);
    expect(h.imap.clients[0]?.readOnly).toBe(false);
    expect(flagsOf(h, 3)).toEqual(['\\Seen']);
  });

  it('marks unread and flags; reports uids that do not exist', async () => {
    const h = seeded();
    const { json } = await h.call('apple_mail_update_flags', { mailbox: 'inbox', uids: [2, 99], seen: false, flagged: true, uidValidity: 1001 });
    expect(json).toMatchObject({ changed: 1, alreadySet: 0, notFound: [99], verified: true, messages: [{ uid: 2, seen: false, flagged: true }] });
    expect(flagsOf(h, 2)).toEqual(['\\Flagged']);
  });

  it('treats a FETCH answer without flags as "no flags set"', async () => {
    const h = seeded();
    h.imap.override('fetchAll', () => [{ seq: 2, uid: 2 }], 1);
    const { json } = await h.call('apple_mail_update_flags', { uids: [2], flagged: true });
    expect(json).toMatchObject({ changed: 1, verified: true, messages: [{ uid: 2, seen: true, flagged: true }] });
  });

  it('is a no-op when everything is already in the requested state', async () => {
    const h = seeded();
    const { json } = await h.call('apple_mail_update_flags', { uids: [2], seen: true });
    expect(json).toMatchObject({ changed: 0, alreadySet: 1, verified: true });
    expect(h.imap.callsOf('messageFlagsAdd')).toHaveLength(0);
  });

  it('refuses a call that changes nothing, and uids that are all gone', async () => {
    const h = seeded();
    expect((await h.call('apple_mail_update_flags', { uids: [1] })).json.error).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(h.imap.created).toHaveLength(0);
    expect((await h.call('apple_mail_update_flags', { uids: [50, 51], seen: true })).json.error).toMatchObject({
      code: 'NOT_FOUND',
      message: 'None of the uids 50, 51 exist in "INBOX".',
    });
  });

  it('a refused STORE that left the state unchanged is an error naming the server answer', async () => {
    const h = seeded();
    h.imap.override('messageFlagsAdd', function () {
      (h.imap.created[0]?.logger as { warn: (o: unknown) => void }).warn({ err: { responseStatus: 'NO', responseText: 'Permission denied' } });
      return false;
    });
    const { json, isError } = await h.call('apple_mail_update_flags', { uids: [1], seen: true });
    expect(isError).toBe(true);
    expect(json.error).toMatchObject({
      code: 'UPSTREAM_ERROR',
      message: 'iCloud Mail refused setting \\Seen (server said: Permission denied) in "INBOX". Nothing was changed.',
    });
  });

  it('a refusal after another change went through says what WAS applied', async () => {
    const h = seeded();
    h.imap.override('messageFlagsAdd', (range: string, flags: string[]) => (flags[0] === '\\Flagged' ? false : PASS));
    const { json, isError } = await h.call('apple_mail_update_flags', { uids: [1], seen: true, flagged: true });
    expect(isError).toBe(true);
    expect(json.error.message).toBe('iCloud Mail refused setting \\Flagged in "INBOX". Applied anyway: setting \\Seen on uid 1.');
    expect(flagsOf(h, 1)).toEqual(['\\Seen']);
  });

  it('a lost connection on the second change still reports the first', async () => {
    const h = seeded();
    h.imap.override('messageFlagsRemove', () => {
      throw imapError({ code: 'ECONNRESET' }, 'read ECONNRESET');
    });
    const { json } = await h.call('apple_mail_update_flags', { uids: [3], seen: true, flagged: false });
    expect(json.error.code).toBe('UNCONFIRMED_WRITE');
    expect(json.error.message).toMatch(/\(Already applied before this: setting \\Seen on uid 3\.\)$/);
  });

  it('a STORE that reported success but does not show yet is unverified, not failed', async () => {
    const h = seeded();
    h.imap.override('messageFlagsAdd', () => true);
    const { json, isError } = await h.call('apple_mail_update_flags', { uids: [1], seen: true });
    expect(isError).toBe(false);
    expect(json).toMatchObject({ changed: 1, verified: false, messages: [{ uid: 1, seen: false }] });
    expect(json.warnings).toEqual(['Some messages do not show the new state yet; iCloud may still be applying it.']);
  });

  it('a failed verification read is reported, and a refused-but-applied STORE counts as applied', async () => {
    const h = seeded();
    let n = 0;
    h.imap.override('fetchAll', () => {
      n++;
      if (n === 2) throw imapError({ code: 'NoConnection' }, 'Connection not available');
      return PASS;
    });
    const { json } = await h.call('apple_mail_update_flags', { uids: [1], flagged: true });
    expect(json.verified).toBe(false);
    expect(json.warnings[0]).toMatch(/^The change could not be verified: iCloud Mail \(imap\.mail\.me\.com:993\) connection failed during re-reading the flags/);
    expect(json.messages).toEqual([{ uid: 1, seen: false, flagged: false }]);

    const h2 = seeded();
    h2.imap.override('messageFlagsAdd', () => {
      h2.imap.mailboxes.get('INBOX')?.messages.get(1)?.flags.add('\\Seen');
      return false;
    });
    const r2 = await h2.call('apple_mail_update_flags', { uids: [1], seen: true });
    expect(r2.json).toMatchObject({ changed: 0, verified: true, messages: [{ uid: 1, seen: true }] });
  });

  it('a lost connection during STORE is an unconfirmed write', async () => {
    const h = seeded();
    h.imap.override('messageFlagsRemove', () => {
      throw imapError({ code: 'ECONNRESET' }, 'read ECONNRESET');
    });
    const { json } = await h.call('apple_mail_update_flags', { uids: [3], flagged: false });
    expect(json.error).toMatchObject({ code: 'UNCONFIRMED_WRITE', service: 'mail' });
    expect(json.error.hint).toMatch(/re-read it/);
  });

  it('a STORE whose connection dropped mid-command is unconfirmed — never "Nothing was changed"', async () => {
    // Real imapflow swallows the NoConnection into `false` (store.js); the fake does the same here.
    const h = seeded();
    h.imap.override('messageFlagsAdd', droppedMidCommand);
    const { json, isError } = await h.call('apple_mail_update_flags', { uids: [1], seen: true });
    expect(isError).toBe(true);
    expect(json.error).toMatchObject({
      code: 'UNCONFIRMED_WRITE',
      message: 'iCloud Mail: the connection failed during setting \\Seen; it may or may not have been applied.',
    });
    // Nothing tried to re-read on the dead connection and call the result a refusal.
    expect(h.imap.callsOf('fetchAll')).toHaveLength(1);

    const h2 = seeded();
    h2.imap.override('messageFlagsRemove', droppedMidCommand);
    const r2 = await h2.call('apple_mail_update_flags', { uids: [3], seen: true, flagged: false });
    expect(r2.json.error.code).toBe('UNCONFIRMED_WRITE');
    expect(r2.json.error.message).toMatch(/\(Already applied before this: setting \\Seen on uid 3\.\)$/);
  });

  it('refuses stale uids', async () => {
    const h = seeded();
    expect((await h.call('apple_mail_update_flags', { uids: [1], seen: true, uidValidity: 4 })).json.error.code).toBe('INVALID_ARGUMENT');
    expect(flagsOf(h, 1)).toEqual([]);
  });
});

describe('apple_mail_move', () => {
  it('on iCloud (no MOVE): copies, checks the copy, removes exactly those uids, verifies', async () => {
    const h = seeded();
    const { json, isError } = await h.call('apple_mail_move', { uids: [1, 3, 42], destination: 'trash' });
    expect(isError).toBe(false);
    expect(json).toEqual({
      from: 'INBOX',
      to: 'Deleted Messages',
      moved: 2,
      uidValidity: 1001,
      destinationUidValidity: 2003,
      notFound: [42],
      verified: true,
      moves: [
        { uid: 1, newUid: 1 },
        { uid: 3, newUid: 2 },
      ],
    });
    expect(h.imap.callsOf('messageCopy')).toEqual([['1,3', 'Deleted Messages', { uid: true }]]);
    expect(h.imap.callsOf('messageDelete')).toEqual([['1,3', { uid: true }]]);
    expect(h.imap.callsOf('messageMove')).toHaveLength(0);
    expect([...(h.imap.mailboxes.get('INBOX')?.messages.keys() ?? [])]).toEqual([2]);
    expect(h.imap.mailboxes.get('Deleted Messages')?.messages.get(2)?.flags.has('\\Flagged')).toBe(true);
  });

  it('uses MOVE when the server has it', async () => {
    const h = seeded();
    h.imap.capabilities.set('MOVE', true);
    h.imap.addMailbox('Work/Receipts');
    const { json } = await h.call('apple_mail_move', { mailbox: 'INBOX', uids: [2], destination: 'Work/Receipts', uidValidity: 1001 });
    expect(json).toMatchObject({ to: 'Work/Receipts', moved: 1, verified: true });
    expect(h.imap.callsOf('messageMove')).toHaveLength(1);
    expect(h.imap.callsOf('messageCopy')).toHaveLength(0);
  });

  it('never deletes when the copy failed (imapflow’s own fallback would)', async () => {
    const h = seeded();
    h.imap.override('messageCopy', () => false);
    const { json, isError } = await h.call('apple_mail_move', { uids: [1], destination: 'archive' });
    expect(isError).toBe(true);
    expect(json.error.message).toBe('iCloud Mail refused to copy the messages to "Archive". Nothing was moved.');
    expect(h.imap.callsOf('messageDelete')).toHaveLength(0);
    expect(h.imap.mailboxes.get('INBOX')?.messages.has(1)).toBe(true);
  });

  it('a refused MOVE moves nothing', async () => {
    const h = seeded();
    h.imap.capabilities.set('MOVE', true);
    h.imap.override('messageMove', () => false);
    const { json } = await h.call('apple_mail_move', { uids: [1], destination: 'archive' });
    expect(json.error.message).toMatch(/refused to move the messages to "Archive"\. Nothing was moved\./);
  });

  it('warns when the originals could not be removed after copying', async () => {
    const h = seeded();
    h.imap.override('messageDelete', () => false);
    const { json } = await h.call('apple_mail_move', { uids: [1], destination: 'junk' });
    expect(json.verified).toBe(false);
    expect(json.warnings).toEqual([
      'The messages were copied to "Junk" but could not be removed from "INBOX"; they are now in both (the originals may be marked deleted).',
      'Still listed in "INBOX" after the move: 1.',
    ]);
  });

  it('refuses without MOVE or UIDPLUS rather than expunging other deleted mail', async () => {
    const h = seeded();
    h.imap.capabilities.delete('UIDPLUS');
    const { json } = await h.call('apple_mail_move', { uids: [1], destination: 'trash' });
    expect(json.error).toMatchObject({ code: 'UNSUPPORTED' });
    expect(h.imap.callsOf('messageCopy')).toHaveLength(0);
  });

  it('checks the destination and the uids first', async () => {
    const h = seeded();
    expect((await h.call('apple_mail_move', { uids: [1], destination: 'Nowhere' })).json.error.code).toBe('NOT_FOUND');
    expect((await h.call('apple_mail_move', { uids: [1], destination: 'inbox' })).json.error).toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: 'The messages are already in "INBOX"; choose a different destination.',
    });
    expect((await h.call('apple_mail_move', { uids: [77], destination: 'trash' })).json.error.message).toBe('None of the uids 77 exist in "INBOX".');
    expect((await h.call('apple_mail_move', { uids: [1], destination: 'trash', uidValidity: 3 })).json.error.code).toBe('INVALID_ARGUMENT');
    expect(h.imap.callsOf('messageCopy')).toHaveLength(0);
  });

  it('reports when the move cannot be verified', async () => {
    const h = seeded();
    h.imap.override('search', () => false, 1);
    const a = await h.call('apple_mail_move', { uids: [1], destination: 'trash' });
    expect(a.json).toMatchObject({ verified: false, warnings: ['The move could not be verified: the follow-up search failed.'] });
    h.imap.override('search', () => {
      throw new Error('socket closed');
    }, 1);
    const b = await h.call('apple_mail_move', { uids: [2], destination: 'trash' });
    expect(b.json).toMatchObject({ verified: false, warnings: ['The move could not be verified: socket closed'] });
  });

  it('omits uid mappings the server did not report', async () => {
    const h = seeded();
    h.imap.override('messageCopy', () => ({ path: 'INBOX', destination: 'Archive' }));
    const { json } = await h.call('apple_mail_move', { uids: [1], destination: 'archive' });
    expect(json).not.toHaveProperty('destinationUidValidity');
    expect(json.moves).toEqual([{ uid: 1 }]);
  });

  it('a lost connection after the copy is unconfirmed AND says the copy landed', async () => {
    const h = seeded();
    h.imap.override('messageDelete', () => {
      throw imapError({ code: 'NoConnection' }, 'Connection not available');
    });
    const { json } = await h.call('apple_mail_move', { uids: [1], destination: 'trash' });
    expect(json.error).toMatchObject({ code: 'UNCONFIRMED_WRITE', service: 'mail' });
    expect(json.error.message).toBe(
      'The messages were copied to "Deleted Messages", but the connection failed while removing them from "INBOX" ' +
        '(iCloud Mail (imap.mail.me.com:993) connection failed during removing the originals: Connection not available.); ' +
        'they may now be in both mailboxes. Search both before retrying: a retry would copy them again.',
    );
    expect(h.imap.mailboxes.get('Deleted Messages')?.messages.size).toBe(1);
  });

  it('a COPY or MOVE whose connection dropped mid-command is unconfirmed, and nothing is removed', async () => {
    const h = seeded();
    h.imap.override('messageCopy', droppedMidCommand);
    const { json } = await h.call('apple_mail_move', { uids: [1], destination: 'archive' });
    expect(json.error).toMatchObject({
      code: 'UNCONFIRMED_WRITE',
      message: 'iCloud Mail: the connection failed during copying the messages; it may or may not have been applied.',
    });
    expect(json.error.message).not.toMatch(/Nothing was moved/);
    expect(h.imap.callsOf('messageDelete')).toHaveLength(0);

    const h2 = seeded();
    h2.imap.capabilities.set('MOVE', true);
    h2.imap.override('messageMove', droppedMidCommand);
    const r2 = await h2.call('apple_mail_move', { uids: [1], destination: 'archive' });
    expect(r2.json.error).toMatchObject({ code: 'UNCONFIRMED_WRITE' });
    expect(r2.json.error.message).toMatch(/during moving the messages/);
  });

  it('an EXPUNGE whose connection dropped after the copy says the copy landed, not "now in both"', async () => {
    const h = seeded();
    h.imap.override('messageDelete', droppedMidCommand);
    const { json } = await h.call('apple_mail_move', { uids: [1], destination: 'trash' });
    expect(json.error).toMatchObject({ code: 'UNCONFIRMED_WRITE', service: 'mail' });
    expect(json.error.message).toBe(
      'The messages were copied to "Deleted Messages", but the connection failed while removing them from "INBOX" ' +
        '(iCloud Mail (imap.mail.me.com:993) connection failed during removing the originals: Connection not available.); ' +
        'they may now be in both mailboxes. Search both before retrying: a retry would copy them again.',
    );
  });

  it('a lost connection during the copy itself is unconfirmed', async () => {
    const h = seeded();
    h.imap.override('messageCopy', () => {
      throw imapError({ code: 'ECONNRESET' }, 'read ECONNRESET');
    });
    const { json } = await h.call('apple_mail_move', { uids: [1], destination: 'trash' });
    expect(json.error).toMatchObject({ code: 'UNCONFIRMED_WRITE' });
    expect(h.imap.callsOf('messageDelete')).toHaveLength(0);
  });
});
