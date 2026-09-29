import { assertEquals, assertStringIncludes } from "@std/assert";
import { stub } from "@std/testing/mock";
import LinkTickets from "./link_tickets.ts";
import { SlackFunctionTester } from "deno-slack-sdk/mod.ts";

const { createContext } = SlackFunctionTester("link_tickets");

// ---------------------------------------------------------------------------
// Request recorder
// ---------------------------------------------------------------------------

type RecordedRequest = { method: string; params: URLSearchParams };

/**
 * Stubs globalThis.fetch with a queued-response recorder.
 * The SDK serialises requests as application/x-www-form-urlencoded.
 * Each call pops the first queued response for the matching method name.
 */
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
      const bodyText = await request.clone().text();
      const params = new URLSearchParams(bodyText);
      recorded.push({ method, params });
      const queue = responses[method];
      if (!queue || queue.length === 0) {
        throw new Error(`Unexpected Slack method call: ${method}`);
      }
      const response = queue.shift()!;
      return new Response(JSON.stringify(response), { status: 200 });
    },
  );
}

// ---------------------------------------------------------------------------
// Input factory
// ---------------------------------------------------------------------------
//
// NEW SEMANTICS (post-fix):
//   source_message_ts — the precise Slack message_ts of THIS specific message.
//     • Top-level trigger maps data.message_ts → source_message_ts.
//     • Thread-reply trigger maps data.thread_ts → source_message_ts
//       (thread_ts is the timestamp of the specific reply in ROSI semantics).
//   reply_root_ts — the message_ts to pass as chat.postMessage thread_ts.
//     • Top-level trigger maps data.message_ts → reply_root_ts (same value).
//     • Thread-reply trigger maps data.message_ts → reply_root_ts
//       (message_ts is the thread root in ROSI semantics for a reply).
//
// source_event_timestamp is REMOVED; the function no longer accepts it.

function inputs(overrides: Record<string, string | number> = {}) {
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

// ---------------------------------------------------------------------------
// No-op tests
// ---------------------------------------------------------------------------

Deno.test("no ticket is a successful no-op", async () => {
  const recorded: RecordedRequest[] = [];
  using _fetch = slackFetchStub({}, recorded);
  const result = await LinkTickets(
    createContext({ inputs: inputs({ text: "nothing to link" }) }),
  );
  assertEquals(result.error, undefined);
  assertEquals(recorded.length, 0);
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
    assertEquals(recorded.length, 0);
  }
});

// ---------------------------------------------------------------------------
// Happy path: first delivery — top-level message (source_message_ts == reply_root_ts)
// ---------------------------------------------------------------------------

Deno.test("happy path posts reply and writes datastore record", async () => {
  const recorded: RecordedRequest[] = [];
  using _fetch = slackFetchStub(
    {
      "apps.datastore.get": [{ ok: true, item: {} }],
      "chat.postMessage": [{ ok: true, channel: "C123", ts: "1700000002.1" }],
      "apps.datastore.put": [{ ok: true, datastore: "ProcessedMessages" }],
    },
    recorded,
  );

  const result = await LinkTickets(createContext({ inputs: inputs() }));
  assertEquals(result.error, undefined);

  // Exact method order
  assertEquals(recorded.map((r) => r.method), [
    "apps.datastore.get",
    "chat.postMessage",
    "apps.datastore.put",
  ]);

  // Deduplication key is channel_id + source_message_ts (message_ts precision)
  assertEquals(
    recorded[0].params.get("id"),
    "C123:1700000000.000001",
  );

  // Post: channel, thread_ts from reply_root_ts, text contains the link
  assertEquals(recorded[1].params.get("channel"), "C123");
  assertEquals(recorded[1].params.get("thread_ts"), "1700000000.000001");
  assertStringIncludes(
    recorded[1].params.get("text")!,
    "support.alcf.anl.gov/helpdesk/tickets/13981",
  );

  // Datastore put: key matches source_message_ts
  const putItem = JSON.parse(recorded[2].params.get("item")!);
  assertEquals(putItem.source_key, "C123:1700000000.000001");
  assertEquals(putItem.reply_ts, "1700000002.1");
});

// ---------------------------------------------------------------------------
// Happy path: thread reply (source_message_ts != reply_root_ts)
// The thread-reply trigger maps:
//   data.thread_ts (the reply's own ts) -> source_message_ts
//   data.message_ts (the thread root)   -> reply_root_ts
// So chat.postMessage must use reply_root_ts and the dedup key uses source_message_ts.
// ---------------------------------------------------------------------------

Deno.test("thread reply uses reply_root_ts for posting and source_message_ts for dedup key", async () => {
  const recorded: RecordedRequest[] = [];
  using _fetch = slackFetchStub(
    {
      "apps.datastore.get": [{ ok: true, item: {} }],
      "chat.postMessage": [{ ok: true, channel: "C123", ts: "1700000003.5" }],
      "apps.datastore.put": [{ ok: true, datastore: "ProcessedMessages" }],
    },
    recorded,
  );

  const result = await LinkTickets(
    createContext({
      inputs: inputs({
        source_message_ts: "1700000001.000002", // the thread_ts of this specific reply
        reply_root_ts: "1700000000.000001", // the root message_ts for chat.postMessage
        text: "REQ-14002",
      }),
    }),
  );
  assertEquals(result.error, undefined);

  // Dedup key uses source_message_ts (the reply's own timestamp, not root)
  assertEquals(recorded[0].params.get("id"), "C123:1700000001.000002");

  // Post: thread_ts is the root, not the reply's ts
  assertEquals(recorded[1].params.get("thread_ts"), "1700000000.000001");
  assertStringIncludes(
    recorded[1].params.get("text")!,
    "support.alcf.anl.gov/helpdesk/tickets/14002",
  );

  // Datastore put: key matches source_message_ts
  const putItem = JSON.parse(recorded[2].params.get("item")!);
  assertEquals(putItem.source_key, "C123:1700000001.000002");
});

// ---------------------------------------------------------------------------
// Regression: two distinct replies sharing the same root produce DISTINCT datastore IDs
// This is the core correctness fix: old code keyed on whole-second event_timestamp,
// so two replies at the same second would collide. New code uses the message_ts
// of each specific reply (sub-second precision), guaranteeing distinct keys.
// ---------------------------------------------------------------------------

Deno.test("regression: two replies with same root but distinct source_message_ts produce distinct datastore IDs", async () => {
  const sharedRoot = "1700000000.000001";

  const replyA = inputs({
    source_message_ts: "1700000050.000011", // reply A's own ts
    reply_root_ts: sharedRoot,
    text: "REQ-13981",
  });

  const replyB = inputs({
    source_message_ts: "1700000050.000012", // reply B's own ts — same second, different µs
    reply_root_ts: sharedRoot,
    text: "REQ-14002",
  });

  // Run each invocation in its own block so `using` disposes the stub before
  // the next one is created — stubs on globalThis.fetch cannot be stacked.
  let keyA: string;
  {
    const recordedA: RecordedRequest[] = [];
    using _fetchA = slackFetchStub(
      {
        "apps.datastore.get": [{ ok: true, item: {} }],
        "chat.postMessage": [{ ok: true, channel: "C123", ts: "1700000050.5" }],
        "apps.datastore.put": [{ ok: true, datastore: "ProcessedMessages" }],
      },
      recordedA,
    );
    const resultA = await LinkTickets(createContext({ inputs: replyA }));
    assertEquals(resultA.error, undefined);
    keyA = JSON.parse(recordedA[2].params.get("item")!).source_key;
  }

  let keyB: string;
  {
    const recordedB: RecordedRequest[] = [];
    using _fetchB = slackFetchStub(
      {
        "apps.datastore.get": [{ ok: true, item: {} }],
        "chat.postMessage": [{ ok: true, channel: "C123", ts: "1700000050.6" }],
        "apps.datastore.put": [{ ok: true, datastore: "ProcessedMessages" }],
      },
      recordedB,
    );
    const resultB = await LinkTickets(createContext({ inputs: replyB }));
    assertEquals(resultB.error, undefined);
    keyB = JSON.parse(recordedB[2].params.get("item")!).source_key;
  }

  // Keys MUST be distinct — this was the collision bug
  assertEquals(keyA, "C123:1700000050.000011");
  assertEquals(keyB, "C123:1700000050.000012");
  assertEquals(keyA === keyB, false);
});

// ---------------------------------------------------------------------------
// Sequential-retry suppression: valid unexpired record → no post or write
// ---------------------------------------------------------------------------

Deno.test("unexpired suppression record prevents duplicate post", async () => {
  const recorded: RecordedRequest[] = [];
  using _fetch = slackFetchStub(
    {
      "apps.datastore.get": [{
        ok: true,
        item: {
          source_key: "C123:1700000000.000001",
          expires_at: 4102444800,
          reply_ts: "1700000002.1",
        },
      }],
    },
    recorded,
  );

  const result = await LinkTickets(createContext({ inputs: inputs() }));
  assertEquals(result.error, undefined);

  // Only the read should have occurred; no post, no write
  assertEquals(recorded.map((r) => r.method), ["apps.datastore.get"]);
});

// ---------------------------------------------------------------------------
// Expired record → posts and rewrites
// ---------------------------------------------------------------------------

Deno.test("expired suppression record allows repost", async () => {
  const recorded: RecordedRequest[] = [];
  using _fetch = slackFetchStub(
    {
      "apps.datastore.get": [{
        ok: true,
        item: {
          source_key: "C123:1700000000.000001",
          expires_at: 1,
          reply_ts: "1700000002.0",
        },
      }],
      "chat.postMessage": [{ ok: true, channel: "C123", ts: "1700000005.0" }],
      "apps.datastore.put": [{ ok: true, datastore: "ProcessedMessages" }],
    },
    recorded,
  );

  const result = await LinkTickets(createContext({ inputs: inputs() }));
  assertEquals(result.error, undefined);
  assertEquals(recorded.map((r) => r.method), [
    "apps.datastore.get",
    "chat.postMessage",
    "apps.datastore.put",
  ]);
});

// ---------------------------------------------------------------------------
// Failure paths
// ---------------------------------------------------------------------------

Deno.test("datastore get failure returns error and does not post", async () => {
  const recorded: RecordedRequest[] = [];
  using _fetch = slackFetchStub(
    {
      "apps.datastore.get": [{ ok: false, error: "datastore_error" }],
    },
    recorded,
  );

  const result = await LinkTickets(createContext({ inputs: inputs() }));
  assertStringIncludes(result.error!, "datastore-read-failed");

  const methods = recorded.map((r) => r.method);
  assertEquals(methods.includes("chat.postMessage"), false);
});

Deno.test("chat.postMessage failure returns error and does not write datastore", async () => {
  const recorded: RecordedRequest[] = [];
  using _fetch = slackFetchStub(
    {
      "apps.datastore.get": [{ ok: true, item: {} }],
      "chat.postMessage": [{ ok: false, error: "ratelimited" }],
    },
    recorded,
  );

  const result = await LinkTickets(createContext({ inputs: inputs() }));
  assertStringIncludes(result.error!, "message-post-failed");

  const methods = recorded.map((r) => r.method);
  assertEquals(methods.includes("apps.datastore.put"), false);
});

Deno.test("post success followed by datastore put failure emits duplicate-risk error", async () => {
  const recorded: RecordedRequest[] = [];
  using _fetch = slackFetchStub(
    {
      "apps.datastore.get": [{ ok: true, item: {} }],
      "chat.postMessage": [{ ok: true, channel: "C123", ts: "1700000002.1" }],
      "apps.datastore.put": [{ ok: false, error: "capacity_exceeded" }],
    },
    recorded,
  );

  const result = await LinkTickets(createContext({ inputs: inputs() }));
  assertStringIncludes(result.error!, "duplicate-risk");
});

// ---------------------------------------------------------------------------
// Multiple tickets: all links appear in one reply
// ---------------------------------------------------------------------------

Deno.test("multiple tickets produce one reply containing all links", async () => {
  const recorded: RecordedRequest[] = [];
  using _fetch = slackFetchStub(
    {
      "apps.datastore.get": [{ ok: true, item: {} }],
      "chat.postMessage": [{ ok: true, channel: "C123", ts: "1700000002.1" }],
      "apps.datastore.put": [{ ok: true, datastore: "ProcessedMessages" }],
    },
    recorded,
  );

  const result = await LinkTickets(
    createContext({
      inputs: inputs({ text: "REQ-13981 and REQ-14002 and REQ-13981" }),
    }),
  );
  assertEquals(result.error, undefined);

  const text = recorded[1].params.get("text")!;
  assertStringIncludes(text, "13981");
  assertStringIncludes(text, "14002");
  // Duplicate normalised away — each ticket label appears exactly once
  assertEquals(text.match(/REQ-13981/g)?.length, 1);
});
