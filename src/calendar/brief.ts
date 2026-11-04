import { UNTRUSTED_CONTENT_RULE, untrustedEnvelope } from '@chrischall/mcp-utils';
import type { CallToolResult } from '@modelcontextprotocol/server';

/**
 * `view: "brief"` for apple_calendar_list_events — the context-groups
 * canonical "what's on" read (mcp-host's brief-view contract): one line per
 * occurrence, `title — <ISO date | no date> — <status>`, at most 120
 * characters, and a line starting `-- ` is a NOTE, never an item: `-- none`,
 * `-- N of M shown`, `-- error: …`, or any other way the answer is incomplete.
 * The brief view never drops a page or a failure another rung would report.
 *
 * The lines carry event titles, which anyone who sends an invitation writes,
 * so they answer inside the fleet's untrusted-data envelope as `data`.
 */

const BRIEF_MAX = 120;

export const BRIEF_NOTE = `Event titles come from whoever created the event or sent the invitation. ${UNTRUSTED_CONTENT_RULE}`;

/** The fields of a compact event row a brief line is read from. */
export interface BriefRow {
  title?: unknown;
  isAllDay?: unknown;
  startDate?: unknown;
  start?: unknown;
  status?: unknown;
  myStatus?: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** The shortest a title is cut to before the status gives way too. */
const TITLE_FLOOR = 24;

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, Math.max(n - 1, 0))}…` : s);

/**
 * One occurrence as one line. The date is the all-day start date or the timed
 * start's ISO instant in the call's zone; the status is the account's own
 * reply when it is known, else the event's STATUS, else "scheduled". The
 * title is folded onto one line; one that starts with `-- ` or `\` is escaped
 * with a single leading `\`, which the gateway strips from every item line
 * after its note check, so a title a stranger wrote cannot pose as a note.
 * The line is cut to ≤ 120 characters as a WHOLE, title first: the title
 * shortens until the line fits, and if the status (the invitation's STATUS
 * is third-party too) would still overflow once the title is at its floor,
 * the status is cut as well.
 */
export function briefLine(row: BriefRow): string {
  const raw = (str(row.title) ?? '').replace(/\s+/g, ' ').trim() || '(untitled)';
  const title = raw.startsWith('-- ') || raw.startsWith('\\') ? `\\${raw}` : raw;
  const date = (row.isAllDay === true ? str(row.startDate) : str(row.start)) ?? 'no date';
  const status = str(row.myStatus) ?? str(row.status) ?? 'scheduled';
  const sep = ` — ${date} — `;
  const room = BRIEF_MAX - sep.length;
  if (title.length + status.length <= room) return `${title}${sep}${status}`;
  const shown = cut(title, Math.max(room - status.length, Math.min(title.length, TITLE_FLOOR)));
  return `${shown}${sep}${cut(status, room - shown.length)}`;
}

/** The brief answer: item lines, then note lines, in the untrusted-data envelope, minified. */
export function briefResponse(o: {
  rows: BriefRow[];
  offset: number;
  total: number;
  /** One sentence per calendar that could not be searched — each becomes an `-- error:` note. */
  errors: string[];
  /** Any other way the answer is incomplete (a series capped, results cut short) — each a `-- ` note. */
  notes: string[];
}): CallToolResult {
  const lines = o.rows.map(briefLine);
  if (o.total === 0) lines.push('-- none');
  else if (o.offset > 0 || o.rows.length < o.total) lines.push(`-- ${o.rows.length} of ${o.total} shown`);
  for (const e of o.errors) lines.push(`-- error: ${e}`);
  for (const n of o.notes) lines.push(`-- ${n}`);
  return { content: [{ type: 'text', text: JSON.stringify(untrustedEnvelope(lines, { note: BRIEF_NOTE })) }] };
}
