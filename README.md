# ALCF Ticket Linker

A Slack-hosted app that finds `REQ-<digits>` identifiers in Slack messages and
replies with direct links to the ALCF support portal.

**Hosting:** This implementation runs on Slack's Run on Slack Infrastructure
(ROSI). It does not require a CELS-hosted server, public HTTP endpoint, Socket
Mode listener, external database, or continuously running Slack CLI process. The
Slack CLI is used only to validate, deploy, create triggers, inspect, and roll
back the app.

> **CELS IT:** Start with [`docs/CELS_IT_HANDOFF.md`](docs/CELS_IT_HANDOFF.md).
> It contains the review summary, prerequisites, exact Enterprise Grid
> deployment procedure, acceptance checklist, and a known deployment issue.
> Detailed operational steps are in [`docs/runbook.md`](docs/runbook.md).

---

## Behavior

Whenever a user posts a message containing one or more ALCF support request
identifiers—for example `REQ-13981` or `req-14002` (case-insensitive)—the app
replies in the same thread with one link per unique ticket:

```
REQ-13981: <https://support.alcf.anl.gov/helpdesk/tickets/13981>
REQ-14002: <https://support.alcf.anl.gov/helpdesk/tickets/14002>
```

Identifiers are matched by `REQ-` followed by one or more decimal digits, with
ASCII letter, digit, and underscore boundaries excluded. Embedded identifiers
such as `XREQ-12`, `REQ-12A`, and `REQ-12_more` are ignored.

The app handles new top-level posts and new replies in existing threads. It does
not process historical messages, edits, or deletions.

---

## Channel scope

The app monitors **public and private channels where it is a member**. Direct
messages (IMs) and multi-party direct messages (MPDMs) are explicitly excluded.
The required OAuth scopes are:

| Scope              | Purpose                                      |
| ------------------ | -------------------------------------------- |
| `channels:history` | Read public-channel messages                 |
| `groups:history`   | Read private-channel messages                |
| `chat:write`       | Post replies into threads                    |
| `datastore:read`   | Check the deduplication record               |
| `datastore:write`  | Write the deduplication record after posting |

No `im:history`, `mpim:history`, or `chat:write.public` scope is requested.

---

## Architecture and hosting

The repository contains a TypeScript workflow app built with the Deno Slack SDK:

- two mutually exclusive `message_posted` event triggers;
- one workflow and one custom function;
- a Slack-hosted datastore for short-lived retry state; and
- no configured outbound domains.

Slack hosts the deployed function and datastore. A conventional app created in
the Slack developer UI is not an equivalent deployment: implementing this with
Events API or Socket Mode would require a separate persistent service. If an
organization does not permit ROSI apps, that is a deployment-policy blocker—not
a reason to install the conventional shell and expect this code to run.

---

## Thread semantics under ROSI

Slack's Runtime on Slack Infrastructure uses two separate trigger paths:

- **Top-level messages** (`thread_ts == null`): the trigger maps
  `data.message_ts` to both `source_message_ts` (dedup key) and `reply_root_ts`
  (thread anchor). The app's reply creates a new thread under the original
  message.

- **Thread replies** (`thread_ts != null`): the trigger maps `data.thread_ts` to
  `source_message_ts` and `data.message_ts` to `reply_root_ts`. The app's reply
  is posted into the existing thread. Two distinct triggers avoid passing a
  nullable `thread_ts` through workflow input validation.

---

## Duplicate suppression

The app performs **best-effort, non-atomic** duplicate suppression:

1. Before posting, it reads a `ProcessedMessages` datastore record keyed by
   `channel_id:source_message_ts`. The timestamp carries sub-second precision,
   so two messages arriving in the same wall-clock second have distinct keys.
2. If an unexpired record exists, the app exits without posting.
3. After a successful post, it writes the record with a 24-hour TTL.

Because Slack's datastore write is not an atomic create-if-absent operation,
this suppresses sequential retries but does not provide exactly-once delivery.
Concurrent retries may still produce duplicate replies.

---

## Privacy model

The `ProcessedMessages` datastore stores **only**:

| Field        | Type       | Content                                                           |
| ------------ | ---------- | ----------------------------------------------------------------- |
| `source_key` | string     | `channel_id:source_message_ts` — no message text or user identity |
| `created_at` | timestamp  | Unix seconds when the record was written                          |
| `expires_at` | timestamp  | Unix seconds when the record expires (24 h)                       |
| `reply_ts`   | message_ts | Slack timestamp of the reply posted by the app                    |

No message text, user identity, or ticket identifiers are persisted. The app
constructs ticket URLs directly; it does not call the Freshworks API or fetch
authenticated ticket pages.

---

## Tested toolchain

- Deno `2.9.7`
- Slack CLI `4.8.0`
- Deno Slack SDK `2.15.1`
- Deno Slack API `2.8.0`

A paid Slack plan with Slack Platform enabled and CELS authorization to create,
install, and deploy a ROSI app are required.

---

## Local verification

Run the complete local gate with:

```bash
export DENO_INSTALL="$HOME/.local/deno"
export PATH="$DENO_INSTALL/bin:$HOME/.slack/bin:$HOME/.local/bin:$PATH"
deno task check
```

Expected result: formatting, lint, **24 tests**, and type checks all pass.

---

## Documentation

- **CELS IT deployment handoff:**
  [`docs/CELS_IT_HANDOFF.md`](docs/CELS_IT_HANDOFF.md)
- **Deployment, smoke testing, troubleshooting, and rollback:**
  [`docs/runbook.md`](docs/runbook.md)
- **Architecture and security rationale:**
  [`docs/superpowers/specs/2026-09-29-alcf-ticket-linker-design.md`](docs/superpowers/specs/2026-09-29-alcf-ticket-linker-design.md)
- **Implementation record:**
  [`docs/superpowers/plans/2026-09-29-alcf-ticket-linker.md`](docs/superpowers/plans/2026-09-29-alcf-ticket-linker.md)
