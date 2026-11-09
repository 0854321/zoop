# Guest workers (shared / public machines)

A guest worker is a low-trust Noop worker for machines you share with other people, such as a Windows test box several
people's accounts log into. It is built so that the machine can neither read your fleet's memory nor be used to attack
your Noop deployment.

| | regular worker | guest worker |
|---|---|---|
| credential | shared machine key (`HUB_TOKEN`) | its own token, revocable per guest |
| hub files (memory, policies, journal, decisions, tasks) | full mirror, read/write | none |
| chat, settings, export/import, sign-in admin | yes | no |
| tasks | anything routed to it | only tasks explicitly assigned to that guest |
| results | applied by the fleet | stored as untrusted; the primary reviews them |
| GitHub / model credentials | the fleet's | none of ours; the machine's own model login |

## Set up
1. On the primary (or any trusted machine): `noop guest invite "shared-win-1"` prints a one-time join command valid
   for 10 minutes.
2. On the shared machine, in the account that will run it: `noop guest join <url> <code>`, then `noop guest run`.
   The token lives in `NOOP_GUEST_HOME` (default `~/.noop-guest`). Each person/OS account on a shared machine uses its
   own home, so their guests never see each other's tasks or tokens.

## Use
- `noop guest assign G-xxxx T-1234 "Run the Windows install test" -b "steps…" --repo https://github.com/o/r`
  queues a self-contained task for that guest. Write the body for the guest: it gets nothing else (no memory, no
  owner profile, no other tasks).
- `noop guest results [--ack]` shows finished results (text and `git diff`), marked UNTRUSTED. Review before using any
  patch; nothing is merged or applied automatically.
- `noop guest list` · `noop guest revoke G-xxxx` (immediate; its queued tasks are dropped).

## Limits
Results are capped at 256 KB, tasks at 32 KB, 20 queued tasks per guest; a claimed task with no result returns to the
queue after 6 hours. Anyone with access to the guest's home folder can act as that guest, which only lets them take
the tasks assigned to it and send back results that are reviewed anyway.
