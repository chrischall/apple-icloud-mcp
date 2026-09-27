import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import type { CreateImapClient, ImapClientLike } from '../../src/mail/imap.js';

/**
 * A tiny scripted IMAP server on loopback, for driving the REAL imapflow client
 * through the tools. The in-memory fake (fake-imap.ts) mirrors what we believe
 * imapflow does; this checks the belief: which commands actually go on the wire
 * (EXAMINE vs SELECT, BODY.PEEK, YOUNGER/OLDER), and what error a refused login
 * really produces.
 */

export interface LoopbackMessage {
  uid: number;
  raw: string;
  flags?: string[];
}

export interface LoopbackImap {
  port: number;
  /** Every command line the client sent (SASL payloads decoded to `AUTH <user>`). */
  commands: string[];
  /** Logins the server accepts (any password). */
  acceptUsers: string[];
  messages: LoopbackMessage[];
  /**
   * A command (untagged line) that the server RECEIVES — it counts as applied — after which
   * the connection dies before the tagged answer: a socket timeout or reset mid-write.
   */
  dropOn?: RegExp;
  /** A command the server answers with a tagged NO. */
  refuseOn?: RegExp;
  /** A client factory: the tools' own options, pointed at this server in cleartext. */
  factory: CreateImapClient;
  close(): Promise<void>;
}

const CAPS = 'IMAP4rev1 SASL-IR AUTH=PLAIN';
const POST_AUTH_CAPS = 'IMAP4rev1 UIDPLUS WITHIN IDLE ID';

function saslUser(b64: string): string {
  const parts = Buffer.from(b64, 'base64').toString('utf8').split('\u0000');
  return parts[1] ?? '';
}

export async function startLoopbackImap(): Promise<LoopbackImap> {
  const state: Omit<LoopbackImap, 'port' | 'factory' | 'close'> = { commands: [], acceptUsers: ['me'], messages: [] };
  const sockets = new Set<Socket>();
  const server: Server = createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => undefined);
    sock.write(`* OK [CAPABILITY ${CAPS}] loopback ready\r\n`);
    let buf = '';
    let pendingAuth: string | undefined;
    const answerAuth = (tag: string, b64: string): void => {
      const user = saslUser(b64);
      state.commands.push(`AUTH ${user}`);
      if (state.acceptUsers.includes(user)) sock.write(`${tag} OK [CAPABILITY ${POST_AUTH_CAPS}] signed in\r\n`);
      else sock.write(`${tag} NO [AUTHENTICATIONFAILED] Authentication failed\r\n`);
    };
    sock.on('data', (chunk: Buffer) => {
      buf += chunk.toString('latin1');
      let idx: number;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (pendingAuth !== undefined) {
          const tag = pendingAuth;
          pendingAuth = undefined;
          answerAuth(tag, line);
          continue;
        }
        const [tag = '*', cmd = '', ...rest] = line.split(' ');
        const verb = cmd.toUpperCase();
        if (verb === 'AUTHENTICATE') {
          if (rest[1]) answerAuth(tag, rest[1]);
          else {
            pendingAuth = tag;
            sock.write('+ \r\n');
          }
          continue;
        }
        const command = `${cmd} ${rest.join(' ')}`.trim();
        state.commands.push(command);
        if (state.dropOn?.test(command)) {
          sock.destroy();
          return;
        }
        if (state.refuseOn?.test(command)) sock.write(`${tag} NO [TRYCREATE] Mailbox does not exist\r\n`);
        else if (verb === 'CAPABILITY') sock.write(`* CAPABILITY ${POST_AUTH_CAPS}\r\n${tag} OK done\r\n`);
        else if (verb === 'ID') sock.write(`* ID NIL\r\n${tag} OK done\r\n`);
        else if (verb === 'NAMESPACE') sock.write(`* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK done\r\n`);
        else if (verb === 'LIST' && rest.join(' ') === '"" ""') sock.write(`* LIST (\\Noselect) "/" ""\r\n${tag} OK done\r\n`);
        else if (verb === 'LIST') sock.write(`* LIST () "/" "INBOX"\r\n* LIST () "/" "Sent Messages"\r\n${tag} OK done\r\n`);
        else if (verb === 'EXAMINE' || verb === 'SELECT') {
          sock.write(
            `* ${state.messages.length} EXISTS\r\n* OK [UIDVALIDITY 77] v\r\n* OK [UIDNEXT 100] n\r\n` +
              `${tag} OK [${verb === 'EXAMINE' ? 'READ-ONLY' : 'READ-WRITE'}] opened\r\n`,
          );
        } else if (verb === 'UID' && rest[0]?.toUpperCase() === 'SEARCH') {
          sock.write(`* SEARCH ${state.messages.map((m) => m.uid).join(' ')}\r\n${tag} OK done\r\n`);
        } else if (verb === 'UID' && rest[0]?.toUpperCase() === 'FETCH') {
          const wanted = new Set((rest[1] ?? '').split(',').map(Number));
          let out = '';
          state.messages.forEach((m, i) => {
            if (!wanted.has(m.uid)) return;
            const body = Buffer.from(m.raw, 'utf8');
            out +=
              `* ${i + 1} FETCH (UID ${m.uid} FLAGS (${(m.flags ?? []).join(' ')}) RFC822.SIZE ${body.length} ` +
              `INTERNALDATE "21-Sep-2026 14:31:00 +0000" BODY[] {${body.length}}\r\n${m.raw})\r\n`;
          });
          sock.write(`${out}${tag} OK done\r\n`);
        } else if (verb === 'LOGOUT') {
          sock.write(`* BYE bye\r\n${tag} OK done\r\n`);
          sock.end();
        } else sock.write(`${tag} OK done\r\n`);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return Object.assign(state, {
    port,
    factory: (options: ImapFlowOptions): ImapClientLike =>
      new ImapFlow({ ...options, host: '127.0.0.1', port, secure: false }) as unknown as ImapClientLike,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  });
}
