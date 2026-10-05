import { EventEmitter } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { Socket as NetSocket, createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { PassThrough, type Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withCallSignal } from '@chrischall/mcp-utils';
import type { SMTPConnectionOptions } from 'nodemailer/lib/smtp-connection';
import { resolveMailAccount } from '../../src/mail/config.js';
import {
  DataPhaseProbe,
  SmtpPhaseError,
  classifySmtpError,
  createSmtpTransport,
  defaultSmtpSeams,
  openHttpTunnel,
  type SmtpConnectionLike,
  type SmtpSeams,
  type SmtpTransportOptions,
} from '../../src/mail/smtp.js';
import { AppleToolError, CredentialsRejectedError, TransportError, UnconfirmedWriteError } from '../../src/errors.js';
import { assertNotLatched } from '../../src/icloud-auth.js';

beforeEach(() => {
  process.env.ICLOUD_USERNAME = 'me@icloud.com';
  process.env.ICLOUD_APP_PASSWORD = 'abcd-efgh-ijkl-mnop';
});

const OPTS: SmtpTransportOptions = {
  host: 'smtp.mail.me.com',
  port: 587,
  secure: false,
  requireTLS: true,
  user: 'me@icloud.com',
  pass: 'abcd-efgh-ijkl-mnop',
  timeoutMs: 30_000,
};

const MSG = { from: 'me@icloud.com', to: ['bob@example.com'], raw: Buffer.from('Subject: hi\r\n\r\nbody\r\n') };

describe('DataPhaseProbe', () => {
  it('reports when it starts being piped and yields its payload once', async () => {
    let started = 0;
    const probe = new DataPhaseProbe(Buffer.from('abc'), () => started++);
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise((r) => sink.on('end', r));
    expect(probe.pipe(sink)).toBe(sink);
    await done;
    expect(started).toBe(1);
    expect(Buffer.concat(chunks).toString()).toBe('abc');
  });
});

// ---------------------------------------------------------------------------
// A scripted fake connection
// ---------------------------------------------------------------------------

type Script = {
  connect?: (c: FakeConn) => void;
  login?: (c: FakeConn, cb: (err: Error | null) => void) => void;
  send?: (c: FakeConn, msg: Readable, cb: (err: Error | null, info?: { accepted: string[]; rejected: string[]; response?: string }) => void) => void;
};

class FakeConn extends EventEmitter implements SmtpConnectionLike {
  quitCalled = 0;
  closeCalled = 0;
  constructor(
    readonly options: SMTPConnectionOptions,
    private script: Script,
  ) {
    super();
  }
  connect(callback: (err?: Error) => void): void {
    this.connectCb = callback;
    if (this.script.connect) this.script.connect(this);
    else setImmediate(callback);
  }
  connectCb: ((err?: Error) => void) | undefined;
  loginCalled = 0;
  login(_auth: unknown, callback: (err: Error | null) => void): void {
    this.loginCalled++;
    if (this.script.login) this.script.login(this, callback);
    else setImmediate(() => callback(null));
  }
  send(_env: unknown, message: Readable, callback: (err: Error | null, info?: never) => void): void {
    if (this.script.send) this.script.send(this, message, callback as never);
    else {
      const sink = new PassThrough();
      sink.resume();
      message.pipe(sink);
      sink.on('end', () => callback(null, { accepted: ['bob@example.com'], rejected: [], response: '250 OK' } as never));
    }
  }
  quit(): void {
    this.quitCalled++;
  }
  close(): void {
    this.closeCalled++;
  }
}

function seams(script: Script = {}, tunnel?: SmtpSeams['openTunnel']): { seams: SmtpSeams; conns: FakeConn[]; tunnels: unknown[][] } {
  const conns: FakeConn[] = [];
  const tunnels: unknown[][] = [];
  return {
    conns,
    tunnels,
    seams: {
      createConnection: (options) => {
        const c = new FakeConn(options, script);
        conns.push(c);
        return c;
      },
      openTunnel:
        tunnel ??
        (async (...args) => {
          tunnels.push(args);
          return { fake: 'socket' } as unknown as Socket;
        }),
    },
  };
}

async function phaseOf(p: Promise<unknown>): Promise<SmtpPhaseError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(SmtpPhaseError);
    return err as SmtpPhaseError;
  }
  throw new Error('expected a failure');
}

describe('createSmtpTransport (scripted connection)', () => {
  it('connects with STARTTLS required, no logger, bounded timeouts, then QUITs', async () => {
    const s = seams();
    const res = await createSmtpTransport(OPTS, s.seams).submit(MSG);
    expect(res).toEqual({ accepted: ['bob@example.com'], rejected: [], response: '250 OK' });
    const c = s.conns[0] as FakeConn;
    expect(c.options).toEqual({
      host: 'smtp.mail.me.com',
      port: 587,
      secure: false,
      requireTLS: true,
      connectionTimeout: 30_000,
      greetingTimeout: 30_000,
      socketTimeout: 30_000,
      logger: false,
      debug: false,
    });
    expect(c.quitCalled).toBe(1);
    expect(c.closeCalled).toBe(0);
    // Late events after success are ignored (and heard, so they cannot crash the process).
    c.emit('error', new Error('late'));
    c.emit('end');
  });

  it('omits a missing final response and passes ignoreTLS through', async () => {
    const s = seams({
      send: (_c, msg, cb) => {
        msg.pipe(new PassThrough()).resume();
        cb(null, { accepted: ['a@x.com'], rejected: ['b@x.com'] });
      },
    });
    const res = await createSmtpTransport({ ...OPTS, ignoreTLS: true }, s.seams).submit(MSG);
    expect(res).toEqual({ accepted: ['a@x.com'], rejected: ['b@x.com'] });
    expect(s.conns[0]?.options.ignoreTLS).toBe(true);
  });

  it('tunnels through the proxy and hands the socket to the connection', async () => {
    const s = seams();
    await createSmtpTransport({ ...OPTS, proxy: 'http://127.0.0.1:3128' }, s.seams).submit(MSG);
    expect(s.tunnels).toEqual([['http://127.0.0.1:3128', 587, 'smtp.mail.me.com', 30_000]]);
    expect(s.conns[0]?.options.connection).toEqual({ fake: 'socket' });
  });

  it('a tunnel failure is a connect-phase failure', async () => {
    const withCode = seams({}, async () => Promise.reject(Object.assign(new Error('Invalid response from proxy: 403'), { code: 'EPROXY' })));
    const e1 = await phaseOf(createSmtpTransport({ ...OPTS, proxy: 'http://p:1' }, withCode.seams).submit(MSG));
    expect(e1).toMatchObject({ phase: 'connect', code: 'EPROXY', message: 'Invalid response from proxy: 403' });
    const noCode = seams({}, async () => Promise.reject(new Error('refused')));
    expect(await phaseOf(createSmtpTransport({ ...OPTS, proxy: 'http://p:1' }, noCode.seams).submit(MSG))).toMatchObject({ code: 'EPROXY' });
    const notError = seams({}, async () => Promise.reject('string failure'));
    expect(await phaseOf(createSmtpTransport({ ...OPTS, proxy: 'http://p:1' }, notError.seams).submit(MSG))).toMatchObject({
      message: 'string failure',
    });
    expect(withCode.conns).toHaveLength(0);
  });

  it('tags each failure with its phase', async () => {
    const connectErr = seams({ connect: (c) => setImmediate(() => c.emit('error', Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' }))) });
    expect(await phaseOf(createSmtpTransport(OPTS, connectErr.seams).submit(MSG))).toMatchObject({ phase: 'connect', code: 'ETIMEDOUT' });
    expect(connectErr.conns[0]?.closeCalled).toBe(1);

    const authErr = seams({
      login: (_c, cb) => setImmediate(() => cb(Object.assign(new Error('Invalid login'), { code: 'EAUTH', responseCode: 535, response: '535 5.7.8 Auth failed' }))),
    });
    expect(await phaseOf(createSmtpTransport(OPTS, authErr.seams).submit(MSG))).toMatchObject({
      phase: 'auth',
      code: 'EAUTH',
      responseCode: 535,
      response: '535 5.7.8 Auth failed',
    });

    const envErr = seams({
      send: (_c, msg, cb) => {
        msg.pipe(new PassThrough()).resume(); // nodemailer drains the body on an envelope error too
        cb(Object.assign(new Error("Can't send mail - all recipients were rejected"), { code: 'EENVELOPE', rejected: ['x@y.z'] }));
      },
    });
    expect(await phaseOf(createSmtpTransport(OPTS, envErr.seams).submit(MSG))).toMatchObject({ code: 'EENVELOPE', rejected: ['x@y.z'] });

    const beforeData = seams({ send: (c) => setImmediate(() => c.emit('error', Object.assign(new Error('reset'), { code: 'ECONNECTION' }))) });
    expect(await phaseOf(createSmtpTransport(OPTS, beforeData.seams).submit(MSG))).toMatchObject({ phase: 'envelope', code: 'ECONNECTION' });

    const inData = seams({
      send: (c, msg) => {
        msg.pipe(new PassThrough()).resume();
        setImmediate(() => c.emit('error', Object.assign(new Error('Connection closed unexpectedly'), { code: 'ECONNECTION' })));
      },
    });
    expect(await phaseOf(createSmtpTransport(OPTS, inData.seams).submit(MSG))).toMatchObject({ phase: 'data', code: 'ECONNECTION' });
  });

  it('treats a close without an error event as a failure', async () => {
    const s = seams({ connect: (c) => setImmediate(() => c.emit('end')) });
    expect(await phaseOf(createSmtpTransport(OPTS, s.seams).submit(MSG))).toMatchObject({ phase: 'connect', code: 'ECONNECTION' });
  });

  it('a close before the greeting, handed to the connect callback, fails in phase connect without logging in', async () => {
    // nodemailer ≥10.0.12 reports a silent pre-greeting close through connect(cb) instead of 'error'.
    const s = seams({ connect: (c) => setImmediate(() => c.connectCb?.(Object.assign(new Error('Connection closed unexpectedly'), { code: 'ECONNECTION' }))) });
    expect(await phaseOf(createSmtpTransport(OPTS, s.seams).submit(MSG))).toMatchObject({ phase: 'connect', code: 'ECONNECTION' });
    expect(s.conns[0].loginCalled).toBe(0);
  });

  it('ignores callbacks that arrive after the outcome is settled', async () => {
    const s = seams({
      connect: (c) =>
        setImmediate(() => {
          c.emit('error', new Error('first'));
          c.connectCb?.();
        }),
    });
    expect(await phaseOf(createSmtpTransport(OPTS, s.seams).submit(MSG))).toMatchObject({ message: 'first', phase: 'connect' });
    const s2 = seams({
      login: (c, cb) =>
        setImmediate(() => {
          c.emit('error', new Error('dropped'));
          cb(null);
        }),
    });
    expect(await phaseOf(createSmtpTransport(OPTS, s2.seams).submit(MSG))).toMatchObject({ message: 'dropped', phase: 'auth' });
  });

  it('a cancelled call closes the connection', async () => {
    const ac = new AbortController();
    const s = seams({ send: () => ac.abort() });
    const e = await phaseOf(withCallSignal(ac.signal, () => createSmtpTransport(OPTS, s.seams).submit(MSG)));
    expect(e).toMatchObject({ code: 'ECANCELLED', phase: 'envelope' });
    expect(s.conns[0]?.closeCalled).toBe(1);
  });

  it('SmtpPhaseError keeps only well-typed facts', () => {
    const e = new SmtpPhaseError('data', { responseCode: '250' as unknown as number, response: 7 as unknown as string, rejected: 'x' as unknown as string[] });
    expect(e.message).toBe('SMTP failure');
    expect(e.responseCode).toBeUndefined();
    expect(e.response).toBeUndefined();
    expect(e.rejected).toBeUndefined();
    expect(e.code).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe('classifySmtpError', () => {
  const account = (): ReturnType<typeof resolveMailAccount> => resolveMailAccount();
  const err = (phase: 'connect' | 'auth' | 'envelope' | 'data', f: Record<string, unknown>): SmtpPhaseError =>
    new SmtpPhaseError(phase, { message: 'm', ...f });

  it('passes tool errors through and treats an unknown failure as unconfirmed', () => {
    const t = new AppleToolError('UNSUPPORTED', 'x');
    expect(classifySmtpError(t, account())).toBe(t);
    expect(classifySmtpError(new Error('?'), account())).toBeInstanceOf(UnconfirmedWriteError);
  });

  it('latches a 5xx authentication refusal', () => {
    const a = account();
    const e = classifySmtpError(err('auth', { code: 'EAUTH', responseCode: 535, response: '535 no' }), a);
    expect(e).toBeInstanceOf(CredentialsRejectedError);
    expect(e.message).toBe('iCloud Mail (SMTP) rejected the sign-in as me@icloud.com (server said: 535 no). Nothing was sent.');
    expect((e as CredentialsRejectedError).hint).toMatch(/must be this Apple ID's own iCloud Mail address/);
    expect(() => assertNotLatched(a.latchCreds, 'mail')).toThrow(/already rejected/);
  });

  it('does not latch a temporary or response-less auth failure', () => {
    const a = account();
    const temp = classifySmtpError(err('auth', { code: 'EAUTH', responseCode: 454, response: '454 later' }), a) as AppleToolError;
    expect(temp.code).toBe('UPSTREAM_ERROR');
    expect(temp.hint).toMatch(/temporary/);
    expect((classifySmtpError(err('auth', { code: 'EAUTH' }), a) as AppleToolError).hint).toBeUndefined();
    expect((classifySmtpError(err('auth', { code: 'ENOAUTH' }), a) as AppleToolError).code).toBe('UPSTREAM_ERROR');
    expect(() => assertNotLatched(a.latchCreds, 'mail')).not.toThrow();
  });

  it('an envelope or message refusal is definitive: nothing was sent', () => {
    const env = classifySmtpError(err('data', { code: 'EENVELOPE', responseCode: 550, response: '550 no such user', rejected: ['x@y.z'] }), account()) as AppleToolError;
    expect(env.message).toBe('iCloud Mail refused the message before sending it (server said: 550 no such user). Rejected recipients: x@y.z. Nothing was sent.');
    expect(env.hint).toMatch(/recipient addresses/);
    const env4 = classifySmtpError(err('envelope', { code: 'EENVELOPE', responseCode: 451 }), account()) as AppleToolError;
    expect(env4.message).toBe('iCloud Mail refused the message before sending it. Nothing was sent.');
    expect(env4.hint).toMatch(/temporary/);
    const msg = classifySmtpError(err('data', { code: 'EMESSAGE', responseCode: 554, response: '554 spam' }), account());
    expect(msg.message).toBe('iCloud Mail refused the message (server said: 554 spam). It was not sent.');
    // nodemailer refuses a message over the server's SIZE limit before MAIL FROM, with no server text.
    const size = classifySmtpError(err('envelope', { code: 'EMESSAGE', message: 'Message size larger than allowed 20971520' }), account());
    expect(size.message).toBe('iCloud Mail refused the message (Message size larger than allowed 20971520). It was not sent.');
  });

  it('a failure after the body was handed over is unconfirmed; before it, a transport error', () => {
    expect(classifySmtpError(err('data', { code: 'ECONNECTION' }), account())).toBeInstanceOf(UnconfirmedWriteError);
    const t = classifySmtpError(err('connect', { code: 'ETIMEDOUT' }), account()) as TransportError;
    expect(t).toBeInstanceOf(TransportError);
    expect(t.code).toBe('TIMEOUT');
    expect(t.message).toContain('Nothing was sent');
    const n = classifySmtpError(err('envelope', { code: 'ECONNECTION' }), account()) as TransportError;
    expect(n.code).toBe('NETWORK_ERROR');
    expect(n.message).toBe('iCloud Mail (smtp.mail.me.com:587) failed during envelope: m. Nothing was sent.');
  });
});

// ---------------------------------------------------------------------------
// The real nodemailer SMTPConnection against a loopback SMTP server
// ---------------------------------------------------------------------------

type Behaviour = 'ok' | 'auth-fail' | 'rcpt-fail' | 'drop-after-data' | 'no-greeting';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function smtpServer(behaviour: Behaviour): Promise<{ port: number; received: string[] }> {
  const received: string[] = [];
  const server = createServer((socket) => {
    if (behaviour === 'no-greeting') {
      socket.end();
      return;
    }
    socket.write('220 localhost ESMTP test\r\n');
    let buffer = '';
    let inData = false;
    let data = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('latin1');
      let idx: number;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            received.push(data);
            if (behaviour === 'drop-after-data') {
              socket.destroy();
              return;
            }
            socket.write('250 2.0.0 queued\r\n');
          } else data += `${line}\n`;
          continue;
        }
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO')) socket.write('250-localhost\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        else if (cmd.startsWith('AUTH')) socket.write(behaviour === 'auth-fail' ? '535 5.7.8 Authentication failed\r\n' : '235 2.7.0 OK\r\n');
        else if (cmd.startsWith('MAIL FROM')) socket.write('250 OK\r\n');
        else if (cmd.startsWith('RCPT TO')) socket.write(behaviour === 'rcpt-fail' ? '550 5.1.1 No such user\r\n' : '250 OK\r\n');
        else if (cmd === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (cmd === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else socket.write('502 unknown\r\n');
      }
    });
    socket.on('error', () => undefined);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, received };
}

function loopback(port: number): SmtpTransportOptions {
  return { host: '127.0.0.1', port, secure: false, requireTLS: false, ignoreTLS: true, user: 'me@icloud.com', pass: 'pw', timeoutMs: 5000 };
}

describe('createSmtpTransport against the real SMTPConnection', () => {
  it('delivers and reports the server answer', async () => {
    const srv = await smtpServer('ok');
    const res = await createSmtpTransport(loopback(srv.port)).submit(MSG);
    expect(res).toEqual({ accepted: ['bob@example.com'], rejected: [], response: '250 2.0.0 queued' });
    expect(srv.received[0]).toContain('Subject: hi');
  });

  it('a connection lost after the body went out is phase data → unconfirmed', async () => {
    const srv = await smtpServer('drop-after-data');
    const e = await phaseOf(createSmtpTransport(loopback(srv.port)).submit(MSG));
    expect(e.phase).toBe('data');
    expect(classifySmtpError(e, resolveMailAccount())).toBeInstanceOf(UnconfirmedWriteError);
  });

  it('a refused recipient is a definitive envelope failure', async () => {
    const srv = await smtpServer('rcpt-fail');
    const e = await phaseOf(createSmtpTransport(loopback(srv.port)).submit(MSG));
    expect(e).toMatchObject({ code: 'EENVELOPE', responseCode: 550 });
    expect((classifySmtpError(e, resolveMailAccount()) as AppleToolError).message).toContain('Nothing was sent');
    expect(srv.received).toHaveLength(0);
  });

  it('a refused login is phase auth with the SMTP code', async () => {
    const srv = await smtpServer('auth-fail');
    const e = await phaseOf(createSmtpTransport(loopback(srv.port)).submit(MSG));
    expect(e).toMatchObject({ phase: 'auth', code: 'EAUTH', responseCode: 535 });
  });

  it('a server that hangs up before greeting fails in phase connect', async () => {
    const srv = await smtpServer('no-greeting');
    const e = await phaseOf(createSmtpTransport(loopback(srv.port)).submit(MSG));
    expect(e.phase).toBe('connect');
    expect(classifySmtpError(e, resolveMailAccount())).toBeInstanceOf(TransportError);
  });

  it('goes through an HTTP CONNECT proxy (nodemailer proxy client)', async () => {
    const srv = await smtpServer('ok');
    const connects: string[] = [];
    const proxy = createHttpServer();
    proxy.on('connect', (req, clientSocket: Socket, head) => {
      connects.push(String(req.url));
      if (req.url !== `smtp.test:${srv.port}`) {
        clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      const target = new NetSocket();
      target.connect(srv.port, '127.0.0.1', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) target.write(head);
        target.pipe(clientSocket);
        clientSocket.pipe(target);
      });
      target.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => target.destroy());
    });
    servers.push(proxy as unknown as Server);
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    const res = await createSmtpTransport({ ...loopback(srv.port), host: 'smtp.test', proxy: proxyUrl }).submit(MSG);
    expect(res.accepted).toEqual(['bob@example.com']);
    expect(connects).toEqual([`smtp.test:${srv.port}`]);
    await expect(openHttpTunnel(proxyUrl, 25, 'blocked.test', 5000)).rejects.toThrow(/403/);
    expect(defaultSmtpSeams.openTunnel).toBe(openHttpTunnel);
  });
});

describe('openHttpTunnel deadline', () => {
  /** A "proxy" that reads the CONNECT and then does `act` with the socket. */
  async function rawProxy(act: (socket: Socket) => void): Promise<{ url: string; sockets: Socket[] }> {
    const sockets: Socket[] = [];
    const server = createServer((socket) => {
      sockets.push(socket);
      socket.on('error', () => undefined);
      socket.once('data', () => act(socket));
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, sockets };
  }

  it('fails a proxy that hangs up without answering, instead of waiting forever', async () => {
    const p = await rawProxy((socket) => socket.end());
    const started = Date.now();
    await expect(openHttpTunnel(p.url, 587, 'smtp.mail.me.com', 300)).rejects.toMatchObject({
      code: 'ETIMEDOUT',
      message: 'The proxy did not open a tunnel to smtp.mail.me.com:587 within 300 ms',
    });
    expect(Date.now() - started).toBeLessThan(5000);
    // Through the transport it is a connect-phase timeout: nothing was sent.
    const e = await phaseOf(createSmtpTransport({ ...OPTS, proxy: p.url, timeoutMs: 300 }).submit(MSG));
    expect(e).toMatchObject({ phase: 'connect', code: 'ETIMEDOUT' });
    expect(classifySmtpError(e, resolveMailAccount())).toMatchObject({ code: 'TIMEOUT' });
  });

  it('stops waiting when the tool call is cancelled', async () => {
    const p = await rawProxy(() => undefined); // never answers
    const ac = new AbortController();
    const pending = withCallSignal(ac.signal, () => openHttpTunnel(p.url, 587, 'smtp.mail.me.com', 30_000));
    setTimeout(() => ac.abort(), 20);
    await expect(pending).rejects.toMatchObject({ code: 'ECANCELLED' });
    // (nodemailer's own 30 s idle timer reclaims its socket later; hang up so the server can close now)
    for (const socket of p.sockets) socket.destroy();
  });

  it('closes a tunnel that opens after the deadline, and ignores a late refusal', async () => {
    const late = await rawProxy((socket) => setTimeout(() => socket.write('HTTP/1.1 200 OK\r\n\r\n'), 150));
    await expect(openHttpTunnel(late.url, 587, 'smtp.mail.me.com', 50)).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    const closed = new Promise<void>((r) => late.sockets[0]?.once('close', () => r()));
    await closed; // the client destroyed the tunnel nobody wanted
    const refused = await rawProxy((socket) => setTimeout(() => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'), 150));
    await expect(openHttpTunnel(refused.url, 587, 'smtp.mail.me.com', 50)).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    await new Promise((r) => setTimeout(r, 250)); // the late callback lands and is ignored
  });
});
