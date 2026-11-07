/** Read state of the channel, per device: everything up to `upTo` is read,
 * except what the owner marked unread by hand (kept until read again). */
export type ReadState = { upTo: string | null; marked: string[] };

type Ev = { id: string; ts: string; from: string; kind: string };

/** Messages that count: the team's, not the owner's own or the hub's quiet system lines. */
export const countsAsMessage = (e: Ev) => e.kind !== "owner" && !(e.kind === "system" && /^hub/.test(e.from));

export function isUnread(e: Ev, s: ReadState): boolean {
  if (!countsAsMessage(e)) return false;
  return s.marked.includes(e.id) || (s.upTo !== null && e.ts > s.upTo);
}

export function unreadCount(events: readonly Ev[], s: ReadState): number {
  let n = 0;
  for (const e of events) if (isUnread(e, s)) n++;
  return n;
}

/** Read everything up to the latest message; manual marks go too. */
export function markAllRead(events: readonly Ev[], s: ReadState): ReadState {
  const last = events.at(-1)?.ts ?? s.upTo;
  return { upTo: last && (!s.upTo || last > s.upTo) ? last : s.upTo, marked: [] };
}

/** Flip one message. Reading one past the cursor reads up to it, like most chat apps. */
export function toggleRead(e: Ev, s: ReadState): ReadState {
  if (isUnread(e, s)) {
    if (s.marked.includes(e.id)) return { ...s, marked: s.marked.filter((x) => x !== e.id) };
    return { upTo: e.ts, marked: s.marked };
  }
  return { ...s, marked: [...s.marked, e.id] };
}

/** Reaching the bottom reads up to there; manual marks stay. */
export function readTo(ts: string, s: ReadState): ReadState {
  return !s.upTo || ts > s.upTo ? { ...s, upTo: ts } : s;
}

export function parseMarked(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(-500) : [];
  } catch {
    return [];
  }
}

type RefEv = Ev & { ref?: string };

/** Whether `ref` (a task or card) has an unread message in the chat newer than `after`, or one marked unread by
 * hand; `undefined` when the loaded chat has no message about it. */
export function refUnread(events: readonly RefEv[], s: ReadState, ref: string, after: string): boolean | undefined {
  let known = false;
  for (const e of events) {
    if (e.ref !== ref || !countsAsMessage(e)) continue;
    known = true;
    if (s.marked.includes(e.id) || (isUnread(e, s) && e.ts > after)) return true;
  }
  return known ? false : undefined;
}
