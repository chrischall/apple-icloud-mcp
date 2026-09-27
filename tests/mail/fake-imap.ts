import type {
  AppendResponseObject,
  CopyResponseObject,
  FetchMessageObject,
  FetchQueryObject,
  ImapFlowOptions,
  ListResponse,
  MailboxLockObject,
  MailboxObject,
  MessageStructureObject,
  SearchObject,
  StatusObject,
  StatusQuery,
} from 'imapflow';
import type { ImapClientLike } from '../../src/mail/imap.js';

/**
 * An in-memory IMAP server + client that behaves like the slice of imapflow
 * the mail module uses — including imapflow's habit of swallowing a server
 * refusal into `false` for COPY/STORE/EXPUNGE/SEARCH.
 */

/**
 * What real imapflow does when the connection dies with a COPY/MOVE/STORE/EXPUNGE in
 * flight: close() rejects the command with NoConnection, the command's own catch logs it
 * through the client's logger and returns `false` — it never throws. Use as an override body.
 */
export function droppedMidCommand(this: FakeImapClient): false {
  this.usable = false;
  (this.options.logger as { warn: (o: unknown) => void }).warn({
    err: Object.assign(new Error('Connection not available'), { code: 'NoConnection', rejectedFrom: 'pendingRequest' }),
  });
  return false;
}

export interface FakeMessage {
  uid: number;
  source: Buffer;
  flags: Set<string>;
  internalDate: Date;
  envelope: {
    date?: Date | string;
    subject?: string;
    messageId?: string;
    from?: Array<{ name?: string; address?: string }>;
    replyTo?: Array<{ name?: string; address?: string }>;
    to?: Array<{ name?: string; address?: string }>;
    cc?: Array<{ name?: string; address?: string }>;
  };
  bodyStructure?: MessageStructureObject;
  /** Lowercased text the fake SEARCH matches FROM/TO/SUBJECT/TEXT against. */
  haystack: { from: string; to: string; subject: string; text: string };
}

export interface FakeMailbox {
  path: string;
  specialUse?: string;
  flags: Set<string>;
  uidValidity: number;
  uidNext: number;
  messages: Map<number, FakeMessage>;
}

export interface MessageSpec {
  from?: string;
  fromName?: string;
  /** A Reply-To header (addresses as written). */
  replyTo?: string[];
  to?: string[];
  cc?: string[];
  subject?: string;
  date?: string;
  messageId?: string;
  references?: string;
  text?: string;
  html?: string;
  attachment?: { filename: string; type: string; content: string };
  flags?: string[];
  internalDate?: Date;
  /** Raw source override. */
  raw?: string;
  bodyStructure?: MessageStructureObject;
}

export function rfc822(spec: MessageSpec): string {
  const lines: string[] = [];
  const from = spec.from ?? 'alice@example.com';
  lines.push(`From: ${spec.fromName ? `"${spec.fromName}" <${from}>` : from}`);
  if (spec.replyTo?.length) lines.push(`Reply-To: ${spec.replyTo.join(', ')}`);
  lines.push(`To: ${(spec.to ?? ['me@icloud.com']).join(', ')}`);
  if (spec.cc?.length) lines.push(`Cc: ${spec.cc.join(', ')}`);
  lines.push(`Subject: ${spec.subject ?? 'Hello'}`);
  lines.push(`Date: ${spec.date ?? 'Mon, 21 Sep 2026 14:30:00 +0000'}`);
  if (spec.messageId !== '') lines.push(`Message-ID: ${spec.messageId ?? '<orig-1@example.com>'}`);
  if (spec.references) lines.push(`References: ${spec.references}`);
  lines.push('MIME-Version: 1.0');
  const text = spec.text ?? (spec.html === undefined ? 'Hi there.\r\nSecond line.' : undefined);
  if (spec.attachment || (text !== undefined && spec.html !== undefined)) {
    const b = 'BOUNDARY42';
    lines.push(`Content-Type: multipart/${spec.attachment ? 'mixed' : 'alternative'}; boundary="${b}"`, '');
    if (text !== undefined) lines.push(`--${b}`, 'Content-Type: text/plain; charset=utf-8', '', text);
    if (spec.html !== undefined) lines.push(`--${b}`, 'Content-Type: text/html; charset=utf-8', '', spec.html);
    if (spec.attachment) {
      lines.push(
        `--${b}`,
        `Content-Type: ${spec.attachment.type}; name="${spec.attachment.filename}"`,
        `Content-Disposition: attachment; filename="${spec.attachment.filename}"`,
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(spec.attachment.content).toString('base64'),
      );
    }
    lines.push(`--${b}--`, '');
  } else if (spec.html !== undefined) {
    lines.push('Content-Type: text/html; charset=utf-8', '', spec.html);
  } else {
    lines.push('Content-Type: text/plain; charset=utf-8', '', text as string);
  }
  return lines.join('\r\n');
}

type Impl = (...args: any[]) => unknown;

export class FakeMailServer {
  mailboxes = new Map<string, FakeMailbox>();
  capabilities = new Map<string, boolean | number>([
    ['IMAP4rev1', true],
    ['UIDPLUS', true],
    ['WITHIN', true],
  ]);
  /** Login users the server accepts (the fake password is not checked). */
  acceptUsers: string[] = ['me'];
  /** Thrown by connect() for every user when set. */
  connectError: Error | undefined;
  /** Options of every client created, in order. */
  created: ImapFlowOptions[] = [];
  clients: FakeImapClient[] = [];
  private overrides = new Map<string, Array<{ impl: Impl; times: number }>>();
  calls: Array<{ method: string; args: unknown[] }> = [];

  constructor() {
    this.addMailbox('INBOX', { specialUse: '\\Inbox', uidValidity: 1001 });
    this.addMailbox('Drafts', { specialUse: '\\Drafts' });
    this.addMailbox('Sent Messages', { specialUse: '\\Sent' });
    this.addMailbox('Deleted Messages', { specialUse: '\\Trash' });
    this.addMailbox('Junk', { specialUse: '\\Junk' });
    this.addMailbox('Archive', { specialUse: '\\Archive' });
  }

  factory = (options: ImapFlowOptions): ImapClientLike => {
    this.created.push(options);
    const c = new FakeImapClient(this, options);
    this.clients.push(c);
    return c;
  };

  addMailbox(path: string, opts: { specialUse?: string; uidValidity?: number; flags?: string[] } = {}): FakeMailbox {
    const box: FakeMailbox = {
      path,
      ...(opts.specialUse ? { specialUse: opts.specialUse } : {}),
      flags: new Set(opts.flags ?? []),
      uidValidity: opts.uidValidity ?? 2000 + this.mailboxes.size,
      uidNext: 1,
      messages: new Map(),
    };
    this.mailboxes.set(path, box);
    return box;
  }

  addMessage(path: string, spec: MessageSpec = {}, uid?: number): FakeMessage {
    const box = this.mailboxes.get(path);
    if (!box) throw new Error(`no mailbox ${path}`);
    const id = uid ?? box.uidNext;
    box.uidNext = Math.max(box.uidNext, id + 1);
    const from = spec.from ?? 'alice@example.com';
    const raw = spec.raw ?? rfc822(spec);
    const msg: FakeMessage = {
      uid: id,
      source: Buffer.from(raw),
      flags: new Set(spec.flags ?? []),
      internalDate: spec.internalDate ?? new Date('2026-09-21T14:31:00Z'),
      envelope: {
        date: spec.date ?? 'Mon, 21 Sep 2026 14:30:00 +0000',
        subject: spec.subject ?? 'Hello',
        ...(spec.messageId !== '' ? { messageId: spec.messageId ?? '<orig-1@example.com>' } : {}),
        from: [{ ...(spec.fromName ? { name: spec.fromName } : {}), address: from }],
        // RFC 3501: with no Reply-To header, the ENVELOPE's reply-to is a copy of From.
        replyTo: spec.replyTo?.length
          ? spec.replyTo.map((address) => ({ address }))
          : [{ ...(spec.fromName ? { name: spec.fromName } : {}), address: from }],
        to: (spec.to ?? ['me@icloud.com']).map((address) => ({ address })),
        ...(spec.cc ? { cc: spec.cc.map((address) => ({ address })) } : {}),
      },
      ...(spec.bodyStructure ? { bodyStructure: spec.bodyStructure } : {}),
      haystack: {
        from: `${spec.fromName ?? ''} ${from}`.toLowerCase(),
        to: (spec.to ?? ['me@icloud.com']).join(' ').toLowerCase(),
        subject: (spec.subject ?? 'Hello').toLowerCase(),
        text: raw.toLowerCase(),
      },
    };
    box.messages.set(id, msg);
    return msg;
  }

  /** Replace a client method's behaviour (`times` calls, default forever). */
  override(method: string, impl: Impl, times = Infinity): void {
    const list = this.overrides.get(method) ?? [];
    list.push({ impl, times });
    this.overrides.set(method, list);
  }

  /** @internal */
  takeOverride(method: string): Impl | undefined {
    const list = this.overrides.get(method);
    const first = list?.[0];
    if (!first) return undefined;
    first.times--;
    if (first.times <= 0) list?.shift();
    return first.impl;
  }

  callsOf(method: string): unknown[][] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }
}

export const PASS = Symbol('pass');

function imapError(fields: Record<string, unknown>, message = 'Command failed'): Error {
  return Object.assign(new Error(message), fields);
}

function parseRange(range: string): number[] {
  return String(range)
    .split(',')
    .map((n) => Number(n));
}

export class FakeImapClient implements ImapClientLike {
  capabilities: Map<string, boolean | number>;
  mailbox: MailboxObject | false = false;
  readOnly = true;
  loggedOut = false;
  closed = false;
  /** imapflow's `usable`: false once the connection has closed. */
  usable = true;
  errorListeners: Array<(err: Error) => void> = [];

  constructor(
    private server: FakeMailServer,
    readonly options: ImapFlowOptions,
  ) {
    this.capabilities = server.capabilities;
  }

  private hook(method: string, args: unknown[]): unknown {
    this.server.calls.push({ method, args });
    const impl = this.server.takeOverride(method);
    if (impl) return impl.call(this, ...args);
    return PASS;
  }

  private box(): FakeMailbox {
    const box = this.mailbox ? this.server.mailboxes.get(this.mailbox.path) : undefined;
    if (!box) throw new Error('no mailbox selected');
    return box;
  }

  on(event: 'error', listener: (err: Error) => void): this {
    if (event === 'error') this.errorListeners.push(listener);
    return this;
  }

  async connect(): Promise<void> {
    const o = this.hook('connect', []);
    if (o !== PASS) return (await o) as void;
    if (this.server.connectError) throw this.server.connectError;
    const user = this.options.auth?.user as string;
    if (!this.server.acceptUsers.includes(user)) {
      throw imapError({ authenticationFailed: true, responseStatus: 'NO', serverResponseCode: 'AUTHENTICATIONFAILED' }, 'Command failed');
    }
  }

  async logout(): Promise<void> {
    const o = this.hook('logout', []);
    if (o !== PASS) return (await o) as void;
    this.loggedOut = true;
  }

  close(): void {
    this.hook('close', []);
    this.closed = true;
    this.usable = false;
  }

  async list(): Promise<ListResponse[]> {
    const o = this.hook('list', []);
    if (o !== PASS) return (await o) as ListResponse[];
    return [...this.server.mailboxes.values()].map((b) => {
      const parts = b.path.split('/');
      return {
        path: b.path,
        pathAsListed: b.path,
        name: parts[parts.length - 1] as string,
        delimiter: '/',
        parent: parts.slice(0, -1),
        parentPath: parts.slice(0, -1).join('/'),
        flags: new Set(b.flags),
        ...(b.specialUse ? { specialUse: b.specialUse } : {}),
        listed: true,
        subscribed: true,
      };
    });
  }

  async status(path: string, query: StatusQuery): Promise<StatusObject | false> {
    const o = this.hook('status', [path, query]);
    if (o !== PASS) return (await o) as StatusObject | false;
    const box = this.server.mailboxes.get(path);
    if (!box) throw imapError({ code: 'NotFound' }, `Mailbox doesn't exist: ${path}`);
    const all = [...box.messages.values()];
    return { path, messages: all.length, unseen: all.filter((m) => !m.flags.has('\\Seen')).length };
  }

  async getMailboxLock(path: string, options: { readOnly?: boolean } = {}): Promise<MailboxLockObject> {
    const o = this.hook('getMailboxLock', [path, options]);
    if (o !== PASS) return (await o) as MailboxLockObject;
    const box = this.server.mailboxes.get(path);
    if (!box) throw imapError({ responseStatus: 'NO', responseText: 'Mailbox does not exist', mailboxMissing: true });
    this.readOnly = !!options.readOnly;
    this.mailbox = {
      path,
      delimiter: '/',
      flags: new Set(),
      uidValidity: BigInt(box.uidValidity),
      uidNext: box.uidNext,
      exists: box.messages.size,
      readOnly: this.readOnly,
    };
    const released = { value: false };
    return {
      path,
      release: () => {
        released.value = true;
        this.server.calls.push({ method: 'release', args: [path] });
      },
    };
  }

  async search(query: SearchObject, options?: { uid?: boolean }): Promise<number[] | false | undefined> {
    const o = this.hook('search', [query, options]);
    if (o !== PASS) return (await o) as number[] | false | undefined;
    const box = this.box();
    const wantUids = query.uid !== undefined ? new Set(parseRange(String(query.uid))) : undefined;
    const has = (hay: string, needle: string | undefined): boolean => needle === undefined || hay.includes(needle.toLowerCase());
    return [...box.messages.values()]
      .filter((m) => {
        if (wantUids && !wantUids.has(m.uid)) return false;
        if (query.seen !== undefined && m.flags.has('\\Seen') !== query.seen) return false;
        if (query.flagged !== undefined && m.flags.has('\\Flagged') !== query.flagged) return false;
        if (!has(m.haystack.from, query.from)) return false;
        if (!has(m.haystack.to, query.to)) return false;
        if (!has(m.haystack.subject, query.subject)) return false;
        if (!has(m.haystack.text, query.text)) return false;
        if (query.since instanceof Date && m.internalDate < query.since) return false;
        if (query.before instanceof Date && m.internalDate >= query.before) return false;
        return true;
      })
      .map((m) => m.uid)
      .sort((a, b) => a - b);
  }

  private project(m: FakeMessage, query: FetchQueryObject): FetchMessageObject {
    const out: FetchMessageObject = { seq: m.uid, uid: m.uid };
    if (query.flags) out.flags = new Set(m.flags);
    if (query.envelope) out.envelope = { ...m.envelope };
    if (query.internalDate) out.internalDate = m.internalDate;
    if (query.size) out.size = m.source.length;
    if (query.bodyStructure) out.bodyStructure = m.bodyStructure ?? { type: 'text/plain', part: '1' };
    if (query.source) {
      const max = typeof query.source === 'object' ? query.source.maxLength : undefined;
      out.source = max !== undefined ? m.source.subarray(0, max) : m.source;
    }
    if (query.headers) {
      const text = m.source.toString();
      const end = text.indexOf('\r\n\r\n');
      out.headers = Buffer.from(end === -1 ? text : text.slice(0, end + 4));
    }
    return out;
  }

  async fetchAll(range: string, query: FetchQueryObject, options?: { uid?: boolean }): Promise<FetchMessageObject[]> {
    const o = this.hook('fetchAll', [range, query, options]);
    if (o !== PASS) return (await o) as FetchMessageObject[];
    const box = this.box();
    return parseRange(range)
      .map((u) => box.messages.get(u))
      .filter((m): m is FakeMessage => !!m)
      .map((m) => this.project(m, query));
  }

  async fetchOne(seq: string, query: FetchQueryObject, options?: { uid?: boolean }): Promise<FetchMessageObject | false | undefined> {
    const o = this.hook('fetchOne', [seq, query, options]);
    if (o !== PASS) return (await o) as FetchMessageObject | false | undefined;
    const m = this.box().messages.get(Number(seq));
    return m ? this.project(m, query) : false;
  }

  private store(range: string, flags: string[], add: boolean): boolean {
    if (this.readOnly) return false; // imapflow drops flags a read-only mailbox cannot take
    const box = this.box();
    for (const u of parseRange(range)) {
      const m = box.messages.get(u);
      if (!m) continue;
      for (const f of flags) {
        if (add) m.flags.add(f);
        else m.flags.delete(f);
      }
    }
    return true;
  }

  async messageFlagsAdd(range: string, flags: string[], options?: { uid?: boolean }): Promise<boolean> {
    const o = this.hook('messageFlagsAdd', [range, flags, options]);
    if (o !== PASS) return (await o) as boolean;
    return this.store(range, flags, true);
  }

  async messageFlagsRemove(range: string, flags: string[], options?: { uid?: boolean }): Promise<boolean> {
    const o = this.hook('messageFlagsRemove', [range, flags, options]);
    if (o !== PASS) return (await o) as boolean;
    return this.store(range, flags, false);
  }

  private copyTo(range: string, destination: string, remove: boolean): CopyResponseObject | false {
    const src = this.box();
    const dest = this.server.mailboxes.get(destination);
    if (!dest) return false;
    const uidMap = new Map<number, number>();
    for (const u of parseRange(range)) {
      const m = src.messages.get(u);
      if (!m) continue;
      const newUid = dest.uidNext++;
      dest.messages.set(newUid, { ...m, uid: newUid, flags: new Set(m.flags) });
      uidMap.set(u, newUid);
      if (remove) src.messages.delete(u);
    }
    return { path: src.path, destination, uidValidity: BigInt(dest.uidValidity), uidMap };
  }

  async messageCopy(range: string, destination: string, options?: { uid?: boolean }): Promise<CopyResponseObject | false> {
    const o = this.hook('messageCopy', [range, destination, options]);
    if (o !== PASS) return (await o) as CopyResponseObject | false;
    return this.copyTo(range, destination, false);
  }

  async messageMove(range: string, destination: string, options?: { uid?: boolean }): Promise<CopyResponseObject | false> {
    const o = this.hook('messageMove', [range, destination, options]);
    if (o !== PASS) return (await o) as CopyResponseObject | false;
    return this.copyTo(range, destination, true);
  }

  async messageDelete(range: string, options?: { uid?: boolean }): Promise<boolean> {
    const o = this.hook('messageDelete', [range, options]);
    if (o !== PASS) return (await o) as boolean;
    const box = this.box();
    for (const u of parseRange(range)) box.messages.delete(u);
    return true;
  }

  async append(path: string, content: Buffer, flags?: string[], idate?: Date): Promise<AppendResponseObject | false> {
    const o = this.hook('append', [path, content, flags, idate]);
    if (o !== PASS) return (await o) as AppendResponseObject | false;
    const box = this.server.mailboxes.get(path);
    if (!box) throw imapError({ responseStatus: 'NO', responseText: 'no such mailbox [TRYCREATE]' });
    const msg = this.server.addMessage(path, { raw: content.toString(), flags: flags ?? [], internalDate: idate ?? new Date() });
    return { destination: path, uid: msg.uid, uidValidity: BigInt(box.uidValidity) };
  }
}

export { imapError };
