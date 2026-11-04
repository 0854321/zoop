# MCP: connect Claude and ChatGPT to Noop

Noop's Cloudflare Worker serves a remote MCP server at `https://<your-noop>/mcp` (Streamable HTTP, protocol
2025-11-25 / 2025-06-18 / 2025-03-26). Claude or ChatGPT can then read the fleet's state, talk to it the way you do
in the Noop app, and receive live events.

## What it can do

| Tool | What it does |
|---|---|
| `get_status` | Online machines, running tasks with their latest activity, task counts, open decisions |
| `list_tasks` / `get_task` | Tasks by state (`open` by default) or text filter; one task in full plus its recent events |
| `list_decisions` | Decision cards waiting for you: question, options, recommendation, context |
| `get_feed` / `wait_for_events` | The feed you see in the app; `wait_for_events` blocks until something new happens |
| `list_agents` / `list_routines` | The agent roster (what each is for); the recurring routines |
| `read_memory` / `search_journal` | Durable memory (`memory/*.md`, `agents/<name>/memory.md`); the fleet's daily journal |
| `send_message` | A chat message to the fleet, as you (the chat brain answers it) |
| `create_task` | Hands work to an agent (default `lead`), optionally continuing a task (`follows`) |
| `amend_task` | Adds your follow-up to an open task (a waiting task is woken) |
| `cancel_task` (destructive) / `set_priority` / `reassign_task` | Stop a task; change its priority; give a not-yet-started task to another agent |
| `remember` | Writes a rule or preference into memory for the whole fleet or one agent |
| `answer_decision` | Answers a card, like tapping an option |
| `search` / `fetch` | ChatGPT connector / deep research shape over tasks and decisions |

Not exposed: merge, release, settings, machine credentials.

The tools are defined and implemented once, in `cloud/src/tools.ts`; the chat brain on the primary (`src/brain.ts`) uses
the same module. Over MCP, reads come from the Worker's mirror of the data files; writes other than `send_message` /
`answer_decision` are queued on the owner→fleet inbox and performed by the primary daemon (it owns the data), so they
answer `{queued: true}` and show up in the feed within seconds.

Resources: `noop://status`, `noop://feed`, `noop://decisions`, `noop://tasks/{id}` (subscribable).

### Events

Open the session's SSE stream (`GET /mcp`, which clients do on their own) and you get:

- `notifications/message` (logger `noop`) for every feed event: agent results, decisions (level `warning`),
  owner messages, system notices (level `debug`). `logging/setLevel` filters them.
- `notifications/resources/updated` for subscribed resources: a task's file changing or an event mentioning it
  (`noop://tasks/T-…`), the fleet snapshot (`noop://status`), decisions (`noop://decisions`), any event (`noop://feed`).

- `notifications/resources/list_changed` when the set of open tasks or decisions changes (re-run `resources/list`).

Transport details (Streamable HTTP, revisions 2025-06-18 and 2025-11-25):

- Every SSE message has an `id` (`<stream>.<seq>`); reconnect with `Last-Event-ID` to replay what you missed on that
  stream (kept 15 minutes / 500 messages per stream). Streams send a `retry:` hint and `: ping` keep-alives every 15 s.
- `tools/call` with `_meta.progressToken` (and `wait_for_events`) answers as `text/event-stream` when you accept it:
  `notifications/progress`, then the result. `notifications/cancelled` aborts the call and no result is sent.
- Every request after `initialize` needs `Mcp-Session-Id` (400 without it). Unknown, deleted or 24 h idle sessions get
  404, so the client initializes again. An unsupported `MCP-Protocol-Version` gets 400.

Clients that drop notifications (most chat UIs today) can call `wait_for_events` with the `cursor` from `get_feed`.

## Sign-in

Clients discover OAuth 2.1 from the 401 on `/mcp` (`/.well-known/oauth-protected-resource` →
`/.well-known/oauth-authorization-server`), register themselves (dynamic client registration) and open the sign-in
page. You enter your email and the same login code the app uses (mail, or `noop login` on your machine when mail
isn't set up). The page names the app and the site it returns to; close it if you didn't start it.

The access token is an owner session, so revoking all sessions (`POST /api/host/revoke-sessions` with the machine
key) cuts the connectors off too. Refresh tokens rotate on every use.

Local clients can skip OAuth and send `Authorization: Bearer <session or HUB_TOKEN>`.

## Claude

- **claude.ai / Claude desktop / mobile**: Settings → Connectors → Add custom connector → URL
  `https://<your-noop>/mcp` → Connect, then sign in with your email code.
- **Claude Code**: `claude mcp add --transport http noop https://<your-noop>/mcp`, then `/mcp` in a session to sign in.
  (Or skip OAuth: `claude mcp add --transport http noop https://<your-noop>/mcp --header "Authorization: Bearer <token>"`.)

## ChatGPT

Settings → Apps & Connectors → Advanced → turn on Developer mode → Create → URL `https://<your-noop>/mcp`,
authentication OAuth → sign in with your email code. Use it from a chat (pick it under "+" → Developer mode) or
deep research (`search` / `fetch`).

## Checking it

```sh
npx @modelcontextprotocol/inspector            # UI: Streamable HTTP, URL https://<your-noop>/mcp, OAuth flow
# local end to end against wrangler dev:
cd cloud && bunx wrangler dev --port 8799 --var HUB_TOKEN:machinetok
BASE=http://localhost:8799 TOKEN=machinetok bun test/cloud-auth/mcp-e2e.ts
```
