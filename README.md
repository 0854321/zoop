# noop

Your own AI team, so your day can be a no-op.

noop runs a small team of Claude Code and Codex agents on your own computers. They do your daily work, decide what they can based on how you've decided before, and only ask you when something really needs you — with a short list of options you answer in one tap.

- **Works for you, not with you** — give it a goal in one sentence; it breaks the work down, runs it in parallel and comes back with results.
- **Learns how you decide** — starts cautious, asks more early on, and takes over more as it proves it decides like you.
- **Quiet** — no noise, no raw errors. You hear about results and decisions, nothing else.
- **Yours** — runs on your machines and your own free Cloudflare account. No shared service, no one else's server.

## Install

On an always-on Linux machine, once — it becomes the primary:

```bash
curl -fsSL https://raw.githubusercontent.com/huacnlee/noop/main/install.sh | bash -s -- --primary
```

You'll be asked to log in to your Cloudflare account once (the free plan is enough).

Add more machines whenever you like — they help when they're online and are never waited for:

```bash
# macOS
curl -fsSL https://raw.githubusercontent.com/huacnlee/noop/main/install.sh | bash
```

```powershell
# Windows
irm https://raw.githubusercontent.com/huacnlee/noop/main/install.ps1 | iex
```

## Use

Open your noop address on any device and sign in with a code sent to your email. On your phone, add it to the home screen and turn on notifications.

Then just talk to it. When it needs you, you'll get a notification with the choices; answer right there.

## License

MIT
