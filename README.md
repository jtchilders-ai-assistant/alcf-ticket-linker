# ALCF Ticket Linker

A private Slack-hosted app that finds `REQ-<digits>` identifiers in Slack
messages and replies with direct links to the ALCF support portal.

---

## Behavior

Whenever a user posts a message containing one or more ALCF support request
identifiers — for example `REQ-13981` or `req-14002` (case-insensitive) — the
app replies in the same thread with one link per unique ticket:

```
REQ-13981: <https://support.alcf.anl.gov/helpdesk/tickets/13981>
REQ-14002: <https://support.alcf.anl.gov/helpdesk/tickets/14002>
```

Identifiers are matched by the pattern `REQ-` followed by one or more decimal
digits, bounded by non-word characters. Embedded identifiers such as `XREQ-12`
or `REQ-12A` are ignored.

---

## Channel scope

The app monitors **public and private channels** only. Direct messages (IMs) and
multi-party direct messages (MPDMs) are explicitly excluded. The required OAuth
scopes are:

| Scope              | Purpose                                      |
| ------------------ | -------------------------------------------- |
| `channels:history` | Read public-channel messages                 |
| `groups:history`   | Read private-channel messages                |
| `chat:write`       | Post replies into threads                    |
| `datastore:read`   | Check the deduplication record               |
| `datastore:write`  | Write the deduplication record after posting |

No `im:history`, `mpim:history`, or `chat:write.public` scope is requested.

---

## Thread semantics under ROSI

Slack's Runtime on Slack Infrastructure (ROSI) uses two separate trigger paths:

- **Top-level messages** (`thread_ts == null`): the trigger maps
  `data.message_ts` to both `source_message_ts` (dedup key) and `reply_root_ts`
  (thread anchor). The app's reply creates a new thread under the original
  message.

- **Thread replies** (`thread_ts != null`): the trigger maps `data.thread_ts` to
  `source_message_ts` and `data.message_ts` to `reply_root_ts`. The app's reply
  is posted into the existing thread. Passing nullable `thread_ts` through
  workflow input validation is avoided by using two distinct triggers.

---

## Duplicate suppression

The app performs **best-effort, non-atomic** duplicate suppression:

1. Before posting, it reads a `ProcessedMessages` datastore record keyed by
   `channel_id:source_message_ts`. The `source_message_ts` carries sub-second
   fractional precision, so two messages arriving in the same wall-clock second
   have distinct keys.
2. If an unexpired record exists, the app exits without posting.
3. After a successful post, it writes the record with a 24-hour TTL.

Because `apps.datastore.put` has no conditional-create parameter, this is
sequential retry suppression only, not exactly-once delivery. A redelivered
event that arrives after step 3 will be suppressed; a redelivery that races with
step 3 may result in a second reply.

---

## Privacy model

The `ProcessedMessages` datastore stores **only**:

| Field        | Type       | Content                                                           |
| ------------ | ---------- | ----------------------------------------------------------------- |
| `source_key` | string     | `channel_id:source_message_ts` — no message text or user identity |
| `created_at` | timestamp  | Unix seconds when the record was written                          |
| `expires_at` | timestamp  | Unix seconds when the record expires (24 h)                       |
| `reply_ts`   | message_ts | Slack timestamp of the reply posted by the app                    |

No message text, user identity, or ticket identifiers are persisted.

---

## Prerequisites

- A **paid Slack plan** with [Slack Platform](https://api.slack.com/automation)
  enabled.
- **CELS administrator approval** to install a Slack app in the workspace.
- [Deno](https://deno.com/) v2.9.7 or later.
- [Slack CLI](https://api.slack.com/automation/cli/install) v4.x.

---

## Local verification

Run the full local gate (format check, lint, tests, type check) with:

```bash
export DENO_INSTALL="$HOME/.local/deno"
export PATH="$DENO_INSTALL/bin:$HOME/.slack/bin:$HOME/.local/bin:$PATH"
deno task check
```

All 24 tests should pass and every tool should exit 0.

---

## Further reading

- **Deployment and rollback:** [`docs/runbook.md`](docs/runbook.md)
- **Design specification:**
  [`docs/superpowers/specs/2026-09-29-alcf-ticket-linker-design.md`](docs/superpowers/specs/2026-09-29-alcf-ticket-linker-design.md)
- **Implementation plan:**
  [`docs/superpowers/plans/2026-09-29-alcf-ticket-linker.md`](docs/superpowers/plans/2026-09-29-alcf-ticket-linker.md)
