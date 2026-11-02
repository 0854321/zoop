// Test harness Worker: one DO, files API only, no auth (actor from x-actor). Mirrors how index.ts mounts the module.
import { DurableObject } from "cloudflare:workers";
import { handleFiles, initFilesSchema } from "../src/files";

interface Env { FILES: DurableObjectNamespace<FilesHarness> }

export default {
  fetch(req: Request, env: Env) { return env.FILES.get(env.FILES.idFromName("hub")).fetch(req); },
};

export class FilesHarness extends DurableObject<Env> {
  sql: SqlStorage;
  constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); this.sql = ctx.storage.sql; initFilesSchema(this.sql); }
  async fetch(req: Request) {
    const url = new URL(req.url);
    return (await handleFiles(this.sql, req, url, req.headers.get("x-actor") ?? "test")) ?? Response.json({ error: "not found" }, { status: 404 });
  }
}
