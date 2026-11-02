// Runs before every test file: point the hub at a throwaway home/data dir so no test can touch a real ~/.noop or ~/.agent-hub.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const W = mkdtempSync(join(tmpdir(), "hub-test-"));
process.env.NOOP_HOME = join(W, "home");
process.env.HUB_DATA = join(W, "data");
process.env.HUB_SYNC = "local";
