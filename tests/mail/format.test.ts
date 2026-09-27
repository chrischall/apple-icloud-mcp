import { describe, expect, it } from 'vitest';
import type { FetchMessageObject } from 'imapflow';
import {
  addressEntries,
  distinctReplyTo,
  formatAddress,
  formatAddressList,
  hasAttachment,
  specialUseWord,
  toDate,
  toRow,
} from '../../src/mail/format.js';

describe('addresses', () => {
  it('formats one address', () => {
    expect(formatAddress({ name: ' Jane   Doe ', address: 'jane@x.com' })).toBe('Jane Doe <jane@x.com>');
    expect(formatAddress({ name: 'jane@x.com', address: 'jane@x.com' })).toBe('jane@x.com');
    expect(formatAddress({ address: 'jane@x.com' })).toBe('jane@x.com');
    expect(formatAddress({ name: 'Only Name' })).toBe('Only Name');
    expect(formatAddress({ name: '  ' })).toBeUndefined();
    expect(formatAddress({})).toBeUndefined();
  });

  it('flattens lists and groups', () => {
    expect(formatAddressList(undefined)).toEqual([]);
    expect(formatAddressList({ address: 'a@x.com' })).toEqual(['a@x.com']);
    expect(
      formatAddressList([
        { name: 'Team', group: [{ address: 'b@x.com' }, { name: 'C', address: 'c@x.com' }] },
        { name: 'undisclosed-recipients', group: [] },
        { name: '', group: [] },
        {},
        { address: 'd@x.com' },
      ]),
    ).toEqual(['b@x.com', 'C <c@x.com>', 'undisclosed-recipients:;', 'd@x.com']);
  });

  it('lists the comparable mailboxes: label plus lowercased bare address, groups flattened', () => {
    expect(addressEntries(undefined)).toEqual([]);
    expect(addressEntries({ name: 'Sam', address: ' Sam@X.com ' })).toEqual([{ label: 'Sam <Sam@X.com>', address: 'sam@x.com' }]);
    expect(
      addressEntries([{ name: 'Team', group: [{ address: 'b@x.com' }] }, { name: 'Only Name' }, { name: 'empty', group: [] }, { address: 'D@x.com' }]),
    ).toEqual([
      { label: 'b@x.com', address: 'b@x.com' },
      { label: 'D@x.com', address: 'd@x.com' },
    ]);
  });

  it('shows a Reply-To only when it names an address the From does not', () => {
    const from = { name: 'Smith, Sam', address: 'sam@x.com' };
    // Absent, or a copy of From (what an IMAP ENVELOPE holds when the header is absent): nothing to show.
    expect(distinctReplyTo(undefined, from)).toEqual([]);
    expect(distinctReplyTo([{ address: 'SAM@x.com' }], [from])).toEqual([]);
    // Elsewhere: the whole Reply-To, so the reader sees every address replies should reach.
    expect(distinctReplyTo([{ address: 'sam.personal@y.com' }], from)).toEqual([{ label: 'sam.personal@y.com', address: 'sam.personal@y.com' }]);
    expect(distinctReplyTo([{ address: 'sam@x.com' }, { name: 'List', address: 'list@y.com' }], from).map((e) => e.label)).toEqual([
      'sam@x.com',
      'List <list@y.com>',
    ]);
    // No From at all: any Reply-To is news.
    expect(distinctReplyTo([{ address: 'r@y.com' }], undefined)).toEqual([{ label: 'r@y.com', address: 'r@y.com' }]);
  });
});

describe('toDate', () => {
  it('parses Dates and strings, rejecting junk', () => {
    const d = new Date('2026-09-21T14:30:00Z');
    expect(toDate(d)).toBe(d);
    expect(toDate('2026-09-21T14:30:00Z')?.toISOString()).toBe('2026-09-21T14:30:00.000Z');
    expect(toDate('Mon, 21 Sep 2026 14:30:00 +0000')?.toISOString()).toBe('2026-09-21T14:30:00.000Z');
    expect(toDate('not a date')).toBeUndefined();
    expect(toDate('')).toBeUndefined();
    expect(toDate(undefined)).toBeUndefined();
  });
});

describe('hasAttachment', () => {
  it('answers from BODYSTRUCTURE without downloading', () => {
    expect(hasAttachment(undefined)).toBe(false);
    expect(hasAttachment({ type: 'text/plain' })).toBe(false);
    expect(hasAttachment({ type: 'multipart/mixed', childNodes: [] })).toBe(false);
    expect(hasAttachment({ type: 'application/pdf', disposition: 'attachment' })).toBe(true);
    expect(hasAttachment({ type: 'image/png', parameters: { name: 'a.png' } })).toBe(true);
    expect(hasAttachment({ type: 'image/png', disposition: 'inline', dispositionParameters: { filename: 'a.png' } })).toBe(true);
    expect(hasAttachment({ type: 'text/plain', parameters: { name: 'body.txt' } })).toBe(false);
    expect(hasAttachment({ type: 'text/html', disposition: 'attachment' })).toBe(true);
    expect(hasAttachment({ type: 'image/gif' })).toBe(false);
    expect(hasAttachment({ type: '', disposition: '' })).toBe(false);
    expect(
      hasAttachment({
        type: 'multipart/mixed',
        childNodes: [
          { type: 'multipart/alternative', childNodes: [{ type: 'text/plain' }, { type: 'text/html' }] },
          { type: 'application/zip', dispositionParameters: { filename: 'x.zip' } },
        ],
      }),
    ).toBe(true);
    expect(hasAttachment({ type: 'multipart/alternative', childNodes: [{ type: 'text/plain' }] })).toBe(false);
  });

  it('counts a forwarded message attached as .eml, though its own body is plain text', () => {
    // imapflow gives a message/rfc822 part its inner body structure as childNodes.
    const forwarded = {
      type: 'multipart/mixed',
      childNodes: [
        { type: 'text/plain' },
        { type: 'message/rfc822', disposition: 'attachment', childNodes: [{ type: 'text/plain' }] },
      ],
    };
    expect(hasAttachment(forwarded)).toBe(true);
    // An INLINE forwarded message is shown in the body (postal-mime inlines it), so it is not a file.
    expect(hasAttachment({ type: 'message/rfc822', disposition: 'inline', childNodes: [{ type: 'text/plain' }] })).toBe(false);
    // A (malformed) multipart marked attachment is still judged by its parts.
    expect(hasAttachment({ type: 'multipart/mixed', disposition: 'attachment', childNodes: [{ type: 'text/plain' }] })).toBe(false);
  });
});

describe('toRow', () => {
  it('builds a search row with explicit-offset dates', () => {
    const msg: FetchMessageObject = {
      seq: 1,
      uid: 42,
      envelope: {
        date: new Date('2026-09-21T14:30:00Z'),
        subject: 'Hi',
        from: [{ name: 'Alice', address: 'alice@x.com' }],
        to: [{ address: 'me@icloud.com' }],
        cc: [{ address: 'cc@x.com' }],
      },
      flags: new Set(['\\Seen']),
      internalDate: new Date('2026-09-21T14:31:00Z'),
      size: 1234,
      bodyStructure: { type: 'application/pdf', disposition: 'attachment' },
    };
    expect(toRow(msg, 'America/New_York')).toEqual({
      uid: 42,
      date: '2026-09-21T10:30:00-04:00',
      dateDisplay: 'Mon, Sep 21, 2026, 10:30 AM EDT',
      from: 'Alice <alice@x.com>',
      to: ['me@icloud.com'],
      cc: ['cc@x.com'],
      subject: 'Hi',
      seen: true,
      flagged: false,
      hasAttachments: true,
      size: 1234,
    });
  });

  it('falls back to INTERNALDATE and tolerates a bare fetch', () => {
    const row = toRow({ seq: 1, uid: 7, internalDate: '2026-01-05T12:00:00Z' }, 'UTC');
    expect(row).toEqual({
      uid: 7,
      date: '2026-01-05T12:00:00+00:00',
      dateDisplay: 'Mon, Jan 5, 2026, 12:00 PM UTC',
      to: [],
      subject: '',
      seen: false,
      flagged: false,
      hasAttachments: false,
    });
    expect(toRow({ seq: 1, uid: 8, envelope: { date: 'garbage' }, flags: new Set(['\\Flagged']) }, 'UTC')).toEqual({
      uid: 8,
      to: [],
      subject: '',
      seen: false,
      flagged: true,
      hasAttachments: false,
    });
  });

  it('carries the Reply-To when it differs from From, and not the ENVELOPE copy of From', () => {
    const base = { seq: 1, uid: 3, envelope: { subject: 'Re: Dinner?', from: [{ name: 'Smith, Sam', address: 'sam@x.com' }], to: [] } };
    expect(toRow({ ...base, envelope: { ...base.envelope, replyTo: [{ address: 'sam.personal@y.com' }] } }, 'UTC')).toMatchObject({
      from: 'Smith, Sam <sam@x.com>',
      replyTo: ['sam.personal@y.com'],
    });
    expect(toRow({ ...base, envelope: { ...base.envelope, replyTo: [{ name: 'Smith, Sam', address: 'sam@x.com' }] } }, 'UTC')).not.toHaveProperty(
      'replyTo',
    );
    expect(toRow(base, 'UTC')).not.toHaveProperty('replyTo');
  });
});

describe('specialUseWord', () => {
  it('maps iCloud names first, then server flags', () => {
    expect(specialUseWord('inbox', undefined)).toBe('inbox');
    expect(specialUseWord('Sent Messages', undefined)).toBe('sent');
    expect(specialUseWord('Deleted Messages', '\\Trash')).toBe('trash');
    expect(specialUseWord('Archive', undefined)).toBe('archive');
    expect(specialUseWord('Spam', '\\Junk')).toBe('junk');
    expect(specialUseWord('All Mail', '\\All')).toBe('all');
    expect(specialUseWord('Weird', '\\Unknown')).toBeUndefined();
    expect(specialUseWord('Work', undefined)).toBeUndefined();
  });
});
