# CELS IT handoff: ALCF Ticket Linker

This document is the deployment handoff for CELS IT. It identifies what the
repository provides, what CELS must authorize, and how to install and verify the
app.

## Deployment decision

This repository is a **Slack-hosted Deno workflow app**. It is designed for
Slack's **Run on Slack Infrastructure (ROSI)** runtime.

- Slack hosts the deployed function and datastore.
- CELS does **not** need to operate a web server, public endpoint, Socket Mode
  listener, VM, container, or database for this implementation.
- Deployment is performed from a trusted administrator workstation with the
  Slack CLI. The CLI is needed for deployment and administration, not as an
  always-running production process.
- The similarly named conventional app that may exist in the Slack developer UI
  is not this deployment. A conventional Events API or Socket Mode app would
  require a separately hosted service and is out of scope.

If CELS policy does not permit ROSI apps, please stop and report that
constraint. Installing the conventional UI app alone will not run this code.

## What is provided

- `manifest.ts`: app identity, five least-privilege bot scopes, workflow, and
  Slack datastore declaration.
- `triggers/`: separate event triggers for top-level messages and replies in
  existing threads.
- `workflows/`: one workflow invoking the custom ticket-linking function.
- `functions/`: event validation, Slack posting, and retry-suppression logic.
- `domain/`: deterministic parser, normalization, formatting, and key helpers.
- `datastores/`: privacy-minimized, 24-hour processed-message records.
- `tests/`: behavior and configuration tests.
- `.github/workflows/ci.yml`: the same `deno task check` gate used locally.
- `docs/runbook.md`: detailed deployment, smoke-test, troubleshooting, and
  rollback procedures.

## Functional behavior

For every new message in a public or private channel where the app is a member:

1. Match case-insensitive identifiers of the form `REQ-<digits>`.
2. Normalize IDs to uppercase and retain each unique ID once, in first-seen
   order.
3. Construct direct links without calling Freshworks: `REQ-13981` becomes
   `https://support.alcf.anl.gov/helpdesk/tickets/13981`.
4. Post one reply in the source message's thread. For a reply in an existing
   thread, post under that existing thread root.

The app does not process historical messages, edits, deletions, direct messages,
or multi-party direct messages. It rejects bot/app-authored events to avoid
feedback loops.

## Data handling and permissions

The requested bot scopes are exactly:

- `channels:history`
- `groups:history`
- `chat:write`
- `datastore:read`
- `datastore:write`

The app does not request `im:history`, `mpim:history`, or `chat:write.public`.
It has no configured outbound domains and makes no Freshworks API request.

The Slack datastore retains only:

- `source_key`: channel ID plus precise source-message timestamp;
- `created_at`;
- `expires_at` (24-hour TTL); and
- `reply_ts`.

It does not retain message text, user IDs, or ticket IDs. Retry suppression is
best effort: sequential redelivery is suppressed, but simultaneous executions
can race and produce duplicate replies because the Slack datastore has no atomic
create-if-absent operation.

## CELS decisions and access required

CELS IT must confirm all of the following before deployment:

- ROSI / Slack-hosted workflow apps are enabled and permitted for the CELS
  workspace.
- The deploying administrator may create and install a custom Slack-hosted app
  in the CELS workspace.
- The five scopes above and the `all_resources` message-event triggers are
  approved.
- The app will initially be added to one controlled test channel. It only sees
  channels where it is a member.
- An authorized operator will own future deploy, trigger, and rollback actions.

No application secret, signing secret, app-level token, Freshworks credential,
or externally hosted runtime is required.

## Tested toolchain

The checked-in code and lockfile were tested with:

- Deno `2.9.7`
- Slack CLI `4.8.0`
- Deno Slack SDK `2.15.1`
- Deno Slack API `2.8.0`

Using these versions is the lowest-risk installation path. The operator may
validate a newer Slack CLI separately, but should not change pinned SDK versions
during the initial deployment.

Official platform references:

- [Run on Slack infrastructure](https://docs.slack.dev/workflows/run-on-slack-infrastructure)
- [Deno Slack SDK](https://docs.slack.dev/tools/deno-slack-sdk/)
- [Deploying to Slack](https://docs.slack.dev/tools/deno-slack-sdk/guides/deploying-to-slack/)
- [Slack CLI on Enterprise Grid](https://docs.slack.dev/tools/slack-cli/guides/using-slack-cli-on-an-enterprise-grid-organization/)
- [Creating event triggers](https://docs.slack.dev/tools/deno-slack-sdk/guides/creating-event-triggers/)

## Installation procedure

### 1. Obtain and verify the source

```bash
git clone https://github.com/jtchilders-ai-assistant/alcf-ticket-linker.git
cd alcf-ticket-linker
git status --short
```

`git status --short` must be empty. Record the reviewed commit SHA:

```bash
git rev-parse HEAD
```

### 2. Put the tested tools on `PATH`

Install Deno `2.9.7` and Slack CLI `4.8.0` using CELS-approved methods, then set
up the current shell without modifying shell startup files:

```bash
export DENO_INSTALL="$HOME/.local/deno"
export PATH="$DENO_INSTALL/bin:$HOME/.slack/bin:$HOME/.local/bin:$PATH"
deno --version
slack version
```

### 3. Run the complete local gate

```bash
deno task check
```

Expected result: formatting, lint, all 24 tests, and type checks pass. Stop on
any failure.

### 4. Authenticate and identify the Enterprise Grid targets

```bash
slack auth login
slack auth list
```

Complete the interactive authorization locally; do not send its ticket,
challenge, or token through email, chat, or an issue. Confirm the CELS
Enterprise Grid organization and target workspace IDs. In the examples below:

```bash
ORG_ID=<enterprise-organization-id>
CELS_WORKSPACE_ID=<cels-workspace-id>
```

### 5. Validate the manifest for CELS

```bash
slack manifest validate --team "$CELS_WORKSPACE_ID"
```

Expected result: `App Manifest Validation Result: Valid`. Stop if Slack asks for
broader scopes than those listed above.

### 6. Deploy to Slack-hosted infrastructure

```bash
slack deploy \
  --team "$ORG_ID" \
  --org-workspace-grant "$CELS_WORKSPACE_ID" \
  --hide-triggers
```

Record the returned deployed app ID in a local, access-controlled operator note;
do not commit it to this repository.

### 7. Read back the deployed manifest

```bash
APP_ID=<deployed-app-id>
slack manifest info --app "$APP_ID" --source remote --team "$ORG_ID"
```

Confirm the workflow, datastore, and exactly the five approved scopes before
creating triggers.

### 8. Create both deployed triggers

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

slack trigger list --app "$APP_ID" --team "$ORG_ID"
```

Verify that two event triggers exist. Preserve both trigger IDs in the local
operator note.

### 9. Controlled activation and acceptance

Add the app to one controlled channel, then execute every smoke test in
[`docs/runbook.md`](runbook.md#8-smoke-tests). Do not broaden channel membership
until the tested channel passes.

## Known deployment issue to report precisely

During an earlier administrator-assisted attempt, both organization-level and
workspace-level manifest validation succeeded, but app creation returned:

```text
HTTP 500 from https://slack.com/api/apps.manifest.create
```

No app or trigger was created by that attempt. If this recurs with the tested
CLI and an authorized CELS administrator account:

1. do not switch to Socket Mode or add a public endpoint as a workaround;
2. verify that ROSI app creation is enabled for the organization/workspace;
3. verify the administrator can create and grant a ROSI app to the CELS
   workspace; and
4. escalate the timestamp, organization/workspace identifiers, Slack CLI
   version, and local Slack CLI debug log through CELS's Slack support channel.

Do not attach unredacted local authentication state or tokens.

## Rollback and ownership

Rollback consists of deleting both triggers and uninstalling the deployed app;
see [`docs/runbook.md`](runbook.md#9-rollback). Slack continues to host the app
until it is uninstalled—no CELS server process needs to be stopped.

The CELS operator should retain, outside Git:

- deployed app ID;
- both trigger IDs;
- deployment commit SHA and UTC time;
- workspace grant;
- smoke-test results without message text or ticket IDs; and
- rollback owner/contact.

## Public repository note

The repository is intentionally public to support CELS review and handoff. No
Slack credentials, authentication state, app IDs, trigger IDs, or operator logs
belong in Git. The repository currently grants no general open-source license;
public visibility permits inspection and cloning but does not itself grant broad
reuse rights. Licensing can be added separately by the repository owner if
broader redistribution or modification rights are desired.

## Acceptance checklist

- [ ] CELS confirms ROSI is supported and permitted.
- [ ] Reviewed commit SHA is recorded.
- [ ] `deno task check` passes with 24 tests.
- [ ] Manifest validation succeeds for the target CELS workspace.
- [ ] Deployment returns an app ID.
- [ ] Remote manifest readback has exactly the approved scopes.
- [ ] Both event triggers are present.
- [ ] Controlled-channel smoke tests pass.
- [ ] Operator IDs, evidence, and rollback ownership are recorded outside Git.
