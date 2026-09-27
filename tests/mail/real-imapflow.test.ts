import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureTools, useMailEnv } from './harness.js';
import { startLoopbackImap, type LoopbackImap } from './loopback-imap.js';
import { rfc822 } from './fake-imap.js';

/**
 * The tools driven through the REAL imapflow client against a scripted loopback
 * server — what actually goes on the wire, not what the fake assumes.
 */

useMailEnv();

let srv: LoopbackImap | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

async function call(name: string, args: Record<string, unknown>): Promise<{ json: any; isError: boolean }> {
  srv ??= await startLoopbackImap();
  const tools = captureTools({ createImapClient: srv.factory });
  const r = await tools.get(name)?.cb(args, {});
  return { json: JSON.parse(r?.content[0]?.text as string), isError: r?.isError === true };
}

describe('real imapflow on the wire', () => {
  it('a refused name-part login falls back to the full address; searches EXAMINE and send valid WITHIN keys', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-27T12:00:00Z'), toFake: ['Date'] });
    srv = await startLoopbackImap();
    srv.acceptUsers = ['me@icloud.com'];
    srv.messages = [{ uid: 5, raw: rfc822({ subject: 'Hi' }) }];
    const { json, isError } = await call('apple_mail_search', { from: 'bob', since: '2026-09-27T07:00', before: '2026-12-31' });
    expect(isError).toBe(false);
    expect(json).toMatchObject({ total: 1, uidValidity: 77 });
    const cmds = srv.commands;
    // imapflow's real error for a tagged NO is recognised as a rejection, so the second form is tried.
    expect(cmds.filter((c) => c.startsWith('AUTH '))).toEqual(['AUTH me', 'AUTH me@icloud.com']);
    expect(cmds).toContain('EXAMINE INBOX');
    expect(cmds.some((c) => /^SELECT /.test(c))).toBe(false);
    // since 07:00 New York = 11:00Z, one hour before "now"; the future before is not sent (OLDER 0 is invalid).
    expect(cmds).toContain('UID SEARCH FROM bob YOUNGER 3600');
    expect(cmds.some((c) => /OLDER/.test(c))).toBe(false);
  });

  it('get_message reads with BODY.PEEK on an EXAMINEd mailbox, so the message stays unread', async () => {
    srv = await startLoopbackImap();
    srv.messages = [{ uid: 9, raw: rfc822({ subject: 'Quarterly', text: 'Numbers attached.' }) }];
    const { json, isError } = await call('apple_mail_get_message', { uid: 9 });
    expect(isError).toBe(false);
    expect(json).toMatchObject({ uid: 9, subject: 'Quarterly', seen: false, text: 'Numbers attached.' });
    expect(srv.commands).toContain('EXAMINE INBOX');
    const fetch = srv.commands.find((c) => c.startsWith('UID FETCH 9 ')) as string;
    expect(fetch).toMatch(/BODY\.PEEK\[\]<0\.26214400>/);
    expect(fetch).not.toMatch(/BODY\[/);
    expect(srv.commands.some((c) => /STORE/.test(c))).toBe(false);
  });

  it('both login forms refused → a latched credential rejection, and no third attempt', async () => {
    srv = await startLoopbackImap();
    srv.acceptUsers = [];
    const first = await call('apple_mail_list_mailboxes', { counts: false });
    expect(first.json.error).toMatchObject({ code: 'CREDENTIALS_REJECTED', service: 'mail' });
    const second = await call('apple_mail_list_mailboxes', { counts: false });
    expect(second.json.error.message).toMatch(/already rejected/);
    expect(srv.commands.filter((c) => c.startsWith('AUTH '))).toEqual(['AUTH me', 'AUTH me@icloud.com']);
  });
});
