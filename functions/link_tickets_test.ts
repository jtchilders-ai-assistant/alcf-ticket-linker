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
// Input factory — ensures deterministic wall-clock-independent inputs.
// source_event_timestamp is a Slack timestamp (number = Unix epoch seconds).
// ---------------------------------------------------------------------------

function inputs(overrides: Record<string, string | number> = {}) {
  return {
    channel_id: "C123",
    channel_type: "public",
    message_ts: "1700000000.000001",
    source_event_timestamp: 1700000001, // number, per SDK schema
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
// Happy path: first delivery
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

  // Datastore get: correct deduplication key
  assertEquals(
    recorded[0].params.get("id"),
    "C123:1700000001",
  );

  // Post: channel, thread_ts, text contain the link
  assertEquals(recorded[1].params.get("channel"), "C123");
  assertEquals(recorded[1].params.get("thread_ts"), "1700000000.000001");
  assertStringIncludes(
    recorded[1].params.get("text")!,
    "support.alcf.anl.gov/helpdesk/tickets/13981",
  );

  // Datastore put: key matches
  const putItem = JSON.parse(recorded[2].params.get("item")!);
  assertEquals(putItem.source_key, "C123:1700000001");
  assertEquals(putItem.reply_ts, "1700000002.1");
});

// ---------------------------------------------------------------------------
// Sequential-retry suppression: valid unexpired record → no post or write
// ---------------------------------------------------------------------------

Deno.test("unexpired suppression record prevents duplicate post", async () => {
  const recorded: RecordedRequest[] = [];
  // expires_at far in the future (year 2100); Date.now stub not needed because
  // the implementation compares expires_at > now; 4102444800 >> any real now.
  using _fetch = slackFetchStub(
    {
      "apps.datastore.get": [{
        ok: true,
        item: {
          source_key: "C123:1700000001",
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
  // expires_at = 1 (Jan 1 1970) is guaranteed expired vs. any real now
  using _fetch = slackFetchStub(
    {
      "apps.datastore.get": [{
        ok: true,
        item: {
          source_key: "C123:1700000001",
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

  // Must not have attempted to post
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

  // Must not have attempted to write
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
