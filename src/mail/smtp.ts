import type { Socket } from 'node:net';
import { Readable } from 'node:stream';
import { currentCallSignal } from '@chrischall/mcp-utils';
import SMTPConnection, {
  type SMTPConnectionAuth,
  type SMTPConnectionOptions,
  type SMTPConnectionSendInfo,
  type SMTPEnvelope,
} from 'nodemailer/lib/smtp-connection';
import httpProxyClient from 'nodemailer/lib/smtp-connection/http-proxy-client';
import {
  AppleToolError,
  CredentialsRejectedError,
  TransportError,
  UnconfirmedWriteError,
} from '../errors.js';
import { REJECTED_HINT, latchRejection } from '../icloud-auth.js';
import { SMTP_HOST, SMTP_PORT, type MailAccount } from './config.js';

/**
 * The SMTP half of iCloud Mail, on nodemailer's `SMTPConnection` directly.
 *
 * Not `createTransport().sendMail()`: that reports every failure through one
 * callback, and a dropped connection carries `command: 'CONN'` whether it
 * happened while connecting or after the message body was handed over. Those
 * two must be told apart — the first means NOTHING was sent (safe to say, safe
 * to retry), the second means the message MAY have been sent (a blind retry
 * sends it twice). Driving the connection step by step makes the phase known:
 *
 *   connect → auth → envelope (MAIL FROM / RCPT TO / DATA) → data (the body)
 *
 * and the switch into `data` is observed exactly: SMTPConnection pipes the
 * message stream only after the server has answered DATA with 354.
 */

export type SmtpPhase = 'connect' | 'auth' | 'envelope' | 'data';

/** A failure tagged with the phase it happened in, plus nodemailer's own facts about it. */
export class SmtpPhaseError extends Error {
  readonly phase: SmtpPhase;
  readonly code?: string;
  readonly responseCode?: number;
  readonly response?: string;
  readonly rejected?: string[];
  constructor(
    phase: SmtpPhase,
    cause: { message?: string; code?: string; responseCode?: number; response?: string; rejected?: string[] },
  ) {
    super(cause.message || 'SMTP failure');
    this.name = 'SmtpPhaseError';
    this.phase = phase;
    if (cause.code !== undefined) this.code = cause.code;
    if (typeof cause.responseCode === 'number') this.responseCode = cause.responseCode;
    if (typeof cause.response === 'string') this.response = cause.response;
    if (Array.isArray(cause.rejected)) this.rejected = cause.rejected;
  }
}

export interface SmtpSubmission {
  /** Envelope sender. */
  from: string;
  /** Envelope recipients (To + Cc + Bcc). */
  to: string[];
  /** The RFC 5322 message exactly as it is to be delivered (no Bcc header). */
  raw: Buffer;
}

export interface SmtpSubmitResult {
  accepted: string[];
  rejected: string[];
  /** The server's final answer, e.g. `250 2.0.0 Ok: queued`. */
  response?: string;
}

/** What the send tool needs from SMTP; tests inject a fake. */
export interface SmtpTransportLike {
  submit(message: SmtpSubmission): Promise<SmtpSubmitResult>;
}

export interface SmtpTransportOptions {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  /** Test seam: skip STARTTLS (never set for iCloud). */
  ignoreTLS?: boolean;
  user: string;
  pass: string;
  /** HTTP CONNECT proxy URL to tunnel through. */
  proxy?: string;
  timeoutMs: number;
}

export type CreateSmtpTransport = (options: SmtpTransportOptions) => SmtpTransportLike;

/** The slice of SMTPConnection used here. */
export interface SmtpConnectionLike {
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  connect(callback: () => void): void;
  login(auth: SMTPConnectionAuth, callback: (err: Error | null) => void): void;
  send(envelope: SMTPEnvelope, message: Readable, callback: (err: Error | null, info?: SMTPConnectionSendInfo) => void): void;
  quit(): void;
  close(): void;
}

export interface SmtpSeams {
  createConnection(options: SMTPConnectionOptions): SmtpConnectionLike;
  openTunnel(proxy: string, port: number, host: string, timeoutMs: number): Promise<Socket>;
}

/**
 * Open an HTTP CONNECT tunnel to `host:port` through `proxy` (nodemailer's own
 * proxy client), handed back PAUSED.
 *
 * SMTP is server-speaks-first, and a CONNECT proxy (mcp-host's included)
 * pipes the upstream to us immediately, so the `220` greeting can arrive in
 * the same read as the proxy's `200`. nodemailer's proxy client unshifts
 * those bytes onto a socket still in flowing mode with no `data` listener,
 * and SMTPConnection attaches its listener only on a later tick — so the
 * greeting is emitted to nobody and the connection waits for it until the
 * greeting timeout (observed against a loopback proxy). Pausing buffers it
 * instead; SMTPConnection resumes the socket once it listens.
 */
export function openHttpTunnel(proxy: string, port: number, host: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    let done = false;
    const signal = currentCallSignal();
    // Every path into here runs at most once: the timer and the abort listener are both
    // removed on settling, and the proxy callback checks `done` first.
    const fail = (err: Error): void => {
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    };
    // nodemailer's proxy client never calls back when the proxy closes the connection
    // without answering the CONNECT (its only timer dies with the socket), so the whole
    // tunnel attempt has its own deadline — and a cancelled call stops waiting too.
    const timer = setTimeout(
      () => fail(Object.assign(new Error(`The proxy did not open a tunnel to ${host}:${port} within ${timeoutMs} ms`), { code: 'ETIMEDOUT' })),
      timeoutMs,
    );
    const onAbort = (): void => fail(Object.assign(new Error('The tool call was cancelled.'), { code: 'ECANCELLED' }));
    signal?.addEventListener('abort', onAbort, { once: true });
    httpProxyClient(proxy, port, host, (err, socket) => {
      if (done) {
        // Too late: nobody is waiting for this tunnel any more.
        socket?.destroy();
        return;
      }
      if (err) {
        fail(err);
        return;
      }
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const tunnel = socket as Socket; // nodemailer always passes the socket when there is no error
      tunnel.pause();
      resolve(tunnel);
    });
  });
}

export const defaultSmtpSeams: SmtpSeams = {
  createConnection: (options) => new SMTPConnection(options) as unknown as SmtpConnectionLike,
  openTunnel: openHttpTunnel,
};

/**
 * The message body as a stream that reports when SMTPConnection starts
 * piping it — the moment the server has accepted DATA (or, on an envelope
 * error, drains it into a sink; that path always fails with EENVELOPE, which
 * is classified before the phase is looked at).
 */
export class DataPhaseProbe extends Readable {
  private readonly payload: Buffer;
  private readonly onStart: () => void;
  constructor(payload: Buffer, onStart: () => void) {
    super();
    this.payload = payload;
    this.onStart = onStart;
  }
  override _read(): void {
    this.push(this.payload);
    this.push(null);
  }
  override pipe<T extends NodeJS.WritableStream>(destination: T, options?: { end?: boolean }): T {
    this.onStart();
    return super.pipe(destination, options);
  }
}

/** The default transport: one SMTPConnection per submission (connect → auth → send → QUIT). */
export function createSmtpTransport(options: SmtpTransportOptions, seams: SmtpSeams = defaultSmtpSeams): SmtpTransportLike {
  return {
    async submit(message) {
      let tunnel: Socket | undefined;
      if (options.proxy !== undefined) {
        try {
          tunnel = await seams.openTunnel(options.proxy, options.port, options.host, options.timeoutMs);
        } catch (err) {
          throw new SmtpPhaseError('connect', { ...(err as object), message: (err as Error)?.message ?? String(err), code: (err as { code?: string })?.code ?? 'EPROXY' });
        }
      }
      return new Promise<SmtpSubmitResult>((resolve, reject) => {
        let phase: SmtpPhase = 'connect';
        let settled = false;
        const conn = seams.createConnection({
          host: options.host,
          port: options.port,
          secure: options.secure,
          requireTLS: options.requireTLS,
          ...(options.ignoreTLS ? { ignoreTLS: true } : {}),
          connectionTimeout: options.timeoutMs,
          greetingTimeout: options.timeoutMs,
          socketTimeout: options.timeoutMs,
          logger: false,
          debug: false,
          ...(tunnel ? { connection: tunnel } : {}),
        });
        const signal = currentCallSignal();
        const onAbort = (): void => settle(Object.assign(new Error('The tool call was cancelled.'), { code: 'ECANCELLED' }));
        const settle = (err: Error | null, info?: SMTPConnectionSendInfo): void => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          if (err) {
            conn.close();
            reject(new SmtpPhaseError(phase, err as SmtpPhaseError));
            return;
          }
          conn.quit();
          const sent = info as SMTPConnectionSendInfo;
          resolve({
            accepted: sent.accepted,
            rejected: sent.rejected,
            ...(sent.response !== undefined ? { response: sent.response } : {}),
          });
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        // A permanent listener: SMTPConnection emits 'error' after QUIT too, and an unheard 'error' crashes Node.
        conn.on('error', (err) => settle(err));
        // The server can close without an error event (e.g. before its greeting).
        conn.on('end', () => settle(Object.assign(new Error('The connection closed unexpectedly.'), { code: 'ECONNECTION' })));
        conn.connect(() => {
          if (settled) return;
          phase = 'auth';
          conn.login({ user: options.user, pass: options.pass }, (err) => {
            if (settled) return;
            if (err) {
              settle(err);
              return;
            }
            phase = 'envelope';
            const body = new DataPhaseProbe(message.raw, () => {
              phase = 'data';
            });
            conn.send({ from: message.from, to: message.to, size: message.raw.length }, body, (sendErr, info) =>
              settle(sendErr, info),
            );
          });
        });
      });
    },
  };
}

/**
 * Map a submission failure onto the foundation errors, deciding the one thing
 * that matters most: was the message possibly sent?
 *
 *  - a 5xx AUTH answer: definitive credential rejection → latch, nothing sent;
 *  - the server refused the envelope (sender/recipients) or the message after
 *    DATA: definitive, nothing sent;
 *  - any other failure BEFORE the body was handed over: nothing sent;
 *  - any other failure AFTER it (or at an unknown point): UNCONFIRMED.
 */
export function classifySmtpError(err: unknown, account: MailAccount): Error {
  if (err instanceof AppleToolError) return err;
  if (!(err instanceof SmtpPhaseError)) {
    return new UnconfirmedWriteError('mail', 'Sending failed at an unknown point; the message may or may not have been sent.', err);
  }
  const says = err.response ? ` (server said: ${err.response})` : '';
  const temporary = err.responseCode !== undefined && err.responseCode >= 400 && err.responseCode < 500;
  const retryHint = temporary ? { hint: 'This is a temporary refusal; try again later.' } : {};
  if (err.code === 'EAUTH' && err.responseCode !== undefined && err.responseCode >= 500) {
    latchRejection(account.latchCreds);
    return new CredentialsRejectedError(
      'mail',
      401,
      `iCloud Mail (SMTP) rejected the sign-in as ${account.address}${says}. Nothing was sent.`,
      `${REJECTED_HINT} The SMTP login is the mail address itself, so it must be this Apple ID's own iCloud Mail address (not an alias).`,
    );
  }
  if (err.code === 'EAUTH' || err.code === 'ENOAUTH') {
    return new AppleToolError('UPSTREAM_ERROR', `iCloud Mail (SMTP) sign-in failed${says}. Nothing was sent.`, retryHint);
  }
  if (err.code === 'EENVELOPE') {
    const who = err.rejected && err.rejected.length > 0 ? ` Rejected recipients: ${err.rejected.join(', ')}.` : '';
    return new AppleToolError('UPSTREAM_ERROR', `iCloud Mail refused the message before sending it${says}.${who} Nothing was sent.`, {
      hint: temporary
        ? 'This is a temporary refusal; try again later.'
        : 'Check the recipient addresses. The From address is ICLOUD_MAIL_ADDRESS and must be an address of this iCloud account.',
    });
  }
  if (err.code === 'EMESSAGE') {
    // The final answer to DATA (or, before MAIL FROM, the server's advertised SIZE limit): not accepted.
    return new AppleToolError('UPSTREAM_ERROR', `iCloud Mail refused the message${says || ` (${err.message})`}. It was not sent.`, retryHint);
  }
  if (err.phase === 'data') {
    return new UnconfirmedWriteError(
      'mail',
      'The connection to iCloud Mail failed after the message was handed over; it may or may not have been sent.',
      err,
    );
  }
  const where = `${SMTP_HOST}:${SMTP_PORT}`;
  if (err.code === 'ETIMEDOUT') {
    return new TransportError('mail', 'TIMEOUT', `iCloud Mail (${where}) timed out during ${err.phase}. Nothing was sent.`, err);
  }
  return new TransportError('mail', 'NETWORK_ERROR', `iCloud Mail (${where}) failed during ${err.phase}: ${err.message}. Nothing was sent.`, err);
}
