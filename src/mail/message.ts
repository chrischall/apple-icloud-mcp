import { randomUUID } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer';
import addressparser from 'nodemailer/lib/addressparser';
import PostalMime, { type Email } from 'postal-mime';
import { AppleToolError, InvalidArgumentError, errorMessage } from '../errors.js';
import { EMAIL_RE } from './config.js';
import { formatAddress } from './format.js';
import { htmlToText } from './html-text.js';

/**
 * Composing outgoing messages and reading fetched ones.
 */

export interface Recipient {
  name?: string;
  address: string;
}

/** Characters no header value or address may carry: CR/LF would let a value inject headers. */
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** Something shaped like an address, outside quoted display names. */
const ADDRESS_LIKE_RE = /[^\s<>"(),;:@]+@[^\s<>"(),;:@]+/g;

/**
 * Parse one recipient argument — `a@b.com` or `Name <a@b.com>` — refusing
 * anything that is not exactly one plausible address.
 */
export function parseRecipient(input: string, field: string): Recipient {
  if (CONTROL_RE.test(input)) {
    throw new InvalidArgumentError(`${field}: "${input.replace(new RegExp(CONTROL_RE.source, 'g'), '?')}" contains control characters.`);
  }
  const parsed = addressparser(input);
  const first = parsed[0];
  // addressparser reads `a@b.com c@d.com` (or `x@y.com <a@b.com>`) as ONE mailbox whose display
  // name is the second address: only one of them would get the mail, and the preview would show
  // the other in front. Two address-shaped tokens outside a quoted name is ambiguous — refuse it.
  const addressLike = input.replace(/"(?:[^"\\]|\\.)*"/g, '""').match(ADDRESS_LIKE_RE) ?? [];
  if (parsed.length !== 1 || !first || first.group || !first.address || !EMAIL_RE.test(first.address) || addressLike.length > 1) {
    throw new InvalidArgumentError(
      `${field}: "${input}" is not a single email address.`,
      'Give one address per entry, as name@example.com or "Name <name@example.com>".',
    );
  }
  return first.name ? { name: first.name, address: first.address } : { address: first.address };
}

export function parseRecipients(list: readonly string[] | undefined, field: string): Recipient[] {
  return (list ?? []).map((v, i) => parseRecipient(v, `${field}[${i}]`));
}

export function recipientLabel(r: Recipient): string {
  return formatAddress(r) as string;
}

export interface OutgoingMessage {
  from: string;
  to: Recipient[];
  cc: Recipient[];
  bcc: Recipient[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
}

export interface BuiltMessage {
  /** What goes to SMTP: no Bcc header (Bcc recipients are in the envelope only). */
  raw: Buffer;
  /** The copy filed in Sent: identical, but keeping the Bcc header so the sender can see who was copied. */
  sentCopy: Buffer;
  messageId: string;
  date: Date;
  envelope: { from: string; to: string[] };
}

/** Build the RFC 5322 message twice from the same fixed Message-ID and Date (with and without Bcc). */
export async function buildMessage(msg: OutgoingMessage, now: Date = new Date()): Promise<BuiltMessage> {
  const domain = msg.from.slice(msg.from.lastIndexOf('@') + 1);
  const messageId = `<${randomUUID()}@${domain}>`;
  const options = {
    from: msg.from,
    to: msg.to,
    ...(msg.cc.length ? { cc: msg.cc } : {}),
    ...(msg.bcc.length ? { bcc: msg.bcc } : {}),
    subject: msg.subject,
    text: msg.text,
    messageId,
    date: now,
    ...(msg.inReplyTo ? { inReplyTo: msg.inReplyTo } : {}),
    ...(msg.references && msg.references.length ? { references: msg.references } : {}),
    // RFC 5322 line endings: IMAP APPEND and SMTP both want CRLF.
    newline: 'win',
  };
  const node = new MailComposer(options).compile();
  const raw = await node.build();
  const envelope = node.getEnvelope();
  const copyNode = new MailComposer(options).compile();
  copyNode.keepBcc = true;
  const sentCopy = await copyNode.build();
  return { raw, sentCopy, messageId, date: now, envelope: { from: msg.from, to: envelope.to } };
}

/** `Re: <subject>`, without stacking prefixes. */
export function replySubject(original: string | undefined): string {
  const s = (original ?? '').trim();
  return /^re\s*:/i.test(s) ? s : `Re: ${s}`.trimEnd();
}

/** Message-IDs from a References / In-Reply-To header, in order. */
export function messageIds(header: string | undefined): string[] {
  return header ? (header.match(/<[^<>\s]+>/g) ?? []) : [];
}

/** How many ancestors a References header keeps (RFC 5322 suggests trimming long chains). */
const MAX_REFERENCES = 20;

/** The References chain for a reply: the original's chain plus the original itself. */
export function replyReferences(originalReferences: string | undefined, originalMessageId: string | undefined): string[] {
  const chain = messageIds(originalReferences);
  const own = messageIds(originalMessageId);
  for (const id of own) if (!chain.includes(id)) chain.push(id);
  return chain.slice(-MAX_REFERENCES);
}

/** The largest amount of the original a reply quotes; the rest is cut with a marker. */
export const MAX_QUOTED_CHARS = 20_000;

/** An attribution line plus the original text, each line prefixed `> `. */
export function quoteOriginal(text: string, attribution: string): { quoted: string; truncated: boolean } {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  const truncated = normalized.length > MAX_QUOTED_CHARS;
  const body = truncated ? `${normalized.slice(0, MAX_QUOTED_CHARS)}\n[…]` : normalized;
  return { quoted: `${attribution}\n${body.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')}`, truncated };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Parse a fetched RFC 822 message. postal-mime refuses hostile shapes outright (MIME
 * nesting past 256 levels, more than 2 MiB of headers); that is the message's fault,
 * not this server's, so it surfaces as an upstream error naming the message.
 */
export async function parseMessage(source: Buffer): Promise<Email> {
  try {
    return await PostalMime.parse(source);
  } catch (err) {
    throw new AppleToolError('UPSTREAM_ERROR', `The message could not be read: ${errorMessage(err)}.`, {
      hint: 'Its MIME structure is malformed or oversized; open it in the Mail app instead.',
    });
  }
}

export interface ExtractedBody {
  /** Where the text came from: the text/plain part, HTML converted to text, or nothing. */
  format: 'text' | 'html' | 'none';
  text: string;
  /** Length of the full extracted text, before `maxChars`. */
  totalChars: number;
  truncated: boolean;
}

/** The readable body: text/plain when the message has one, else its HTML as text; cut at `maxChars`. */
export function extractBody(email: Pick<Email, 'text' | 'html'>, maxChars: number): ExtractedBody {
  let format: ExtractedBody['format'] = 'none';
  let full = '';
  if (email.text !== undefined && email.text.trim() !== '') {
    format = 'text';
    full = email.text.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  } else if (email.html !== undefined && email.html.trim() !== '') {
    format = 'html';
    full = htmlToText(email.html);
  }
  const truncated = full.length > maxChars;
  return { format, text: truncated ? full.slice(0, maxChars) : full, totalChars: full.length, truncated };
}

export interface AttachmentInfo {
  filename?: string;
  mimeType: string;
  size: number;
  inline?: boolean;
}

/** Attachment metadata only — never the bytes. */
export function attachmentInfo(email: Pick<Email, 'attachments'>): AttachmentInfo[] {
  return email.attachments.map((a) => {
    const content = a.content;
    const size = typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength;
    return {
      ...(a.filename ? { filename: a.filename } : {}),
      mimeType: a.mimeType,
      size,
      ...(a.disposition === 'inline' || a.related ? { inline: true } : {}),
    };
  });
}
