# ALCF Ticket Linker — Design Specification

**Status:** Approved design; implementation not started  
**Date:** 2026-09-29  
**Target workspace:** `cels-anl.slack.com`

## 1. Purpose

Build a private, Slack-hosted app that watches every new message in each channel where the app is a member. When a message contains one or more ALCF support request identifiers, the app posts one reply in the same Slack thread containing direct links to those tickets.

Example input:

```text
Please check REQ-13981 and req-14002. REQ-13981 is urgent.
```

Expected reply:

```text
REQ-13981: <https://support.alcf.anl.gov/helpdesk/tickets/13981>
REQ-14002: <https://support.alcf.anl.gov/helpdesk/tickets/14002>
```

The app does not access Freshworks, authenticate to the support site, retrieve ticket contents, or generate previews.

## 2. Scope

### In scope

- Slack-managed hosting using Run on Slack Infrastructure (ROSI).[1]
- A TypeScript workflow app using the Deno Slack SDK.
- Automatic handling of top-level channel messages and replies inside existing threads.
- Case-insensitive request-ID recognition with uppercase normalization.
- One bot reply per source message, listing each unique request ID once.
- Best-effort retry deduplication using a short-lived Slack datastore record.
- Unit tests, mocked-client integration tests, and a deployment/operations runbook.
- A private GitHub repository owned by `jtchilders-ai-assistant`.

### Out of scope

- Freshworks API access, ticket-content retrieval, authentication, or previews.
- Direct messages or group direct messages.
- Reading channels where the app is not a member.
- Retrospective scanning of channel history.
- Editing or deleting bot replies after the source message is edited or deleted.
- User-configurable patterns, URL bases, or response templates in the first release.
- External servers, public HTTP endpoints, Socket Mode, or laptop-hosted production processes.

## 3. Functional requirements

### FR-1: Channel coverage

The event trigger uses `message_posted` with `all_resources: true`. It therefore applies to every channel in the workspace where the app is a member, without maintaining a hard-coded channel-ID list. Slack documents that this setting can increase workflow executions and charges; installation should remain limited to channels where automatic ticket linking is wanted.[4]

### FR-2: Message coverage

The app processes:

- new top-level channel messages; and
- new replies posted in existing threads.

It does not process historical messages when newly installed or newly added to a channel. Slack's current `MessagePosted` trigger context explicitly provides a nullable `thread_ts` for threaded messages, which is evidence that this event covers thread replies.[10] The CELS smoke test remains the final verification of actual workspace behavior.

### FR-3: Ticket recognition

The parser recognizes ASCII request IDs of the form:

```regex
\bREQ-([0-9]+)\b
```

Matching is case-insensitive. The numeric component has no fixed maximum width. Output normalizes the prefix to uppercase.

The implementation must avoid matches embedded in a larger ASCII word or identifier, including `XREQ-123`, `REQ-123X`, and `REQ-123_4`. Because JavaScript word-boundary behavior around underscores is easy to misread, tests—not the displayed shorthand alone—define the required boundary semantics.

Examples:

- Match: `REQ-1`, `req-13981`, `(ReQ-999999999)`
- Do not match: `REQ-`, `REQ-12A`, `XREQ-12`, `REQ-12_more`

### FR-4: Deduplication within one message

The parser returns unique ticket IDs in first-occurrence order. Repeating the same ticket with different casing produces one link.

The parser operates on the event's Slack-encoded `text` field as delivered; it does not strip mrkdwn first. Consequently, a ticket ID appearing in visible link-label text such as `<https://example.invalid|REQ-123>` is intentionally recognized. A comma terminates the number, so `REQ-123,456` recognizes `REQ-123`.

### FR-5: Link construction

For normalized ticket `REQ-N`, where `N` is the captured decimal digit string, construct:

```text
https://support.alcf.anl.gov/helpdesk/tickets/N
```

The message and URL numbers are identical. The app must not infer offsets or query a mapping service.

### FR-6: Reply formatting

The app posts exactly one reply for a source message containing at least one unique ticket. Each ticket occupies one line:

```text
REQ-N: <https://support.alcf.anl.gov/helpdesk/tickets/N>
```

Slack angle-bracket link syntax is intentional: it produces a clickable URL without claiming access to ticket metadata. The app supplies equivalent plain text as its accessible fallback if richer blocks are later introduced.

### FR-7: Thread placement

Slack does not nest threads. The reply target is:

- `source_message.ts` for a top-level message;
- `source_message.thread_ts` for a message already inside a thread.

Thus a response to an existing thread reply appears in that same thread, under the thread root.

### FR-8: Loop prevention

The trigger requires `data.user_id != null`, following Slack's published Daily Topic sample for excluding app posts.[9] It also accepts only `data.channel_type == "public"` or `data.channel_type == "private"`, explicitly excluding direct and multiparty-direct messages. The custom function independently enforces both conditions before doing any work. Defense in depth is required because the app's own reply is itself a message event.

### FR-9: Retry idempotency

Slack event delivery and workflow execution may be retried. The app uses a Slack-hosted datastore keyed by a deterministic source-message identity:

```text
<team_id>:<channel_id>:<message_ts>
```

The record stores only:

- the key;
- creation time;
- expiration timestamp; and
- the posted reply timestamp when available.

It does not store source message text, user identity, or ticket IDs.

The intended retention is 24 hours. The datastore uses Slack's TTL support; Slack notes that physical deletion may occur up to 48 hours after expiration, so application reads must treat expired records as absent rather than relying on prompt deletion.[6][7]

The guarantee is explicitly **at least once with best-effort duplicate suppression**, not exactly once. Slack's documented datastore `put` operation creates or replaces an item and exposes no conditional create-if-absent argument.[8] Therefore, concurrent executions can both observe no record and both post. The expected flow is: read the key, return if an unexpired record exists, post the reply, then write the expiring record. A failed post leaves the source eligible for retry. A datastore-write failure after a successful post can cause a later duplicate and must be logged. The implementation must not add a misleading non-atomic `claimed` state.

## 4. Architecture

The application contains four independently testable units:

1. **Event trigger** — subscribes to `message_posted` across all channels where the app is present and filters obvious app-generated events.
2. **Workflow** — maps the event's channel, timestamps, text, and origin metadata into one custom-function invocation.
3. **Ticket-link function** — validates origin, parses and deduplicates ticket IDs, enforces idempotency, formats the response, and calls `chat.postMessage`.
4. **Processed-message datastore** — holds privacy-minimized, expiring idempotency state.

No component calls Freshworks. The only outbound application action is Slack's own Web API call to post the reply.

## 5. Data flow

1. A user posts a channel message or thread reply.
2. Slack evaluates the `message_posted` trigger.
3. The trigger starts the workflow and passes event fields to the custom function.
4. The function rejects unsupported or bot/app-originated events.
5. The parser extracts normalized, unique IDs.
6. If none are present, the function returns success without writing state or posting.
7. The function reads the datastore key for the source message.
8. If an unexpired processed record exists, the function exits without posting.
9. The formatter creates one line per unique ID.
10. The function calls `chat.postMessage` with the source channel and selected root timestamp.
11. On success, the function writes the processed record with the reply timestamp and a 24-hour expiration.
12. On failure, the error is logged and the source remains eligible for a retry.

## 6. Permissions and security

The manifest follows least privilege. Expected bot scopes are:

- `channels:history` for public channels;
- `groups:history`, because “channels where the app is added” includes private channels in the first release;
- `chat:write` to post replies; and
- `datastore:read` and `datastore:write` for idempotency.

The trigger's public/private channel filter and these scope names must be confirmed with the installed Slack CLI and Slack's manifest validation before deployment. If Slack requires DM-related scopes merely to create an `all_resources` trigger, implementation must stop for design review rather than broaden access silently. Unneeded DM, user-directory, file, reaction, and Freshworks permissions are prohibited.

No secrets are required by application logic. Slack installation credentials and deployment authorization remain managed by Slack and the Slack CLI, not committed to Git. Logs must not include complete source-message text.

## 7. Error handling and observability

- **No matches:** successful no-op, no datastore write.
- **Malformed/missing event fields:** fail closed with a structured diagnostic that excludes message text.
- **Datastore read unavailable:** do not post; return an error so Slack can retry rather than knowingly bypass duplicate suppression.
- **Slack post rejected or rate-limited:** log the Slack error code, return failure, and preserve retry eligibility.
- **Datastore write fails after a successful post:** log this as a duplicate-risk condition. A later retry may duplicate the response because Slack exposes no transaction spanning `chat.postMessage` and datastore write.
- **Function timeout:** keep processing local and bounded; no Freshworks call is present. Slack-hosted custom functions have finite execution time limits.[2]

Operators use `slack activity` for deployed-function logs. Routine logs include workflow execution identifier when available, number of unique ticket IDs, disposition, and Slack error code. Ticket IDs, message text, channel ID, and source timestamp are omitted by default. Channel ID and source timestamp may appear together only in an error-level diagnostic needed to investigate duplicate-risk or delivery failures; access to those logs follows workspace administrative controls.

## 8. Testing and acceptance criteria

### Unit tests

The parser and formatter tests cover:

- uppercase, lowercase, and mixed-case prefixes;
- one digit and very long digit strings;
- punctuation and line boundaries;
- prohibited embedded/underscore cases;
- malformed IDs;
- duplicates with differing case;
- multiple unique IDs preserving first occurrence;
- exact URL and one-line-per-ticket formatting;
- top-level and existing-thread root selection.

### Function tests with a mocked Slack client

Tests verify:

- no match causes no datastore write and no post;
- bot/app origin causes no datastore write and no post;
- one source message causes exactly one `chat.postMessage` call;
- multiple IDs still cause one call;
- an unexpired processed record suppresses a duplicate call;
- an expired record is treated as absent even if TTL deletion has not occurred;
- posting failure remains retryable;
- datastore-finalization failure is surfaced and logged;
- the exact `channel`, `thread_ts`, and `text` arguments are correct.

### Static and platform checks

Before deployment:

- `deno fmt --check`
- `deno lint`
- `deno test`
- Slack CLI manifest validation
- Slack CLI trigger creation in a development installation

### CELS smoke test

After CELS approval and installation, add the app to one controlled test channel and verify:

1. a top-level message with one mixed-case ID receives one correctly threaded link;
2. a thread reply with two unique IDs and one duplicate receives one response in the existing thread;
3. the bot's own response does not trigger another response;
4. a message with no valid ID produces no response;
5. replaying the same source event, where practical in development tooling, does not produce a second response in the normal sequential-retry case.

Deployment is not considered complete until these observed results are recorded in the runbook.

## 9. Deployment and ownership

The repository is private under `jtchilders-ai-assistant`. Deployment targets `cels-anl.slack.com` through the Slack CLI. CELS administrators may need to approve the app, its scopes, ROSI deployment, and use of `all_resources: true`.[2][3] This approval is an external deployment blocker and schedule risk; local implementation and tests can finish without it, but CELS smoke testing and production activation cannot.

Taylor's required actions are deferred until the code and local checks are complete. Expected user/admin actions are:

1. authenticate the Slack CLI to the CELS workspace;
2. request or grant app approval;
3. authorize the reviewed scopes;
4. add the deployed app to selected channels; and
5. participate in the controlled smoke test.

No shell startup file modifications are required.

## 10. Alternatives rejected

- **Custom parser plus built-in Send Message step:** introduces workflow plumbing for a variable-length response with no useful separation.
- **Self-hosted Bolt app with Socket Mode:** requires an always-on process and token operations for functionality Slack can host directly.[5]
- **Public Events API endpoint:** adds ingress, request verification, hosting, and operations without a corresponding requirement.
- **No idempotency state:** exposes users to duplicate replies on retries.
- **Claim-state datastore check followed by unconditional write:** rejected because it adds complexity without concurrency safety and would falsely imply exactly-once behavior. The selected processed-record check is documented only as best-effort sequential-retry suppression.

## Sources

[1] https://docs.slack.dev/workflows/run-on-slack-infrastructure — Run on Slack infrastructure  
[2] https://docs.slack.dev/tools/deno-slack-sdk/ — Deno Slack SDK  
[3] https://docs.slack.dev/tools/deno-slack-sdk/guides/deploying-to-slack — Deploying to Slack  
[4] https://docs.slack.dev/tools/deno-slack-sdk/guides/creating-event-triggers — Creating event triggers  
[5] https://docs.slack.dev/apis/events-api/using-socket-mode — Using Socket Mode  
[6] https://docs.slack.dev/tools/deno-slack-sdk/guides/using-datastores — Using datastores  
[7] https://docs.slack.dev/tools/deno-slack-sdk/guides/deleting-items-from-a-datastore — Deleting items from a datastore
[8] https://docs.slack.dev/reference/methods/apps.datastore.put — apps.datastore.put method  
[9] https://github.com/slack-samples/deno-daily-channel-topic/blob/main/triggers/message_posted_event.ts — Slack Daily Topic message trigger sample
[10] https://github.com/slackapi/deno-slack-api/blob/main/src/typed-method-types/workflows/triggers/event-data/message_posted.ts — Deno Slack API MessagePosted context definition
