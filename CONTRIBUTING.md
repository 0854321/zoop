# Contributing to noop

Technical reference for people and AI agents working on this codebase.

## Principles

- Single owner. noop serves one person (the CEO); there is no multi-tenant or shared service. Each user deploys their own Cloudflare Worker.
- No personal data or secrets in this repository. Templates are generic.
- Everything is Bun + TypeScript. The client is written with NSH.
- The owner only sees results and decisions. Never surface raw errors, internal routine failures or test data.

## Docs

- [docs/architecture.md](docs/architecture.md) — how noop works: sync, Worker API, code layout, agents and safety.

## Development

```bash
bun install
bun test                 # unit + sync tests
bash test/e2e.sh         # offline end to end (fake CLI, HUB_SYNC_FAKE store)
bunx tsc --noEmit
```

Worker:

```bash
cd cloud && bunx wrangler dev --port 8799 --var HUB_TOKEN:test
bun cloud/test/run.ts http://127.0.0.1:8799      # file sync harness (see cloud/test)
```

App: `cd app && ~/work/nsh/target/debug/nsh test` and `./build-web.sh`.

Do not run tests against a production Worker or a live `DATA` directory.
