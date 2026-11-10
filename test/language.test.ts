// `[owner] language = "en"` turns the fleet's prompts and owner-facing cards English; without it nothing changes.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { P, L, loadConfig } from "../src/core";
import { cardFor } from "../src/supervisor";
import { buildPrompt } from "../src/runner";
import { systemPrompt } from "../src/brain";
import { L as workerL, setLang } from "../cloud/src/i18n";

mkdirSync(P("agents"), { recursive: true });
const HAN = /\p{Script=Han}/u;
const english = () => { mkdirSync(P(), { recursive: true }); writeFileSync(P("config.toml"), `[owner]\nname = "Sabin"\nlanguage = "en"\n`); };
afterEach(() => { rmSync(P("config.toml"), { force: true }); setLang(); });

test("Simplified Chinese stays the default", () => {
  expect(L("a", "b")).toBe("b");
  expect(cardFor("slow:box", [{ id: "T-1", title: "x", reasons: ["r"] }]).question).toMatch(HAN);
  expect(buildPrompt({ id: "T-1", title: "x", agent: "lead" }, "b", loadConfig())).toContain("Simplified Chinese unless");
});

test("language = en gives English prompts and cards", () => {
  english();
  for (const cause of ["slow:box", "platform:os:macos", "host:box", "no-wait"]) {
    const card = cardFor(cause, [{ id: "T-1", title: "x", reasons: ["r"] }]);
    expect(JSON.stringify(card)).not.toMatch(HAN);
    expect(card.question).toContain("what to do with 1 task");
  }
  const prompt = buildPrompt({ id: "T-1", title: "x", agent: "lead" }, "b", loadConfig());
  expect(prompt).toContain("(English unless the owner writes otherwise)");
  expect(prompt).not.toContain("Simplified Chinese");
  expect(prompt.slice(prompt.indexOf("Finish the work"))).not.toMatch(HAN); // the journal above it is data other tests wrote
  const sys = systemPrompt();
  expect(sys).toContain("(Sabin, CEO)");
  expect(sys).not.toContain("Jason");
  expect(sys).not.toMatch(HAN);
});

test("the Worker follows HUB_LANG", () => {
  expect(workerL("a", "b")).toBe("b");
  setLang("en");
  expect(workerL("a", "b")).toBe("a");
});
