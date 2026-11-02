#!/usr/bin/env bun
// One-off: strip git conflict markers left in the data dir by the old git sync (pull --rebase --autostash).
//   bun scripts/clean-conflict-markers.ts [--dry-run] [--keep-both] [data-dir]
// Append-only files (journal/, memory/lessons.md, …): both sides are kept (first side, then the second side's lines
// not already in the first). Other files: the first side (HEAD / "Updated upstream") is kept and the dropped side
// is printed; pass --keep-both to keep both sides there too. Files are only rewritten without --dry-run.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { appendOnly } from "../src/sync";

const args = process.argv.slice(2);
const dry = args.includes("--dry-run"), keepBoth = args.includes("--keep-both");
const dir = args.find((a) => !a.startsWith("--")) ?? process.env.HUB_DATA ?? join(homedir(), ".agent-hub", "data");

const START = /^<{7}( |$)/, MID = /^={7}$/, END = /^>{7}( |$)/;

function walk(d: string, out: string[] = []): string[] {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    // logs/ is machine-local (never synced) and run logs merely quote files; leave them untouched
    if (e.name === ".git" || e.name === "node_modules" || (d === dir && e.name === "logs")) continue;
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && statSync(p).size < 5_000_000) out.push(p);
  }
  return out;
}

type Hunk = { line: number; ours: string[]; theirs: string[]; oursLabel: string; theirsLabel: string; kept: string[] };

export function clean(text: string, both: boolean): { text: string; hunks: Hunk[] } {
  const lines = text.split("\n"), out: string[] = [], hunks: Hunk[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!START.test(lines[i])) { out.push(lines[i]); continue; }
    const h: Hunk = { line: i + 1, ours: [], theirs: [], oursLabel: lines[i].slice(8), theirsLabel: "", kept: [] };
    let j = i + 1, side: "ours" | "theirs" = "ours";
    for (; j < lines.length && !END.test(lines[j]); j++) {
      if (side === "ours" && MID.test(lines[j])) { side = "theirs"; continue; }
      h[side].push(lines[j]);
    }
    if (j >= lines.length) { out.push(lines[i]); continue; } // unterminated: leave as is
    h.theirsLabel = lines[j].slice(8);
    const seen = new Set(h.ours);
    h.kept = both ? [...h.ours, ...h.theirs.filter((l) => !seen.has(l))] : h.ours;
    out.push(...h.kept);
    hunks.push(h);
    i = j;
  }
  return { text: out.join("\n"), hunks };
}

let files = 0;
for (const p of walk(dir)) {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(p)); } catch { continue; }
  if (!text.split("\n").some((l) => START.test(l))) continue;
  const rel = relative(dir, p), both = keepBoth || appendOnly(rel);
  const r = clean(text, both);
  if (!r.hunks.length) continue;
  files++;
  console.log(`\n${rel}  (${both ? "keep both sides" : "keep first side"}, ${r.hunks.length} hunk${r.hunks.length > 1 ? "s" : ""})`);
  for (const h of r.hunks) {
    console.log(`  line ${h.line}: <<< ${h.oursLabel} (${h.ours.length} lines) | >>> ${h.theirsLabel} (${h.theirs.length} lines) → keeps ${h.kept.length} lines`);
    const dropped = h.theirs.filter((l) => !h.kept.includes(l));
    for (const l of dropped) console.log(`    - drop: ${l.slice(0, 140)}`);
  }
  if (!dry) writeFileSync(p, r.text);
}
console.log(`\n${files} file(s) ${dry ? "would be cleaned (dry run, nothing written)" : "cleaned"} in ${dir}`);
