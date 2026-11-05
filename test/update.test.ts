import { expect, test } from "bun:test";
import { createUpdates, type FoundUpdate, type UpdateState } from "../app/update";

function setup(found: FoundUpdate | null) {
  const states: UpdateState[] = [];
  const calls: string[] = [];
  const api = {
    check: async () => { calls.push("check"); return found; },
    download: async () => { calls.push("download"); },
    install: async () => { calls.push("install"); },
  };
  return { api, calls, states, last: () => states[states.length - 1], updates: createUpdates(api, (s) => states.push(s)) };
}
const update = { version: "1.2.0", url: "https://example.com/a.tar.gz", canInstall: true };

test("an update is downloaded before anything shows, and only a press installs it", async () => {
  const t = setup(update);
  await t.updates.check();
  expect(t.calls).toEqual(["check", "download"]);
  expect(t.states).toEqual([{ kind: "ready", version: "1.2.0" }]);
  await t.updates.install();
  expect(t.calls).toEqual(["check", "download", "install"]);
});

test("checking again does not drop a download that waits for its restart", async () => {
  const t = setup(update);
  await t.updates.check();
  await t.updates.check();
  expect(t.calls).toEqual(["check", "download"]);
});

test("an update the app cannot install is a link, with no download", async () => {
  const t = setup({ ...update, canInstall: false });
  await t.updates.check();
  expect(t.calls).toEqual(["check"]);
  expect(t.last()).toEqual({ kind: "link", version: "1.2.0", url: update.url });
});

test("up to date shows nothing", async () => {
  const t = setup(null);
  await t.updates.check();
  expect(t.states).toEqual([]);
  await t.updates.install();
  expect(t.calls).toEqual(["check"]);
});

test("a failed check or download stays quiet, and the next check tries again", async () => {
  const t = setup(update);
  const download = t.api.download;
  t.api.download = async () => { throw new Error("offline"); };
  await t.updates.check();
  expect(t.states).toEqual([]);
  t.api.download = download;
  await t.updates.check();
  expect(t.last()).toEqual({ kind: "ready", version: "1.2.0" });
});

test("a failed install says why and can be pressed again", async () => {
  const t = setup(update);
  await t.updates.check();
  const install = t.api.install;
  t.api.install = async () => { throw new Error("no space"); };
  await t.updates.install();
  expect(t.last()).toEqual({ kind: "failed", version: "1.2.0", message: "no space" });
  t.api.install = install;
  await t.updates.install();
  expect(t.states.map((s) => s.kind)).toEqual(["ready", "installing", "failed", "installing"]);
});
