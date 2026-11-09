import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const background of [false, true]) {
  test(`a claimed task disappearing releases its worker slot (background=${background})`, () => {
    // Isolate module mocks and daemon counters from the rest of the suite.
    const proc = Bun.spawnSync([process.execPath, "--preload", "./test/preload.ts", "--eval", `
      import { mock } from "bun:test";
      import assert from "node:assert/strict";
      import { mkdirSync } from "node:fs";
      const core = { ...await import("./src/core") };
      const accounts = { ...await import("./src/accounts") };
      const resources = { ...await import("./src/resources") };
      const github = { ...await import("./src/github") };
      const busy = [];
      let next = null, claimed = 0, errors = 0, rejected = 0;
      mkdirSync(core.P("journal"), { recursive: true });
      mock.module("./src/core", () => ({
        ...core,
        hostName: () => "worker",
        heartbeat: (_cfg, count) => busy.push(count),
        pickTask: () => next,
        claim: async () => {
          const active = core.P("tasks", "active", next);
          next = null;
          claimed++;
          return active; // Sync removed the claimed file before the worker could read it.
        },
      }));
      mock.module("./src/accounts", () => ({
        ...accounts,
        pickAccount: () => ({ cli: "codex", name: "test", dir: "" }),
        pendingLoginIds: () => new Set(),
        retryLogins: async () => {},
      }));
      mock.module("./src/resources", () => ({
        ...resources,
        sample: () => ({ loadRatio: 0 }),
        allowedParallel: () => 1,
        canRunHeavy: () => true,
        ensureDisk: async () => {},
      }));
      mock.module("./src/github", () => ({ ...github, githubStarved: async () => ({ starved: false }) }));
      console.error = () => { errors++; };
      const { tick } = await import("./src/cli");
      const cfg = { fleet: { primary: "primary" } };
      for (const id of ["T-example-a.md", "T-example-b.md"]) {
        next = id;
        await tick(cfg, ${background}).catch(() => { rejected++; });
        await Bun.sleep(0); // Let background workers finish their catch/finally chain.
      }
      await tick(cfg, ${background});
      assert.deepEqual(busy, [0, 0, 0]);
      assert.equal(rejected, 0);
      assert.equal(claimed, 2); // The next tick can claim work after the first failure.
      assert.equal(errors, 2); // Both read failures reached the worker's error handler.
    `], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    expect(proc.stderr.toString()).toBe("");
    expect(proc.exitCode).toBe(0);
  });
}
