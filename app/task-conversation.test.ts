import { expect, test } from "nsh/test";
import { taskConversation, type TaskInfo, type HubEvent } from "./hub";

test("task request, intervening results and follow-ups share chronological order", () => {
  const task: TaskInfo = { id: "T-1004", title: "Thread", agent: "lead", created: "2026-11-08T01:00:00Z", request: "Original request", runs: [
    { ts: "2026-11-08T02:00:00Z", host: "linux", cli: "codex", status: "waiting", summary: "First result" },
    { ts: "2026-11-09T02:00:00Z", host: "linux", cli: "codex", status: "done", summary: "Final result" },
  ] };
  const events: HubEvent[] = [{ id: "followup", ts: "2026-11-09T09:00:00+08:00", from: "owner", kind: "owner", text: "Follow-up" },
    { id: "final", ts: "2026-11-09T02:00:00Z", from: "lead", kind: "notice", text: "Final result" }];
  expect(taskConversation(task, events).map((e) => e.text)).toEqual(["Original request", "First result", "Follow-up", "Final result"]);
  expect(events).toHaveLength(2);
});
