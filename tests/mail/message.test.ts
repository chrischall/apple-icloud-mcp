import { describe, expect, it } from 'vitest';
import PostalMime from 'postal-mime';
import {
  attachmentInfo,
  buildMessage,
  extractBody,
  messageIds,
  parseMessage,
  parseRecipient,
  parseRecipients,
  quoteOriginal,
  recipientLabel,
  replyReferences,
  replySubject,
  MAX_QUOTED_CHARS,
} from '../../src/mail/message.js';
import { AppleToolError, InvalidArgumentError } from '../../src/errors.js';
import { rfc822 } from './fake-imap.js';

describe('recipients', () => {
  it('parses bare and named addresses', () => {
    expect(parseRecipient('bob@example.com', 'to[0]')).toEqual({ address: 'bob@example.com' });
    expect(parseRecipient('"Bob B" <bob@example.com>', 'to[0]')).toEqual({ name: 'Bob B', address: 'bob@example.com' });
    expect(parseRecipient('Bob <bob@example.com>', 'to[0]')).toEqual({ name: 'Bob', address: 'bob@example.com' });
    expect(parseRecipients(undefined, 'cc')).toEqual([]);
    expect(parseRecipients(['a@x.com', 'b@y.org'], 'cc')).toHaveLength(2);
    expect(recipientLabel({ name: 'Bob', address: 'b@x.com' })).toBe('Bob <b@x.com>');
  });

  it('refuses anything but exactly one plausible address', () => {
    for (const bad of ['bob', 'a@x.com, b@x.com', 'Team: a@x.com;', 'bob@localhost', '<>']) {
      expect(() => parseRecipient(bad, 'to[0]'), bad).toThrow(InvalidArgumentError);
    }
    expect(() => parseRecipient('bob@x.com\r\nBcc: evil@x.com', 'to[0]')).toThrow(/control characters/);
    expect(() => parseRecipient('bob@x.com\r\nBcc: evil@x.com', 'to[0]')).toThrow('to[0]: "bob@x.com??Bcc: evil@x.com" contains control characters.');
    expect(() => parseRecipients(['ok@x.com', 'nope'], 'bcc')).toThrow(/bcc\[1\]/);
  });

  it('refuses two addresses run together, which would reach only one of them', () => {
    // addressparser reads each of these as ONE mailbox named after the other address.
    for (const bad of ['a@b.com c@d.com', '<a@b.com> <c@d.com>', 'Bob <a@b.com> c@d.com', 'bob@example.com <eve@evil.com>', 'a@b.com (x@y.com)']) {
      expect(() => parseRecipient(bad, 'to[0]'), bad).toThrow(/is not a single email address/);
    }
    // A QUOTED name may look like anything; it is shown next to the real address in the preview.
    expect(parseRecipient('"bob@example.com" <eve@evil.com>', 'to[0]')).toEqual({ name: 'bob@example.com', address: 'eve@evil.com' });
    expect(parseRecipient('"Say \\"hi\\" a@b.com" <c@d.com>', 'to[0]')).toEqual({ name: 'Say "hi" a@b.com', address: 'c@d.com' });
    expect(parseRecipient('a@b.com (work)', 'to[0]')).toEqual({ name: 'work', address: 'a@b.com' });
  });
});

describe('buildMessage', () => {
  it('builds CRLF messages with fixed Message-ID/Date, Bcc only in the Sent copy', async () => {
    const now = new Date('2026-09-26T12:00:00Z');
    const built = await buildMessage(
      {
        from: 'me@icloud.com',
        to: [{ name: 'Bob', address: 'bob@example.com' }],
        cc: [{ address: 'carol@example.com' }],
        bcc: [{ address: 'secret@example.com' }],
        subject: 'Re: Plans ✓',
        text: 'Line one\nLine two',
        inReplyTo: '<orig@example.com>',
        references: ['<root@example.com>', '<orig@example.com>'],
      },
      now,
    );
    const raw = built.raw.toString();
    const copy = built.sentCopy.toString();
    expect(built.messageId).toMatch(/^<[0-9a-f-]{36}@icloud\.com>$/);
    expect(built.date).toBe(now);
    expect(built.envelope).toEqual({ from: 'me@icloud.com', to: ['bob@example.com', 'carol@example.com', 'secret@example.com'] });
    expect(raw).toContain(`Message-ID: ${built.messageId}`);
    expect(copy).toContain(`Message-ID: ${built.messageId}`);
    expect(raw).toContain('In-Reply-To: <orig@example.com>');
    expect(raw).toContain('References: <root@example.com> <orig@example.com>');
    expect(raw).not.toMatch(/^Bcc:/m);
    expect(copy).toMatch(/^Bcc: secret@example.com/m);
    expect(raw).not.toMatch(/[^\r]\n/);
    const parsed = await PostalMime.parse(built.raw);
    expect(parsed.subject).toBe('Re: Plans ✓');
    expect(parsed.text?.replace(/\r\n/g, '\n').trim()).toBe('Line one\nLine two');
    expect(parsed.date).toBe('2026-09-26T12:00:00.000Z');
  });

  it('omits empty cc/bcc and threading headers', async () => {
    const built = await buildMessage({ from: 'me@icloud.com', to: [{ address: 'b@x.com' }], cc: [], bcc: [], subject: 'S', text: 'T' });
    const raw = built.raw.toString();
    expect(raw).not.toMatch(/^(Cc|Bcc|In-Reply-To|References):/m);
    expect(built.envelope.to).toEqual(['b@x.com']);
    expect(Number.isNaN(built.date.getTime())).toBe(false);
  });
});

describe('reply helpers', () => {
  it('prefixes Re: once', () => {
    expect(replySubject('Plans')).toBe('Re: Plans');
    expect(replySubject('RE: Plans')).toBe('RE: Plans');
    expect(replySubject('re : x')).toBe('re : x');
    expect(replySubject(undefined)).toBe('Re:');
  });

  it('extracts and chains message ids', () => {
    expect(messageIds(undefined)).toEqual([]);
    expect(messageIds('no ids here')).toEqual([]);
    expect(messageIds('<a@x> <b@x>\r\n <c@x>')).toEqual(['<a@x>', '<b@x>', '<c@x>']);
    expect(replyReferences('<a@x> <b@x>', '<c@x>')).toEqual(['<a@x>', '<b@x>', '<c@x>']);
    expect(replyReferences('<a@x> <c@x>', '<c@x>')).toEqual(['<a@x>', '<c@x>']);
    expect(replyReferences(undefined, undefined)).toEqual([]);
    const long = Array.from({ length: 30 }, (_, i) => `<m${i}@x>`).join(' ');
    const refs = replyReferences(long, '<last@x>');
    expect(refs).toHaveLength(20);
    expect(refs[19]).toBe('<last@x>');
  });

  it('quotes the original, cutting very long ones', () => {
    expect(quoteOriginal('a\r\n\r\nb\n\n', 'On Mon, Bob wrote:')).toEqual({ quoted: 'On Mon, Bob wrote:\n> a\n>\n> b', truncated: false });
    const big = quoteOriginal('x'.repeat(MAX_QUOTED_CHARS + 5), 'On:');
    expect(big.truncated).toBe(true);
    expect(big.quoted.endsWith('\n> […]')).toBe(true);
  });
});

describe('reading', () => {
  it('prefers the text part and cuts at maxChars', async () => {
    const email = await parseMessage(Buffer.from(rfc822({ text: 'Hello\r\nWorld', html: '<p>HTML</p>' })));
    expect(extractBody(email, 100)).toEqual({ format: 'text', text: 'Hello\nWorld', totalChars: 11, truncated: false });
    expect(extractBody(email, 5)).toEqual({ format: 'text', text: 'Hello', totalChars: 11, truncated: true });
  });

  it('converts HTML-only bodies with the safe converter', async () => {
    const email = await parseMessage(Buffer.from(rfc822({ html: '<style>x{}</style><p>Hi <b>there</b></p><div style="display:none">hidden</div>' })));
    expect(email.text).toBeUndefined();
    expect(extractBody(email, 100)).toEqual({ format: 'html', text: 'Hi there', totalChars: 8, truncated: false });
  });

  it('a message postal-mime refuses to parse is an upstream error, not an internal one', async () => {
    // More than 2 MiB of headers: postal-mime rejects the parse outright.
    const huge = Buffer.from(`Subject: x\r\nX-Pad: ${'a'.repeat(2 * 1024 * 1024 + 10)}\r\n\r\nbody`);
    const err = await parseMessage(huge).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppleToolError);
    expect(err).toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect((err as AppleToolError).message).toMatch(/^The message could not be read: /);
  });

  it('reports no body', () => {
    expect(extractBody({ text: '  ', html: '' }, 10)).toEqual({ format: 'none', text: '', totalChars: 0, truncated: false });
    // An empty comment ("<!-->") must not swallow the rest of an HTML-only body behind truncated:false.
    expect(extractBody({ html: '<p>Hello</p><!-->WARNING: this is phishing<p>Pay now</p>' }, 10_000)).toMatchObject({
      text: 'Hello\n\nWARNING: this is phishing\n\nPay now',
      truncated: false,
    });
    expect(extractBody({}, 10).format).toBe('none');
  });

  it('lists attachments without their bytes', async () => {
    const email = await parseMessage(
      Buffer.from(rfc822({ attachment: { filename: 'report.pdf', type: 'application/pdf', content: '%PDF-1.4 fake' } })),
    );
    expect(attachmentInfo(email)).toEqual([{ filename: 'report.pdf', mimeType: 'application/pdf', size: 13 }]);
    expect(
      attachmentInfo({
        attachments: [
          { filename: null, mimeType: 'image/png', disposition: 'inline', content: 'abc', encoding: 'utf8' },
          { filename: 'x', mimeType: 'image/gif', disposition: null, related: true, content: new Uint8Array(4) },
        ],
      }),
    ).toEqual([
      { mimeType: 'image/png', size: 3, inline: true },
      { filename: 'x', mimeType: 'image/gif', size: 4, inline: true },
    ]);
  });
});
