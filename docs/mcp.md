# MCP: connect Claude and ChatGPT to noop

noop's Cloudflare Worker serves a remote MCP server at `https://<your-noop>/mcp` (Streamable HTTP, protocol
2025-11-25 / 2025-06-18 / 2025-03-26). Claude or ChatGPT can then read the fleet's state, talk to it the way you do
in the noop app, and receive live events.

## What it can do

| Tool | What it does |
|---|---|
| `get_status` | Online machines, running tasks with their latest activity, task counts, open decisions |
| `list_tasks` / `get_task` | Tasks by state (`open` by default) or text filter; one task in full plus its recent events |
| `list_decisions` | Decision cards waiting for you: question, options, recommendation, context |
| `get_feed` / `wait_for_events` | The feed you see in the app; `wait_for_events` blocks until something new happens |
| `send_message` | A chat message to the fleet, as you |
| `create_task` | Posts a request; the lead agent plans it and reports back in the feed |
| `answer_decision` | Answers a card, like tapping an option |
| `search` / `fetch` | ChatGPT connector / deep research shape over tasks and decisions |

Not exposed: merge, release, settings, machine credentials.

Resources: `noop://status`, `noop://feed`, `noop://decisions`, `noop://tasks/{id}` (subscribable).

### Events

Open the session's SSE stream (`GET /mcp`, which clients do on their own) and you get:

- `notifications/message` (logger `noop`) for every feed event: agent results, decisions (level `warning`),
  owner messages, system notices (level `debug`). `logging/setLevel` filters them.
- `notifications/resources/updated` for subscribed resources: a task's file changing or an event mentioning it
  (`noop://tasks/T-…`), the fleet snapshot (`noop://status`), decisions (`noop://decisions`), any event (`noop://feed`).

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
