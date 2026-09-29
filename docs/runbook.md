# ALCF Ticket Linker — Deployment and Rollback Runbook

This runbook covers every operator step from initial authorization through live
smoke testing and rollback. It targets CELS administrators who are authorized to
create, install, and deploy a Slack-hosted workflow app in the CELS Enterprise
Grid workspace. For the review-level overview and acceptance checklist, start
with [`CELS_IT_HANDOFF.md`](CELS_IT_HANDOFF.md).

This is a Run on Slack Infrastructure (ROSI) application. Slack hosts the
deployed function and datastore; no persistent CELS service, public endpoint,
Socket Mode process, or external database is part of this deployment.

> **Important:** Local and deployed apps have distinct app IDs and trigger IDs.
> The triggers you create during `slack run` (local dev) are separate from the
> triggers you must create after `slack deploy`. Always record the deployed app
> ID and trigger IDs in a local, Git-ignored operator note file — never commit
> them to the repository.

---

## 1. Prerequisites

- Slack CLI v4.8.0 installed and on `PATH` (`slack version` should print
  `Using slack v4.8.0`).
- Deno v2.9.7 installed and on `PATH` (`deno --version` should print `2.9.7`).
- Authorization to create, install, and deploy a ROSI app in the CELS Enterprise
  Grid workspace.
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

Log in to the CELS organization/workspace:

```bash
slack auth login
```

The CLI prints a ticket and asks you to visit a Slack URL in a browser to
complete the OAuth flow. After approval:

```bash
slack auth list
```

Confirm an authorized CELS entry before continuing. Record the Enterprise Grid
organization ID and the target CELS workspace ID locally:

```bash
ORG_ID=<enterprise-organization-id>
CELS_WORKSPACE_ID=<cels-workspace-id>
```

Do not paste the one-time authentication ticket, challenge code, or resulting
token into chat, email, an issue, or this repository.

---

## 4. Manifest validation

```bash
slack manifest validate --team "$CELS_WORKSPACE_ID"
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

This starts a development process and installs a separate **local** app
instance. It is optional and is not the production hosting model. To create the
event triggers for the local instance:

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
slack deploy \
  --team "$ORG_ID" \
  --org-workspace-grant "$CELS_WORKSPACE_ID" \
  --hide-triggers
```

Expected: Slack returns a deployed app identifier (e.g. `A0123456789`). Record
it in your local operator notes file (`ops-notes.txt` or similar, listed in
`.gitignore`).

After deployment, read back the deployed manifest:

```bash
slack manifest info --app "$APP_ID" --source remote --team "$ORG_ID"
```

Confirm that the bot scope list contains exactly:

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
slack trigger create \
  --app "$APP_ID" \
  --team "$ORG_ID" \
  --org-workspace-grant "$CELS_WORKSPACE_ID" \
  --trigger-def triggers/message_posted_top_level.ts

slack trigger create \
  --app "$APP_ID" \
  --team "$ORG_ID" \
  --org-workspace-grant "$CELS_WORKSPACE_ID" \
  --trigger-def triggers/message_posted_thread_reply.ts
```

Note both returned trigger IDs.

Verify both triggers exist:

```bash
slack trigger list --app "$APP_ID" --team "$ORG_ID"
```

You should see two `event` triggers, both with `all_resources: true` and the
`message_posted` event type.

**Operator notes format (Git-ignored, never committed):**

```
APP_ID=A0123456789
TOP_LEVEL_TRIGGER_ID=Ft01234ABCD
THREAD_REPLY_TRIGGER_ID=Ft09876WXYZ
ORG_ID=<enterprise-organization-id>
CELS_WORKSPACE_ID=<cels-workspace-id>
DEPLOYED_AT=<UTC datetime>
DEPLOYED_COMMIT=<git commit SHA>
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
| 5 | Replay the same source event using supported development tooling, if available                 | App produces no second reply (best-effort suppression via datastore)        |

Posting identical text twice manually creates two distinct Slack events and is
not a retry test. If the same event cannot be replayed, mark case 5 as **not
exercised** and rely on the deterministic adapter regression test.

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

To remove the app from the workspace without deleting the app record or its
data:

```bash
slack trigger delete --trigger-id "$TOP_LEVEL_TRIGGER_ID"
slack trigger delete --trigger-id "$THREAD_REPLY_TRIGGER_ID"
slack uninstall --app "$APP_ID" --team "$ORG_ID"
```

- `slack trigger delete --trigger-id <id>` removes one trigger.
- `slack uninstall --app <id>` uninstalls the app from the team but does not
  delete the app record or its datastore data.

To re-deploy after a fix, repeat sections 4 through 8.

---

## 10. Troubleshooting

| Symptom                                                            | Check                                                                                                                                                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No reply to a message with a ticket ID                             | `slack activity --tail` — look for function errors; confirm app is a member of the channel                                                                                                              |
| Duplicate replies                                                  | Datastore TTL may be 0 or expired record redelivered; check `source_message_ts` mapping in trigger definition                                                                                           |
| `im:history` / `mpim:history` scope requested by manifest validate | Slack rejected `all_resources` without DM scopes — stop and file a design issue; do not add DM scopes                                                                                                   |
| `slack deploy` fails with manifest error                           | Run `deno task check` and `slack manifest validate` locally first                                                                                                                                       |
| `apps.manifest.create` returns HTTP 500 after valid manifests      | Confirm CELS permits ROSI app creation and the operator has organization/workspace deployment rights; escalate the timestamp and redacted CLI log to CELS Slack support. Do not substitute Socket Mode. |
| Trigger create prompts for a workflow but shows none               | Ensure you selected the correct app environment (deployed, not local)                                                                                                                                   |
| `duplicate-risk` in activity log                                   | `chat.postMessage` succeeded but datastore write failed; the message was posted but the dedup record was not written — investigate datastore availability                                               |
