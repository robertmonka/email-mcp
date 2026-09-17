import type { Account, Email } from '../types/index.js';
import {
  buildReplyDraft,
  quoteOriginalText,
  replyRecipients,
  replyReferences,
  replySubject,
} from './reply-draft.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const account: Account = { name: 'test', email: 'me@example.com', fullName: 'Zoë Tester' };

const original: Email = {
  id: '123',
  subject: 'Data processing agreement',
  from: { name: 'Tom Sender', address: 'tom@example.org' },
  to: [{ name: 'Zoë Tester', address: 'me@example.com' }, { address: 'office@example.com' }],
  cc: [{ address: 'accounting@example.org' }, { address: 'me@example.com' }],
  date: '2026-09-16T08:15:00.000Z',
  seen: true,
  flagged: false,
  answered: false,
  hasAttachments: false,
  labels: [],
  messageId: '<orig-123@example.org>',
  references: ['<root@example.org>'],
  bodyText: 'Hello,\r\nplease sign the agreement.\r\n\r\nRegards\r\nTom\r\n',
  attachments: [],
  headers: {},
};

function header(raw: string, name: string): string | undefined {
  const head = raw.split('\r\n\r\n')[0];
  const match = new RegExp(`^${name}: (.*(?:\\r\\n[ \\t].*)*)`, 'mi').exec(head);
  return match ? match[1].replace(/\r\n[ \t]+/g, ' ') : undefined;
}

function decodeQuotedPrintable(body: string): string {
  const bytes = body
    .replace(/=\r\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return Buffer.from(bytes, 'latin1').toString('utf8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('replySubject', () => {
  it('prefixes Re: once, case-insensitively', () => {
    expect(replySubject('Data processing agreement')).toBe('Re: Data processing agreement');
    expect(replySubject('Re: Agreement')).toBe('Re: Agreement');
    expect(replySubject('RE: Agreement')).toBe('RE: Agreement');
    expect(replySubject(undefined)).toBe('Re: ');
  });
});

describe('replyRecipients', () => {
  it('replies to the sender only by default', () => {
    const { to, cc } = replyRecipients(original, account.email, false);
    expect(to.map((a) => a.address)).toEqual(['tom@example.org']);
    expect(cc).toEqual([]);
  });

  it('adds original To/Cc without our own address on replyAll', () => {
    const { to, cc } = replyRecipients(original, account.email, true);
    expect(to.map((a) => a.address)).toEqual(['tom@example.org', 'office@example.com']);
    expect(cc.map((a) => a.address)).toEqual(['accounting@example.org']);
  });

  it('honours Reply-To over From', () => {
    const { to } = replyRecipients(
      { ...original, replyTo: [{ address: 'desk@example.org' }] },
      account.email,
      false,
    );
    expect(to.map((a) => a.address)).toEqual(['desk@example.org']);
  });

  it('replies to the original recipients when the sender is ourselves', () => {
    const { to } = replyRecipients(
      { ...original, from: { address: account.email }, to: [{ address: 'tom@example.org' }] },
      account.email,
      false,
    );
    expect(to.map((a) => a.address)).toEqual(['tom@example.org']);
  });
});

describe('replyReferences', () => {
  it('appends the original Message-ID to its References chain', () => {
    expect(replyReferences(original)).toEqual(['<root@example.org>', '<orig-123@example.org>']);
    expect(replyReferences({ ...original, references: undefined })).toEqual([
      '<orig-123@example.org>',
    ]);
  });
});

describe('quoteOriginalText', () => {
  it('prefixes every original line with "> " below an attribution line', () => {
    expect(quoteOriginalText(original)).toBe(
      [
        'On Wed, 16 Sep 2026 08:15:00 GMT, Tom Sender <tom@example.org> wrote:',
        '> Hello,',
        '> please sign the agreement.',
        '>',
        '> Regards',
        '> Tom',
      ].join('\n'),
    );
  });
});

describe('buildReplyDraft', () => {
  it('builds a threaded plain-text reply with the original quoted', async () => {
    const draft = await buildReplyDraft(account, original, {
      body: 'Hello,\nsigned copy attached.\n\nRegards\nZoë',
    });
    const raw = draft.raw.toString('utf8');

    expect(header(raw, 'In-Reply-To')).toBe('<orig-123@example.org>');
    expect(header(raw, 'References')).toBe('<root@example.org> <orig-123@example.org>');
    expect(header(raw, 'Subject')).toBe('Re: Data processing agreement');
    expect(header(raw, 'To')).toContain('tom@example.org');
    expect(header(raw, 'Cc')).toBeUndefined();
    expect(header(raw, 'From')).toContain('me@example.com');
    expect(header(raw, 'From')).toMatch(/=\?UTF-8\?/i);
    expect(header(raw, 'Message-ID')).toBeTruthy();
    expect(header(raw, 'Date')).toBeTruthy();
    expect(header(raw, 'Content-Type')).toMatch(/text\/plain; charset=utf-8/i);
    expect(header(raw, 'Content-Transfer-Encoding')).toMatch(/quoted-printable|base64/i);

    const body = decodeQuotedPrintable(raw.split('\r\n\r\n').slice(1).join('\r\n\r\n'));
    expect(body).toContain('Hello,\nsigned copy attached.\n\nRegards\nZoë\n\nOn ');
    expect(body).toContain('Tom Sender <tom@example.org> wrote:\n> Hello,\n> please sign');

    expect(draft.subject).toBe('Re: Data processing agreement');
    expect(draft.to.map((a) => a.address)).toEqual(['tom@example.org']);
  });

  it('omits the quote when quoteOriginal is false', async () => {
    const draft = await buildReplyDraft(account, original, { body: 'OK', quoteOriginal: false });
    const body = decodeQuotedPrintable(
      draft.raw.toString('utf8').split('\r\n\r\n').slice(1).join(''),
    );
    expect(body.trim()).toBe('OK');
  });

  it('quotes the original HTML in a blockquote for HTML replies', async () => {
    const draft = await buildReplyDraft(
      account,
      { ...original, bodyHtml: '<p>Hello <b>there</b></p>' },
      { body: '<p>OK</p>', html: true },
    );
    const raw = draft.raw.toString('utf8');
    expect(header(raw, 'Content-Type')).toMatch(/text\/html/i);
    expect(raw).toContain('<blockquote');
  });
});
