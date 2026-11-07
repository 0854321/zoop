import { expect, test } from "bun:test";
import { createTimelineWindow } from "../app/timeline";
const event = (n: number) => ({ id: `${n}`, ts: new Date(n * 1000).toISOString(), from: "agent", kind: "notice", text: `Message ${n}` });

test("initial history is paged, live arrivals keep the first visible message and load-more works", () => {
  const window = createTimelineWindow(200);
  const events = Array.from({ length: 250 }, (_, i) => event(i));
  window.update([], false, 200, true, 0);
  expect(window.update(events, false, 200, true, 0)).toBe(50);
  expect(window.update(events, true, 200, true, 0)).toBe(50);
  expect(window.takeArrival("249", 0)).toBe(false);
  events.push(event(250));
  expect(window.update(events, true, 200, true, 10)).toBe(50);
  expect(window.takeArrival("250", 10)).toBe(true);
  expect(window.takeArrival("250", 10)).toBe(false);
  expect(window.update(events, true, 400, true, 20)).toBe(0);
  expect(window.takeArrival("1", 20)).toBe(false);
});

test("arrivals while reading history or away do not animate; recycled/off-screen rows do not replay", () => {
  const window = createTimelineWindow(200);
  window.update([event(1)], true, 200, true, 0);
  window.update([event(1), event(2)], true, 200, false, 10);
  expect(window.takeArrival("2", 10)).toBe(false);
  window.update([event(1), event(2), event(3)], true, 200, true, 20);
  expect(window.takeArrival("3", 1000)).toBe(false);
  window.update([event(0), event(1), event(2), event(3)], true, 400, true, 1000);
  expect(window.takeArrival("0", 1000)).toBe(false);
});

test("the first message in an initially empty loaded channel animates", () => {
  const window = createTimelineWindow(200);
  window.update([], true, 200, true, 0);
  expect(window.update([event(1)], true, 200, true, 10)).toBe(0);
  expect(window.takeArrival("1", 10)).toBe(true);
});
