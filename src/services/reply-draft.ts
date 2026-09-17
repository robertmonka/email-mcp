/**
 * Reply-draft builder — composes a threaded reply to an existing message as an
 * RFC 5322 MIME document suitable for APPEND to the Drafts folder.
 *
 * Pure functions, no IMAP/SMTP dependency — fully unit-testable.
 */

import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { Account, Email, EmailAddress } from '../types/index.js';

export interface ReplyDraftOptions {
  body: string;
  replyAll?: boolean;
  html?: boolean;
  quoteOriginal?: boolean;
}

export interface ReplyDraftMessage {
  raw: Buffer;
  subject: string;
  to: EmailAddress[];
  cc: EmailAddress[];
  references: string[];
}

function formatAddress(addr: EmailAddress | undefined): string {
  if (!addr?.address) return '';
  return addr.name ? `"${addr.name.replace(/"/g, "'")}" <${addr.address}>` : addr.address;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Prefix the subject with "Re:" unless it already carries one (any case). */
export function replySubject(subject: string | undefined): string {
  const base = subject ?? '';
  return /^re:\s*/i.test(base) ? base : `Re: ${base}`;
}

/**
 * Recipients of a reply, mirroring a mail client's Reply / Reply All:
 * Reply-To (or From) goes to To; with replyAll the original To/Cc follow,
 * minus our own address and duplicates. Replying to our own sent message
 * falls back to its original recipients.
 */
export function replyRecipients(
  original: Pick<Email, 'from' | 'to' | 'cc' | 'replyTo'>,
  accountEmail: string,
  replyAll: boolean,
): { to: EmailAddress[]; cc: EmailAddress[] } {
  const self = accountEmail.toLowerCase();
  const seen = new Set<string>();
  const to: EmailAddress[] = [];
  const cc: EmailAddress[] = [];

  const push = (list: EmailAddress[], addr: EmailAddress | undefined, skipSelf: boolean): void => {
    const key = (addr?.address ?? '').toLowerCase();
    if (!addr || !key || seen.has(key) || (skipSelf && key === self)) return;
    seen.add(key);
    list.push(addr);
  };

  const primary = original.replyTo?.length ? original.replyTo : [original.from];
  primary.forEach((addr) => {
    push(to, addr, true);
  });

  if (replyAll) {
    original.to.forEach((addr) => {
      push(to, addr, true);
    });
    (original.cc ?? []).forEach((addr) => {
      push(cc, addr, true);
    });
  }

  if (to.length === 0) {
    original.to.forEach((addr) => {
      push(to, addr, false);
    });
  }
  if (to.length === 0) push(to, original.from, false);

  return { to, cc };
}

/** References chain for the reply: the original's References plus its Message-ID. */
export function replyReferences(original: Pick<Email, 'references' | 'messageId'>): string[] {
  return [...(original.references ?? []), original.messageId].filter(Boolean);
}

function attributionLine(original: Pick<Email, 'from' | 'date'>): string {
  const date = new Date(original.date);
  const when = Number.isNaN(date.getTime()) ? original.date : date.toUTCString();
  const who = original.from.name
    ? `${original.from.name} <${original.from.address}>`
    : original.from.address;
  return `On ${when}, ${who} wrote:`;
}

/** Plain-text quote of the original message: attribution line + "> " prefixed lines. */
export function quoteOriginalText(original: Pick<Email, 'from' | 'date' | 'bodyText'>): string {
  const text = (original.bodyText ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
  const lines = text.length > 0 ? text.split('\n') : [];
  return [
    attributionLine(original),
    ...lines.map((line) => (line.length > 0 ? `> ${line}` : '>')),
  ].join('\n');
}

/** HTML quote of the original message: attribution line + <blockquote>. */
export function quoteOriginalHtml(
  original: Pick<Email, 'from' | 'date' | 'bodyText' | 'bodyHtml'>,
): string {
  const inner =
    original.bodyHtml ??
    `<pre>${escapeHtml((original.bodyText ?? '').replace(/\r\n/g, '\n'))}</pre>`;
  return `<div>${escapeHtml(attributionLine(original))}</div>\n<blockquote type="cite" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${inner}</blockquote>`;
}

/**
 * Build the raw MIME reply. Threading headers (In-Reply-To, References),
 * "Re:" subject, recipients and the quoted original are derived from the
 * original message exactly as a mail client's Reply button would do.
 */
export async function buildReplyDraft(
  account: Account,
  original: Email,
  options: ReplyDraftOptions,
): Promise<ReplyDraftMessage> {
  const { to, cc } = replyRecipients(original, account.email, options.replyAll === true);
  const subject = replySubject(original.subject);
  const references = replyReferences(original);
  const quote = options.quoteOriginal !== false;

  const content = options.html
    ? { html: quote ? `${options.body}\n<br><br>\n${quoteOriginalHtml(original)}` : options.body }
    : { text: quote ? `${options.body}\n\n${quoteOriginalText(original)}` : options.body };

  const mail = new MailComposer({
    from: formatAddress({ name: account.fullName ?? '', address: account.email }),
    to: to.map(formatAddress).join(', '),
    cc: cc.length > 0 ? cc.map(formatAddress).join(', ') : undefined,
    subject,
    inReplyTo: original.messageId || undefined,
    references: references.length > 0 ? references.join(' ') : undefined,
    ...content,
  });

  const raw = await mail.compile().build();
  return { raw, subject, to, cc, references };
}
