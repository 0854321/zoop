/** The owner's latest answer to a card ("D-0116 A" → "A"), or null while unanswered. */
export function answerOf(events: { kind: string; text: string; ref?: string }[], ref: string): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind !== "owner") continue;
    const m = e.text.match(/^\s*([DLP]-[A-Z]?\d{4})\s+(.+)$/s);
    if (m && m[1] === ref) return m[2].trim();
    if (!m && e.ref === ref) return e.text.trim();
  }
  return null;
}
