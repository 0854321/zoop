// Runs before any test file: src/core resolves DATA at import time, so point it at a throwaway dir
// (never the owner's ~/.agent-hub/data) and keep sync local.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.HUB_DATA) process.env.HUB_DATA = join(mkdtempSync(join(tmpdir(), "hub-test-")), "data");
process.env.HUB_SYNC = "local";
