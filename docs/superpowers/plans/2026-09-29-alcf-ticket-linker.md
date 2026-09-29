# ALCF Ticket Linker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify a private Slack-hosted app that finds unique
`REQ-<digits>` identifiers in every new public/private channel message,
including thread replies, and posts one link list in the corresponding thread.

**Architecture:** A `MessagePosted` event trigger invokes one workflow and one
custom Slack function. Pure parsing/key/formatting helpers remain independent of
Slack; the function adapter enforces origin checks, performs best-effort
sequential retry suppression with an expiring Slack datastore record, posts
through `chat.postMessage`, and records success.

**Tech Stack:** TypeScript, Deno 2.x, Deno Slack SDK 2.15.2, Deno Slack API
2.9.3, Slack CLI 4.x, GitHub Actions.

---

## Ground rules and verified platform semantics

- Work from an isolated branch/worktree; do not implement on `main`.
- Follow RED → GREEN → REFACTOR for every production module: create its test
  first, run it and confirm the expected missing-module or missing-export
  failure, then create the implementation.
- Use TWO `MessagePosted` event triggers sharing one workflow and one function.
  The top-level trigger filters `thread_ts == null` and maps `data.message_ts`
  to `source_message_ts` (dedup key) and `reply_root_ts` (chat.postMessage
  target). The thread-reply trigger filters `thread_ts != null` and maps
  `data.thread_ts` to `source_message_ts` and `data.message_ts` to
  `reply_root_ts`. Two triggers avoid passing nullable `thread_ts` through
  workflow input validation.
- Deduplication key is `channel_id + source_message_ts`. `source_message_ts` is
  the Slack `message_ts` of the specific message (sub-second fractional
  precision), which guarantees distinct keys for two messages in the same
  channel within the same wall-clock second. Do not use the whole-second
  `event_timestamp` as a dedup key component.
- Do not pass nullable `thread_ts` through workflow inputs.
- Treat datastore suppression as best-effort for sequential retries, not
  exactly-once processing. `apps.datastore.put` replaces existing rows and has
  no conditional-create parameter.
- Do not broaden scopes to direct-message history. If Slack rejects the
  public/private-only `all_resources` trigger unless DM scopes are added, stop
  and report that design conflict.
- Never commit Slack credentials, `.env` files, generated `.slack/apps*.json`,
  or local CLI state.

## Target file map

- `deno.jsonc` — pinned imports, formatting/linting scope, and verification
  task.
- `.slack/hooks.json` — Slack CLI manifest-generation hook.
- `.slack/.gitignore` — excludes generated local Slack app state.
- `.gitignore` — excludes editor/OS/build artifacts and secrets.
- `manifest.ts` — app metadata, one workflow, one datastore, least-privilege
  scopes.
- `domain/tickets.ts` — pure ticket extraction, normalization, formatting,
  reply-root, and dedup-key helpers.
- `domain/tickets_test.ts` — exhaustive pure behavior tests.
- `datastores/processed_messages.ts` — TTL-enabled privacy-minimized datastore
  schema.
- `functions/link_tickets.ts` — custom-function definition and Slack adapter.
- `functions/link_tickets_test.ts` — mocked Slack API tests for no-op,
  deduplication, posting, and failures.
- `workflows/link_tickets.ts` — workflow inputs and one custom-function step.
- `triggers/message_posted_top_level.ts` — event trigger for top-level messages
  (thread_ts == null); maps `data.message_ts` to both `source_message_ts` and
  `reply_root_ts`.
- `triggers/message_posted_thread_reply.ts` — event trigger for thread replies
  (thread_ts != null); maps `data.thread_ts` to `source_message_ts` and
  `data.message_ts` to `reply_root_ts`.
- `tests/configuration_test.ts` — structural assertions over trigger, workflow,
  datastore, and manifest.
- `.github/workflows/ci.yml` — Deno formatting, linting, tests, and type
  checking.
- `README.md` — purpose, privacy model, local checks, and deployment overview.
- `docs/runbook.md` — CELS authorization, validation, trigger creation,
  deployment, smoke test, rollback, and troubleshooting.

### Task 1: Establish the pinned Deno/Slack project shell

**Files:**

- Create: `deno.jsonc`
- Create: `.slack/hooks.json`
- Create: `.slack/.gitignore`
- Create: `.gitignore`

- [ ] **Step 1: Confirm local tool availability without changing shell startup
      files**

Run:

```bash
command -v deno || true
command -v slack || true
deno --version 2>/dev/null || true
slack version 2>/dev/null || true
```

Expected on the current host: neither tool is installed. Do not edit `~/.zshrc`,
`~/.zprofile`, or another login file.

- [ ] **Step 2: Install user-local tools if absent**

Install Deno and Slack CLI under the user's home directory, then expose them
only to the current shell:

```bash
export DENO_INSTALL="$HOME/.local/deno"
if ! command -v deno >/dev/null; then
  curl -fsSL https://deno.land/install.sh | sh -s v2.9.7
fi
export PATH="$DENO_INSTALL/bin:$HOME/.slack/bin:$HOME/.local/bin:$PATH"
if ! command -v slack >/dev/null; then
  curl -fsSL https://downloads.slack-edge.com/slack-cli/install.sh | bash
fi
deno --version
slack version
```

Expected: Deno reports `2.9.7`; Slack CLI reports a 4.x release. If Slack's
installer proposes editing an rc file, decline and use the exported `PATH`
above.

- [ ] **Step 3: Create project configuration**

Create `deno.jsonc` with pinned SDK imports and one aggregate check task:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/denoland/deno/main/cli/schemas/config-file.v1.json",
  "fmt": {
    "include": [
      ".github",
      "README.md",
      "datastores",
      "docs",
      "domain",
      "functions",
      "manifest.ts",
      "tests",
      "triggers",
      "workflows"
    ]
  },
  "lint": {
    "include": [
      "datastores",
      "domain",
      "functions",
      "manifest.ts",
      "tests",
      "triggers",
      "workflows"
    ]
  },
  "lock": true,
  "tasks": {
    "check": "deno fmt --check && deno lint && deno test --allow-read && deno check manifest.ts triggers/*.ts workflows/*.ts functions/*.ts domain/*.ts datastores/*.ts"
  },
  "imports": {
    "@std/assert": "jsr:@std/assert@^1.0.15",
    "@std/testing": "jsr:@std/testing@^1.0.16",
    "deno-slack-sdk/": "https://deno.land/x/deno_slack_sdk@2.15.2/",
    "deno-slack-api/": "https://deno.land/x/deno_slack_api@2.9.3/"
  }
}
```

Create `.slack/hooks.json`:

```json
{
  "hooks": {
    "get-hooks": "deno run -q --allow-read --allow-net https://deno.land/x/deno_slack_hooks@1.5.0/mod.ts"
  }
}
```

Create `.slack/.gitignore`:

```gitignore
apps*.json
```

Create `.gitignore`:

```gitignore
.DS_Store
.env
.env.*
!.env.example
coverage/
dist/
```

- [ ] **Step 4: Resolve and commit the dependency lock**

Run:

```bash
deno cache --lock=deno.lock --lock-write \
  https://deno.land/x/deno_slack_sdk@2.15.2/mod.ts \
  https://deno.land/x/deno_slack_api@2.9.3/mod.ts
git add deno.jsonc deno.lock .slack/hooks.json .slack/.gitignore .gitignore
git commit -m "chore: initialize Slack Deno project"
```

Expected: dependency resolution exits 0 and the commit contains configuration
only.

### Task 2: Implement ticket parsing and response formatting with TDD

**Files:**

- Create first: `domain/tickets_test.ts`
- Create after RED: `domain/tickets.ts`

- [ ] **Step 1: Write failing parser/formatter tests**

Create `domain/tickets_test.ts`:

```ts
import { assertEquals } from "@std/assert";
import {
  buildDeduplicationKey,
  buildReplyText,
  extractTicketIds,
} from "./tickets.ts";

Deno.test("extractTicketIds normalizes and preserves unique first occurrence", () => {
  assertEquals(
    extractTicketIds("REQ-13981 req-14002 ReQ-13981"),
    ["REQ-13981", "REQ-14002"],
  );
});

Deno.test("extractTicketIds accepts unbounded digits and punctuation", () => {
  assertEquals(
    extractTicketIds("(REQ-1), REQ-12345678901234567890; REQ-123,456"),
    ["REQ-1", "REQ-12345678901234567890", "REQ-123"],
  );
});

Deno.test("extractTicketIds rejects malformed or embedded identifiers", () => {
  assertEquals(
    extractTicketIds("REQ- REQ-12A XREQ-12 REQ-12_more"),
    [],
  );
});

Deno.test("extractTicketIds recognizes Slack link-label text as delivered", () => {
  assertEquals(
    extractTicketIds("<https://example.invalid|REQ-123>"),
    ["REQ-123"],
  );
});

Deno.test("buildReplyText emits one Slack link per line", () => {
  assertEquals(
    buildReplyText(["REQ-13981", "REQ-14002"]),
    "REQ-13981: <https://support.alcf.anl.gov/helpdesk/tickets/13981>\n" +
      "REQ-14002: <https://support.alcf.anl.gov/helpdesk/tickets/14002>",
  );
});

Deno.test("buildDeduplicationKey distinguishes replies in one thread by sub-second message_ts", () => {
  assertEquals(
    buildDeduplicationKey("C123", "1700000000.000001"),
    "C123:1700000000.000001",
  );
  assertEquals(
    buildDeduplicationKey("C123", "1700000000.000002"),
    "C123:1700000000.000002",
  );
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
deno test domain/tickets_test.ts
```

Expected: failure because `domain/tickets.ts` does not exist.

- [ ] **Step 3: Implement the minimal pure helpers**

Create `domain/tickets.ts`:

```ts
const TICKET_PATTERN = /(?<![A-Za-z0-9_])REQ-([0-9]+)(?![A-Za-z0-9_])/gi;
const TICKET_BASE_URL = "https://support.alcf.anl.gov/helpdesk/tickets";

export function extractTicketIds(text: string): string[] {
  const seen = new Set<string>();
  const tickets: string[] = [];
  for (const match of text.matchAll(TICKET_PATTERN)) {
    const ticket = `REQ-${match[1]}`;
    if (!seen.has(ticket)) {
      seen.add(ticket);
      tickets.push(ticket);
    }
  }
  return tickets;
}

export function buildReplyText(ticketIds: readonly string[]): string {
  return ticketIds.map((ticket) => {
    const number = ticket.slice("REQ-".length);
    return `${ticket}: <${TICKET_BASE_URL}/${number}>`;
  }).join("\n");
}

export function buildDeduplicationKey(
  channelId: string,
  sourceMessageTs: string,
): string {
  return `${channelId}:${sourceMessageTs}`;
}
```

- [ ] **Step 4: Run GREEN and static checks for this unit**

Run:

```bash
deno test domain/tickets_test.ts
deno fmt --check domain
deno lint domain
deno check domain/tickets.ts domain/tickets_test.ts
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add domain/tickets.ts domain/tickets_test.ts
git commit -m "feat: parse and format ALCF ticket links"
```

### Task 3: Define the expiring processed-message datastore

**Files:**

- Create first: `tests/datastore_test.ts`
- Create after RED: `datastores/processed_messages.ts`

- [ ] **Step 1: Write the failing schema test**

Create `tests/datastore_test.ts`:

```ts
import { assertEquals } from "@std/assert";
import ProcessedMessages from "../datastores/processed_messages.ts";

Deno.test("processed message datastore is privacy-minimized and TTL-enabled", () => {
  assertEquals(ProcessedMessages.definition.name, "ProcessedMessages");
  assertEquals(ProcessedMessages.definition.primary_key, "source_key");
  assertEquals(
    ProcessedMessages.definition.time_to_live_attribute,
    "expires_at",
  );
  assertEquals(
    Object.keys(ProcessedMessages.definition.attributes).sort(),
    ["created_at", "expires_at", "reply_ts", "source_key"],
  );
});
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
deno test tests/datastore_test.ts
```

Expected: failure because `datastores/processed_messages.ts` does not exist.

- [ ] **Step 3: Implement the datastore definition**

Create `datastores/processed_messages.ts`:

```ts
import { DefineDatastore, Schema } from "deno-slack-sdk/mod.ts";

const ProcessedMessages = DefineDatastore({
  name: "ProcessedMessages",
  primary_key: "source_key",
  time_to_live_attribute: "expires_at",
  attributes: {
    source_key: { type: Schema.types.string },
    created_at: { type: Schema.slack.types.timestamp },
    expires_at: { type: Schema.slack.types.timestamp },
    reply_ts: { type: Schema.slack.types.message_ts },
  },
});

export default ProcessedMessages;
```

- [ ] **Step 4: Run GREEN and commit**

```bash
deno test tests/datastore_test.ts
deno check datastores/processed_messages.ts tests/datastore_test.ts
git add datastores/processed_messages.ts tests/datastore_test.ts
git commit -m "feat: add processed message datastore"
```

Expected: tests/type check pass and the schema includes no message text, user
ID, or ticket ID field.

### Task 4: Implement the Slack function adapter with TDD

**Files:**

- Create first: `functions/link_tickets_test.ts`
- Create after RED: `functions/link_tickets.ts`

- [ ] **Step 1: Write a reusable Slack API fetch stub in the test file**

Create `functions/link_tickets_test.ts` with a request recorder that returns
queued JSON by method endpoint:

```ts
import { assertEquals, assertStringIncludes } from "@std/assert";
import { stub } from "@std/testing/mock";
import LinkTickets from "./link_tickets.ts";
import { SlackFunctionTester } from "deno-slack-sdk/mod.ts";

const { createContext } = SlackFunctionTester("link_tickets");

type RecordedRequest = { method: string; body: FormData };

function slackFetchStub(
  responses: Record<string, Array<Record<string, unknown>>>,
  recorded: RecordedRequest[],
) {
  return stub(
    globalThis,
    "fetch",
    async (url: string | URL | Request, options?: RequestInit) => {
      const request = url instanceof Request ? url : new Request(url, options);
      const method = request.url.split("/").at(-1)!;
      const body = await request.formData();
      recorded.push({ method, body });
      const response = responses[method]?.shift();
      if (!response) throw new Error(`Unexpected Slack method: ${method}`);
      return new Response(JSON.stringify(response), { status: 200 });
    },
  );
}

function inputs(overrides: Record<string, string> = {}) {
  return {
    channel_id: "C123",
    channel_type: "public",
    source_message_ts: "1700000000.000001",
    reply_root_ts: "1700000000.000001",
    text: "See REQ-13981",
    user_id: "U123",
    ...overrides,
  };
}
```

- [ ] **Step 2: Add no-op and origin-validation tests**

Append tests asserting:

```ts
Deno.test("no ticket is a successful no-op", async () => {
  const recorded: RecordedRequest[] = [];
  using _fetch = slackFetchStub({}, recorded);
  const result = await LinkTickets(createContext({
    inputs: inputs({ text: "nothing to link" }),
  }));
  assertEquals(result.error, undefined);
  assertEquals(recorded, []);
});

Deno.test("missing user or unsupported channel is a successful no-op", async () => {
  for (
    const invalid of [
      inputs({ user_id: "" }),
      inputs({ channel_type: "im" }),
      inputs({ channel_type: "mpdm" }),
    ]
  ) {
    const recorded: RecordedRequest[] = [];
    using _fetch = slackFetchStub({}, recorded);
    const result = await LinkTickets(createContext({ inputs: invalid }));
    assertEquals(result.error, undefined);
    assertEquals(recorded, []);
  }
});
```

- [ ] **Step 3: Add happy-path and sequential-retry tests**

Append tests that queue these API responses:

```ts
{
  "apps.datastore.get": [{ ok: true, item: {} }],
  "chat.postMessage": [{ ok: true, channel: "C123", ts: "1700000002.1" }],
  "apps.datastore.put": [{ ok: true, datastore: "ProcessedMessages" }],
}
```

Assert the method order is `apps.datastore.get`, `chat.postMessage`,
`apps.datastore.put`; decode `text`, `channel`, and `thread_ts` from the
recorded form body; verify one reply contains all unique links; and verify the
datastore key is `C123:1700000001.000001`.

Add a second test with:

```ts
{
  "apps.datastore.get": [{
    ok: true,
    item: {
      source_key: "C123:1700000001.000001",
      expires_at: 4102444800,
      reply_ts: "1700000002.1",
    },
  }],
}
```

Assert no post or write occurs.

- [ ] **Step 4: Add expired-record and failure-path tests**

Append tests for:

- expired record (`expires_at: 1`) → posts and rewrites;
- datastore get `{ok:false,error:"datastore_error"}` → returns error and does
  not post;
- `chat.postMessage` `{ok:false,error:"ratelimited"}` → returns error and does
  not write;
- successful post followed by datastore put failure → returns an error
  containing `duplicate-risk`.

Use `assertStringIncludes(result.error!, "...")` for stable error fragments; do
not assert volatile full messages.

- [ ] **Step 5: Run and verify RED**

Run:

```bash
deno test functions/link_tickets_test.ts
```

Expected: failure because `functions/link_tickets.ts` does not exist.

- [ ] **Step 6: Implement the function definition and handler**

Create `functions/link_tickets.ts` with:

```ts
import { DefineFunction, Schema, SlackFunction } from "deno-slack-sdk/mod.ts";
import ProcessedMessages from "../datastores/processed_messages.ts";
import {
  buildDeduplicationKey,
  buildReplyText,
  extractTicketIds,
} from "../domain/tickets.ts";

const RETENTION_SECONDS = 24 * 60 * 60;

export const LinkTicketsDefinition = DefineFunction({
  callback_id: "link_tickets",
  title: "Link ALCF support tickets",
  description: "Reply with links for ALCF REQ identifiers",
  source_file: "functions/link_tickets.ts",
  input_parameters: {
    properties: {
      channel_id: { type: Schema.slack.types.channel_id },
      channel_type: { type: Schema.types.string },
      // source_message_ts: the precise Slack message_ts of THIS specific message.
      //   Top-level trigger maps data.message_ts -> source_message_ts.
      //   Thread-reply trigger maps data.thread_ts -> source_message_ts.
      source_message_ts: { type: Schema.slack.types.message_ts },
      // reply_root_ts: the thread root for chat.postMessage.
      //   Both triggers map data.message_ts -> reply_root_ts.
      reply_root_ts: { type: Schema.slack.types.message_ts },
      text: { type: Schema.types.string },
      user_id: { type: Schema.types.string },
    },
    required: [
      "channel_id",
      "channel_type",
      "source_message_ts",
      "reply_root_ts",
      "text",
      "user_id",
    ],
  },
  output_parameters: { properties: {}, required: [] },
});

export default SlackFunction(
  LinkTicketsDefinition,
  async ({ inputs, client }) => {
    if (
      !inputs.user_id || !["public", "private"].includes(inputs.channel_type)
    ) {
      return { outputs: {} };
    }

    const ticketIds = extractTicketIds(inputs.text);
    if (ticketIds.length === 0) return { outputs: {} };

    // Dedup key uses source_message_ts (sub-second precision) to prevent
    // collision for two messages in the same channel within one second.
    const sourceKey = buildDeduplicationKey(
      inputs.channel_id,
      inputs.source_message_ts,
    );
    const now = Math.floor(Date.now() / 1000);
    const getResponse = await client.apps.datastore.get<
      typeof ProcessedMessages.definition
    >({ datastore: ProcessedMessages.name, id: sourceKey });
    if (!getResponse.ok) {
      return { error: `datastore-read-failed: ${getResponse.error}` };
    }
    if (getResponse.item?.source_key && getResponse.item.expires_at > now) {
      return { outputs: {} };
    }

    const postResponse = await client.chat.postMessage({
      channel: inputs.channel_id,
      thread_ts: inputs.reply_root_ts,
      text: buildReplyText(ticketIds),
      unfurl_links: false,
      unfurl_media: false,
    });
    if (!postResponse.ok || !postResponse.ts) {
      return { error: `message-post-failed: ${postResponse.error}` };
    }

    const putResponse = await client.apps.datastore.put<
      typeof ProcessedMessages.definition
    >({
      datastore: ProcessedMessages.name,
      item: {
        source_key: sourceKey,
        created_at: now,
        expires_at: now + RETENTION_SECONDS,
        reply_ts: postResponse.ts,
      },
    });
    if (!putResponse.ok) {
      return {
        error: `duplicate-risk: datastore-write-failed: ${putResponse.error}`,
      };
    }
    return { outputs: {} };
  },
);
```

There is no `source_event_timestamp` input and no `replyRootTimestamp` helper.
The dedup key comes directly from `inputs.source_message_ts`. The outgoing
`thread_ts` comes directly from `inputs.reply_root_ts`.

- [ ] **Step 7: Run GREEN, then refactor only while green**

Run:

```bash
deno test functions/link_tickets_test.ts
deno fmt --check functions domain datastores
deno lint functions domain datastores
deno check functions/link_tickets.ts functions/link_tickets_test.ts
```

Expected: all tests and checks pass. If the Slack client serializes JSON rather
than form data in the pinned SDK, update only the recorder helper to parse the
actual request representation observed during RED/GREEN runs.

- [ ] **Step 8: Commit**

```bash
git add functions/link_tickets.ts functions/link_tickets_test.ts
git commit -m "feat: link tickets from Slack messages"
```

### Task 5: Wire workflow, trigger, and manifest with structural tests

**Files:**

- Create first: `tests/configuration_test.ts`
- Create after RED: `workflows/link_tickets.ts`
- Create after RED: `triggers/message_posted_top_level.ts`
- Create after RED: `triggers/message_posted_thread_reply.ts`
- Create after RED: `manifest.ts`

- [ ] **Step 1: Write failing configuration tests**

Create `tests/configuration_test.ts`:

```ts
import { assertEquals } from "@std/assert";
import manifest from "../manifest.ts";
import topLevelTrigger from "../triggers/message_posted_top_level.ts";
import threadReplyTrigger from "../triggers/message_posted_thread_reply.ts";
import workflow from "../workflows/link_tickets.ts";

Deno.test("manifest requests only reviewed scopes", () => {
  assertEquals(
    [...manifest.botScopes].sort(),
    [
      "channels:history",
      "chat:write",
      "datastore:read",
      "datastore:write",
      "groups:history",
    ],
  );
});

Deno.test("top-level trigger covers joined resources, filters users and channel types, and requires thread_ts null", () => {
  assertEquals(topLevelTrigger.event.all_resources, true);
  assertEquals(
    topLevelTrigger.event.event_type,
    "slack#/events/message_posted",
  );
  const serialized = JSON.stringify(topLevelTrigger.event.filter);
  assertEquals(serialized.includes("data.user_id"), true);
  assertEquals(serialized.includes("data.channel_type"), true);
  // Top-level trigger must filter on thread_ts (== null) to exclude replies
  assertEquals(serialized.includes("data.thread_ts"), true);
});

Deno.test("thread-reply trigger covers joined resources, filters users and channel types, and requires thread_ts non-null", () => {
  assertEquals(threadReplyTrigger.event.all_resources, true);
  assertEquals(
    threadReplyTrigger.event.event_type,
    "slack#/events/message_posted",
  );
  const serialized = JSON.stringify(threadReplyTrigger.event.filter);
  assertEquals(serialized.includes("data.user_id"), true);
  assertEquals(serialized.includes("data.channel_type"), true);
  assertEquals(serialized.includes("data.thread_ts"), true);
});

Deno.test("workflow has one custom function step with six required inputs", () => {
  assertEquals(workflow.definition.callback_id, "link_tickets_workflow");
  assertEquals(workflow.definition.input_parameters.required.length, 6);
  // Confirm the corrected input names are present
  const required: string[] = workflow.definition.input_parameters.required;
  assertEquals(required.includes("source_message_ts"), true);
  assertEquals(required.includes("reply_root_ts"), true);
  // Confirm the old buggy input is gone
  assertEquals(required.includes("source_event_timestamp"), false);
});
```

If this first RED run shows that the public SDK objects expose a different path
than `definition`, inspect the actual exported objects and update the test's
property path while preserving the assertions' semantics; do not weaken or
delete an assertion merely to make it compile.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
deno test tests/configuration_test.ts
```

Expected: failure because workflow, trigger, and manifest modules do not exist.

- [ ] **Step 3: Implement the workflow**

Create `workflows/link_tickets.ts` defining these six required inputs:

```ts
channel_id: Schema.slack.types.channel_id;
channel_type: Schema.types.string;
source_message_ts: Schema.slack.types.message_ts;
reply_root_ts: Schema.slack.types.message_ts;
text: Schema.types.string;
user_id: Schema.types.string;
```

Set `callback_id` to `link_tickets_workflow`; add exactly one step using
`LinkTicketsDefinition`; map every workflow input directly to the matching
function input; export the workflow as default.

- [ ] **Step 4: Implement the two event triggers**

Create `triggers/message_posted_top_level.ts` for top-level messages
(`thread_ts == null`):

```ts
event_type: TriggerEventTypes.MessagePosted,
all_resources: true,
filter: {
  version: 1,
  root: {
    operator: "AND",
    inputs: [
      {
        operator: "NOT",
        inputs: [{ statement: "{{data.user_id}} == null" }],
      },
      {
        statement: "{{data.thread_ts}} == null",
      },
      {
        operator: "OR",
        inputs: [
          { statement: "{{data.channel_type}} == public" },
          { statement: "{{data.channel_type}} == private" },
        ],
      },
    ],
  },
},
```

Map inputs with `TriggerContextData.Event.MessagePosted`:

```ts
channel_id
channel_type
message_ts -> source_message_ts   // the message's own ts, also the thread root
message_ts -> reply_root_ts       // same: top-level message is its own root
text
user_id
```

Create `triggers/message_posted_thread_reply.ts` for thread replies
(`thread_ts != null`):

```ts
event_type: TriggerEventTypes.MessagePosted,
all_resources: true,
filter: {
  version: 1,
  root: {
    operator: "AND",
    inputs: [
      {
        operator: "NOT",
        inputs: [{ statement: "{{data.user_id}} == null" }],
      },
      {
        operator: "NOT",
        inputs: [{ statement: "{{data.thread_ts}} == null" }],
      },
      {
        operator: "OR",
        inputs: [
          { statement: "{{data.channel_type}} == public" },
          { statement: "{{data.channel_type}} == private" },
        ],
      },
    ],
  },
},
```

Map inputs with `TriggerContextData.Event.MessagePosted`:

```ts
channel_id
channel_type
thread_ts -> source_message_ts   // thread_ts is this reply's own timestamp in ROSI
message_ts -> reply_root_ts      // message_ts is the thread root timestamp in ROSI
text
user_id
```

Neither trigger passes `event_timestamp` to the function. The workflow and
function use only `source_message_ts` and `reply_root_ts`.

- [ ] **Step 5: Implement the manifest**

Create `manifest.ts`:

```ts
import { Manifest } from "deno-slack-sdk/mod.ts";
import ProcessedMessages from "./datastores/processed_messages.ts";
import LinkTicketsWorkflow from "./workflows/link_tickets.ts";

export default Manifest({
  name: "ALCF Ticket Linker",
  description: "Links ALCF support request IDs in Slack threads",
  workflows: [LinkTicketsWorkflow],
  datastores: [ProcessedMessages],
  outgoingDomains: [],
  botScopes: [
    "channels:history",
    "groups:history",
    "chat:write",
    "datastore:read",
    "datastore:write",
  ],
});
```

Do not add `chat:write.public`: the app should post only where it has been
added.

- [ ] **Step 6: Run GREEN and validate generated configuration**

Run:

```bash
deno test tests/configuration_test.ts
deno check manifest.ts workflows/link_tickets.ts triggers/message_posted_top_level.ts triggers/message_posted_thread_reply.ts
slack manifest validate
```

Expected: Deno tests/check pass. `slack manifest validate` passes without DM
scopes. If it requests `im:history` or `mpim:history`, stop and report the scope
conflict rather than adding them.

- [ ] **Step 7: Commit**

```bash
git add manifest.ts workflows/link_tickets.ts triggers/message_posted_top_level.ts triggers/message_posted_thread_reply.ts tests/configuration_test.ts
git commit -m "feat: wire Slack workflow and event trigger"
```

### Task 6: Add CI and operator documentation

**Files:**

- Create: `.github/workflows/ci.yml`
- Create: `README.md`
- Create: `docs/runbook.md`

Configuration and prose files do not need unit-test-first treatment, but their
commands must be executed before commit.

- [ ] **Step 1: Create GitHub Actions CI**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  deno:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v7
      - uses: denoland/setup-deno@v2
        with:
          deno-version: v2.9.7
      - run: deno task check
```

- [ ] **Step 2: Write the README**

Create `README.md` with:

- behavior and exact `REQ-<digits>` examples;
- public/private channel scope and explicit DM exclusion;
- thread semantics under ROSI;
- best-effort, non-atomic duplicate suppression limitation;
- privacy statement listing the four datastore fields;
- prerequisites: paid Slack plan, CELS admin approval, Deno, Slack CLI;
- local verification command: `deno task check`;
- pointer to `docs/runbook.md` and the design specification.

- [ ] **Step 3: Write the deployment and rollback runbook**

Create `docs/runbook.md` with exact operator commands and checkpoints:

```bash
export DENO_INSTALL="$HOME/.local/deno"
export PATH="$DENO_INSTALL/bin:$HOME/.slack/bin:$HOME/.local/bin:$PATH"
deno task check
slack login
slack auth list
slack manifest validate
slack run
slack trigger create --trigger-def triggers/message_posted_top_level.ts
slack trigger create --trigger-def triggers/message_posted_thread_reply.ts
slack deploy
slack trigger create --trigger-def triggers/message_posted_top_level.ts
slack trigger create --trigger-def triggers/message_posted_thread_reply.ts
slack activity --tail
```

Explain that local and deployed apps have distinct IDs/triggers, so the trigger
must be created for the selected deployed environment. Require the operator to
record the deployed app ID and trigger ID locally in an ignored file, never in
Git.

Include the five smoke-test cases from the specification and a results table
with fields: UTC time, app ID suffix, trigger ID suffix, channel ID suffix,
case, observed result, pass/fail. Do not record message text or ticket IDs.

Include rollback:

```bash
slack trigger delete --trigger-id "$TRIGGER_ID"
slack uninstall --app "$APP_ID"
```

Before finalizing the runbook, run `slack trigger delete --help`,
`slack uninstall --help`, and the help command for every other lifecycle command
shown; correct the examples to match the installed Slack CLI 4.x output.

- [ ] **Step 4: Run documentation/configuration checks**

Run:

```bash
deno fmt --check
deno lint
deno test --allow-read
deno check manifest.ts triggers/*.ts workflows/*.ts functions/*.ts domain/*.ts datastores/*.ts
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml README.md docs/runbook.md
git commit -m "docs: add CI and deployment runbook"
```

### Task 7: Full local verification and independent review

**Files:**

- Modify only if verification or review finds a defect; every code fix requires
  a failing regression test first.

- [ ] **Step 1: Run the complete local gate from a clean process**

Run:

```bash
deno task check
slack manifest validate
git diff --check
git status --short
```

Expected: all checks pass; status contains only intentionally uncommitted
changes, preferably none.

- [ ] **Step 2: Audit requirements mechanically**

Verify each item explicitly:

```bash
rg 'im:|mpim:|chat:write.public' manifest.ts triggers workflows functions || true
rg 'support.alcf.anl.gov/helpdesk/tickets' domain functions
rg 'all_resources' triggers/message_posted_top_level.ts triggers/message_posted_thread_reply.ts
rg 'thread_ts' triggers workflows functions domain
rg 'message text|user identity|ticket IDs' docs/superpowers/specs/2026-09-29-alcf-ticket-linker-design.md README.md
```

Expected:

- no forbidden DM or public-posting scopes;
- exactly one support URL constant in production code;
- `all_resources: true` present;
- `thread_ts` appears only as the outgoing `chat.postMessage` argument, not as
  trigger/workflow input;
- privacy documentation remains present.

- [ ] **Step 3: Request independent code review**

Ask the reviewer to compare the implementation to every FR-1 through FR-9
requirement, inspect real SDK types, and classify findings as Critical,
Important, or Minor. Critical/Important findings block merge.

- [ ] **Step 4: Resolve findings with TDD and rerun the full gate**

For each code defect, write a failing regression test, observe RED, implement
the minimal fix, then rerun:

```bash
deno task check
slack manifest validate
git diff --check
```

Expected: all pass with no unresolved Critical/Important findings.

- [ ] **Step 5: Commit review fixes if any**

```bash
git add -A
git commit -m "fix: address ticket linker review findings"
```

Skip the commit only when there are no changes.

### Task 8: Ship the reviewed implementation branch

**Files:**

- No source changes expected.

- [ ] **Step 1: Push the feature branch**

```bash
git push -u origin HEAD
```

- [ ] **Step 2: Open a pull request with exact verification evidence**

Write the PR body to a file and use `gh pr create --body-file`. Include:

- architecture summary;
- explicit at-least-once/best-effort deduplication limitation;
- exact output from `deno task check` and `slack manifest validate`;
- confirmation that no Slack/Freshworks secrets are committed;
- deployment blocker: CELS authorization/admin approval and live smoke test.

- [ ] **Step 3: Verify PR identity and CI**

Run:

```bash
gh pr view --json author,baseRefName,headRefName,files,url
gh pr checks --watch
```

Expected: author `jtchilders-ai-assistant`, base `main`, intended feature head,
only planned files, all checks pass.

- [ ] **Step 4: Merge only after independent approval and green CI**

Use the repository's allowed merge method. Then verify:

```bash
git checkout main
git pull --ff-only origin main
local_sha=$(git rev-parse HEAD)
origin_sha=$(git rev-parse origin/main)
remote_sha=$(gh api repos/jtchilders-ai-assistant/alcf-ticket-linker/commits/main --jq .sha)
test "$local_sha" = "$origin_sha"
test "$local_sha" = "$remote_sha"
```

Expected: all three SHAs match. Remove the feature worktree and local feature
branch after merge.

### Task 9: Deploy to CELS and perform live acceptance testing

**Files:**

- Modify: `docs/runbook.md` only to record privacy-safe smoke-test outcomes.

This task requires Taylor or a CELS administrator for workspace authorization
and approval. Do not claim deployment completion from local tests.

- [ ] **Step 1: Authenticate and confirm the exact target**

```bash
slack login
slack auth list
```

Expected: an authorized entry for `cels-anl.slack.com`. If absent, stop for
Taylor's browser-based Slack authorization.

- [ ] **Step 2: Validate and deploy**

```bash
slack manifest validate
slack deploy
```

Expected: validation succeeds and Slack returns a deployed app identifier. Read
back the deployed manifest and confirm only the reviewed scopes.

- [ ] **Step 3: Create the deployed event trigger**

```bash
slack trigger create --trigger-def triggers/message_posted_top_level.ts
slack trigger create --trigger-def triggers/message_posted_thread_reply.ts
slack trigger list
```

Expected: one deployed `message_posted` trigger with `all_resources: true`. Save
its ID to ignored local operator notes.

- [ ] **Step 4: Have an authorized CELS member add the app to one controlled
      channel**

Do not add it broadly until smoke testing succeeds. Confirm app membership
before sending tests.

- [ ] **Step 5: Execute and record all smoke tests**

Test:

1. mixed-case single ticket in a top-level message;
2. two tickets plus a duplicate in an existing thread reply;
3. bot response does not recurse;
4. malformed/no-ticket message produces no response;
5. sequential duplicate delivery does not produce a second response where Slack
   tooling permits replay.

Observe the actual thread placement and `slack activity` output. Record only
suffixes and pass/fail in `docs/runbook.md`.

- [ ] **Step 6: Commit smoke-test evidence and verify deployed state**

```bash
git add docs/runbook.md
git commit -m "docs: record CELS deployment verification"
git push
slack trigger list
slack activity --limit 20
```

Read back the exact trigger/app target before reporting production success. If
any smoke test fails, disable/delete the trigger first, then diagnose through a
failing regression test.
