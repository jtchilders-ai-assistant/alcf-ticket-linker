# ALCF Ticket Linker — Deployment and Rollback Runbook

This runbook covers every operator step from initial authorization through live
smoke testing and rollback. It targets CELS administrators who hold the Slack
workspace admin role required to approve a new Slack Platform app.

> **Important:** Local and deployed apps have distinct app IDs and trigger IDs.
> The triggers you create during `slack run` (local dev) are separate from the
> triggers you must create after `slack deploy`. Always record the deployed app
> ID and trigger IDs in a local, Git-ignored operator note file — never commit
> them to the repository.

---

## 1. Prerequisites

- Slack CLI v4.x installed and on `PATH` (`slack version` should print
  `v4.x.y`).
- Deno v2.9.7+ installed and on `PATH` (`deno --version` should print `2.9.7`).
- CELS administrator role on `cels-anl.slack.com`.
- The workspace must be on a paid Slack plan with Slack Platform enabled.

Set up your shell once per terminal session:

```bash
export DENO_INSTALL="$HOME/.local/deno"
export PATH="$DENO_INSTALL/bin:$HOME/.slack/bin:$HOME/.local/bin:$PATH"
```

---

## 2. Pre-deployment gate

Run the full local check before touching any Slack environment:

```bash
deno task check
```

All 24 tests must pass and every tool must exit 0. Do not proceed if any check
fails.

---

## 3. Authentication

Log in to the CELS workspace:

```bash
slack auth login
```

The CLI prints a ticket and asks you to visit a Slack URL in a browser to
complete the OAuth flow. After approval:

```bash
slack auth list
```

Confirm an authorized entry for `cels-anl.slack.com` appears in the list before
continuing.

---

## 4. Manifest validation

```bash
slack manifest validate
```

Expected: validation exits 0 with no scope warnings. If Slack requests
`im:history` or `mpim:history`, **stop** — this is a design conflict that must
be resolved before deployment. Do not add DM scopes.

---

## 5. Local development server (optional)

Before deploying to production, test interactively with a local server:

```bash
slack run
```

This installs a separate **local** app instance. To create the event triggers
for the local instance:

```bash
slack trigger create --trigger-def triggers/message_posted_top_level.ts
slack trigger create --trigger-def triggers/message_posted_thread_reply.ts
```

The CLI will prompt you to select the workspace and app environment. Choose the
local (`(local)`) environment. Keep a note of the trigger IDs but do **not**
commit them.

Exit the local server with `Ctrl-C`. Triggers created for the local instance do
not affect the deployed instance.

---

## 6. Production deployment

### 6.1 Deploy the app

```bash
slack deploy
```

Expected: Slack returns a deployed app identifier (e.g. `A0123456789`). Record
it in your local operator notes file (`ops-notes.txt` or similar, listed in
`.gitignore`).

After deployment, read back the scopes to confirm:

```
channels:history
chat:write
datastore:read
datastore:write
groups:history
```

No `im:history`, `mpim:history`, or `chat:write.public` should appear.

### 6.2 Create the deployed event triggers

Local triggers do not carry over to the deployed app. Create both triggers for
the deployed environment:

```bash
slack trigger create --trigger-def triggers/message_posted_top_level.ts
```

When prompted, select the workspace and choose the **deployed** (not local) app
environment. Note the returned trigger ID (e.g. `Ft01234ABCD`).

```bash
slack trigger create --trigger-def triggers/message_posted_thread_reply.ts
```

Again select the deployed environment. Note the second trigger ID.

Verify both triggers exist:

```bash
slack trigger list
```

You should see two `event` triggers, both with `all_resources: true` and the
`message_posted` event type.

**Operator notes format (Git-ignored, never committed):**

```
APP_ID=A0123456789
TOP_LEVEL_TRIGGER_ID=Ft01234ABCD
THREAD_REPLY_TRIGGER_ID=Ft09876WXYZ
WORKSPACE=cels-anl.slack.com
DEPLOYED_AT=<UTC datetime>
```

---

## 7. Add the app to a controlled channel

Before broad rollout, have a CELS administrator add the app to **one** test
channel using Slack's channel settings → Integrations → Add apps. Confirm app
membership before proceeding to smoke tests.

---

## 8. Smoke tests

Run all five cases in the controlled channel. Observe actual thread placement
and tail the activity log in a second terminal:

```bash
slack activity --tail
```

### Test cases

| # | Scenario                                                                                       | Expected result                                                             |
| - | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1 | Send a top-level message containing one mixed-case ticket: `req-13981`                         | App replies in a new thread with `REQ-13981: <link>`                        |
| 2 | Reply into an existing thread with `REQ-14002 REQ-13981 REQ-14002` (two unique, one duplicate) | App replies in the same thread with two links, deduplicated                 |
| 3 | The app's own reply message is delivered                                                       | App does **not** reply again (bot user filtered by `user_id == null` guard) |
| 4 | Send a top-level message with no ticket identifiers, e.g. `Hello there`                        | App produces no reply                                                       |
| 5 | Resend the exact same message a second time (sequential retry)                                 | App produces no second reply (best-effort suppression via datastore)        |

### Results table

Record only suffixes and pass/fail. Do **not** record message text or ticket
IDs.

| UTC time | App ID suffix | Top trigger suffix | Thread trigger suffix | Channel ID suffix | Case                   | Observed result | Pass/Fail |
| -------- | ------------- | ------------------ | --------------------- | ----------------- | ---------------------- | --------------- | --------- |
|          |               |                    |                       |                   | 1 — top-level single   |                 |           |
|          |               |                    |                       |                   | 2 — thread reply multi |                 |           |
|          |               |                    |                       |                   | 3 — bot no-recurse     |                 |           |
|          |               |                    |                       |                   | 4 — no-ticket no-op    |                 |           |
|          |               |                    |                       |                   | 5 — sequential dedup   |                 |           |

If any smoke test fails, **delete both triggers first**, then diagnose:

```bash
slack trigger delete --trigger-id "$TOP_LEVEL_TRIGGER_ID"
slack trigger delete --trigger-id "$THREAD_REPLY_TRIGGER_ID"
```

Then review `slack activity --tail` output and open a failing regression test
before attempting a fix.

---

## 9. Rollback

To remove the app from the workspace without deleting the app or its data:

```bash
slack trigger delete --trigger-id "$TOP_LEVEL_TRIGGER_ID"
slack trigger delete --trigger-id "$THREAD_REPLY_TRIGGER_ID"
slack uninstall --app "$APP_ID"
```

- `slack trigger delete --trigger-id <id>` removes one trigger.
- `slack uninstall --app <id>` uninstalls the app from the team but does not
  delete the app record or its datastore data.

To re-deploy after a fix, repeat sections 4 through 8.

---

## 10. Troubleshooting

| Symptom                                                            | Check                                                                                                                                                     |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No reply to a message with a ticket ID                             | `slack activity --tail` — look for function errors; confirm app is a member of the channel                                                                |
| Duplicate replies                                                  | Datastore TTL may be 0 or expired record redelivered; check `source_message_ts` mapping in trigger definition                                             |
| `im:history` / `mpim:history` scope requested by manifest validate | Slack rejected `all_resources` without DM scopes — stop and file a design issue; do not add DM scopes                                                     |
| `slack deploy` fails with manifest error                           | Run `deno task check` and `slack manifest validate` locally first                                                                                         |
| Trigger create prompts for a workflow but shows none               | Ensure you selected the correct app environment (deployed, not local)                                                                                     |
| `duplicate-risk` in activity log                                   | `chat.postMessage` succeeded but datastore write failed; the message was posted but the dedup record was not written — investigate datastore availability |
