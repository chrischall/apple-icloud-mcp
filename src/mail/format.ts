import type { FetchMessageObject, MessageAddressObject, MessageStructureObject } from 'imapflow';
import { putInstant } from '../time.js';

/**
 * Shaping IMAP/MIME data into tool output: addresses as `Name <addr>` strings,
 * instants through `putInstant`, and the "has attachments" answer from a
 * BODYSTRUCTURE without downloading anything.
 */

export interface AddressLike {
  name?: string | undefined;
  address?: string | undefined;
  group?: AddressLike[] | undefined;
}

/** `Name <addr>`, the bare address, or the name alone when a header carried no address. */
export function formatAddress(a: AddressLike): string | undefined {
  const name = a.name?.replace(/\s+/g, ' ').trim();
  const address = a.address?.trim();
  if (address) return name && name !== address ? `${name} <${address}>` : address;
  return name || undefined;
}

/** Every mailbox in an address list, groups flattened (an empty group is named, e.g. `undisclosed-recipients:;`). */
export function formatAddressList(list: readonly AddressLike[] | AddressLike | undefined): string[] {
  if (!list) return [];
  const items = Array.isArray(list) ? list : [list as AddressLike];
  const out: string[] = [];
  for (const a of items) {
    if (a.group) {
      if (a.group.length === 0) {
        if (a.name) out.push(`${a.name}:;`);
      } else out.push(...formatAddressList(a.group));
      continue;
    }
    const f = formatAddress(a);
    if (f) out.push(f);
  }
  return out;
}

/** One mailbox of an address list: how to show it, and its bare address lowercased for comparing. */
export interface AddressEntry {
  label: string;
  address: string;
}

/** Every mailbox that carries an address, groups flattened (name-only entries and empty groups have nothing to compare). */
export function addressEntries(list: readonly AddressLike[] | AddressLike | undefined): AddressEntry[] {
  if (!list) return [];
  const items = Array.isArray(list) ? list : [list as AddressLike];
  const out: AddressEntry[] = [];
  for (const a of items) {
    if (a.group) {
      out.push(...addressEntries(a.group));
      continue;
    }
    const address = a.address?.trim();
    if (address) out.push({ label: formatAddress(a) as string, address: address.toLowerCase() });
  }
  return out;
}

/**
 * The Reply-To worth showing beside From: the whole list when it names an address
 * the From does not, else nothing. A reply that goes to From while the sender asked
 * for another address is misrouted, and nothing else in a row or preview says so.
 * A Reply-To that only repeats From is left out: IMAP's ENVELOPE copies From into
 * reply-to when the header is absent, so showing it would only duplicate From.
 */
export function distinctReplyTo(
  replyTo: readonly AddressLike[] | AddressLike | undefined,
  from: readonly AddressLike[] | AddressLike | undefined,
): AddressEntry[] {
  const entries = addressEntries(replyTo);
  const senders = new Set(addressEntries(from).map((e) => e.address));
  return entries.some((e) => !senders.has(e.address)) ? entries : [];
}

/** A valid Date from a Date, an ISO string or an RFC 2822 string; undefined when it does not parse. */
export function toDate(v: Date | string | undefined): Date | undefined {
  if (v === undefined || v === '') return undefined;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Does this BODYSTRUCTURE carry a file a mail client would list as an attachment? */
export function hasAttachment(node: MessageStructureObject | undefined): boolean {
  if (!node) return false;
  const type = (node.type || '').toLowerCase();
  const disposition = (node.disposition || '').toLowerCase();
  // Checked BEFORE descending: an attached message (a forwarded .eml, message/rfc822)
  // carries its own body structure as children, and a plain text child must not make
  // the attachment itself disappear.
  if (disposition === 'attachment' && !type.startsWith('multipart/')) return true;
  if (node.childNodes && node.childNodes.length > 0) return node.childNodes.some((c) => hasAttachment(c));
  if (type.startsWith('multipart/')) return false;
  const filename = node.dispositionParameters?.filename ?? node.parameters?.name;
  if (!filename) return false;
  // A named text/plain or text/html part that is not marked `attachment` is a body part, not a file.
  return type !== 'text/plain' && type !== 'text/html';
}

export interface MessageRow {
  uid: number;
  date?: string;
  dateDisplay?: string;
  from?: string;
  /** Only when it names an address the From does not (see distinctReplyTo). */
  replyTo?: string[];
  to: string[];
  cc?: string[];
  subject: string;
  seen: boolean;
  flagged: boolean;
  hasAttachments: boolean;
  size?: number;
}

/** One search-result row from a FETCH (ENVELOPE FLAGS INTERNALDATE RFC822.SIZE BODYSTRUCTURE). */
export function toRow(msg: FetchMessageObject, zone: string): MessageRow {
  const env = msg.envelope ?? {};
  const flags = msg.flags ?? new Set<string>();
  const row: Record<string, unknown> = { uid: msg.uid };
  // The Date header is what a mail client shows; INTERNALDATE (arrival) stands in when the header is missing or broken.
  putInstant(row, 'date', toDate(env.date) ?? toDate(msg.internalDate), zone);
  const from = formatAddressList(env.from as MessageAddressObject[] | undefined);
  if (from.length > 0) row.from = from.join(', ');
  const replyTo = distinctReplyTo(env.replyTo as MessageAddressObject[] | undefined, env.from as MessageAddressObject[] | undefined);
  if (replyTo.length > 0) row.replyTo = replyTo.map((e) => e.label);
  row.to = formatAddressList(env.to as MessageAddressObject[] | undefined);
  const cc = formatAddressList(env.cc as MessageAddressObject[] | undefined);
  if (cc.length > 0) row.cc = cc;
  row.subject = env.subject ?? '';
  row.seen = flags.has('\\Seen');
  row.flagged = flags.has('\\Flagged');
  row.hasAttachments = hasAttachment(msg.bodyStructure);
  if (typeof msg.size === 'number') row.size = msg.size;
  return row as unknown as MessageRow;
}

/** Special-use words this module speaks, from IMAP's flags. */
const SPECIAL_WORDS: Record<string, string> = {
  '\\inbox': 'inbox',
  '\\sent': 'sent',
  '\\drafts': 'drafts',
  '\\trash': 'trash',
  '\\junk': 'junk',
  '\\archive': 'archive',
  '\\all': 'all',
  '\\flagged': 'flagged',
};

/** iCloud's fixed folder names (it advertises no SPECIAL-USE, so the names are the contract). */
export const ICLOUD_FOLDERS: Record<string, string> = {
  inbox: 'INBOX',
  sent: 'Sent Messages',
  drafts: 'Drafts',
  trash: 'Deleted Messages',
  junk: 'Junk',
  archive: 'Archive',
};

/** The special-use word for a mailbox: iCloud's own names first, then what the server/library reported. */
export function specialUseWord(path: string, specialUse: string | undefined): string | undefined {
  if (path.toUpperCase() === 'INBOX') return 'inbox';
  for (const [word, name] of Object.entries(ICLOUD_FOLDERS)) if (name === path) return word;
  return specialUse ? SPECIAL_WORDS[specialUse.toLowerCase()] : undefined;
}
