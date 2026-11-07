/** Keep the start of an open conversation fixed. Sliding a 200-message window
 * on every append removes and inserts at both ends, invalidating List's entire
 * measured range. Initial history stays paged; live messages extend this window. */
export function createTimelineWindow(pageSize: number) {
  let start: number | undefined;
  let previous = new Set<string>();
  let latest = "";
  const arrivals = new Map<string, number>();
  return {
    update(events: readonly { id: string; ts: string }[], loaded: boolean, limit: number, animate: boolean, now = Date.now()) {
      for (const [id, until] of arrivals) if (until < now) arrivals.delete(id);
      if (start !== undefined && animate) {
        for (const event of events) {
          if (!previous.has(event.id) && event.ts > latest) arrivals.set(event.id, now + 500);
        }
      }
      previous = new Set(events.map((event) => event.id));
      latest = events.at(-1)?.ts ?? latest;
      const initial = Math.max(0, events.length - pageSize);
      if (loaded && start === undefined) start = initial;
      return Math.max(0, (start ?? initial) - (limit - pageSize));
    },
    // Consumed by the keyed row, not the reusable List cell. Scrolling back to
    // a message must never replay its entrance; off-screen arrivals expire.
    takeArrival(id: string, now = Date.now()) {
      const until = arrivals.get(id);
      arrivals.delete(id);
      return until !== undefined && now <= until;
    },
  };
}
