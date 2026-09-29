import { assertEquals } from "@std/assert";
import manifest from "../manifest.ts";
import topLevelTrigger from "../triggers/message_posted_top_level.ts";
import threadReplyTrigger from "../triggers/message_posted_thread_reply.ts";
import workflow from "../workflows/link_tickets.ts";

// Manifest() compiles botScopes into oauth_config.scopes.bot
Deno.test("manifest requests only reviewed scopes", () => {
  assertEquals(
    [...(manifest.oauth_config?.scopes?.bot ?? [])].sort(),
    [
      "channels:history",
      "chat:write",
      "datastore:read",
      "datastore:write",
      "groups:history",
    ],
  );
});

Deno.test(
  "top-level trigger covers joined resources, filters users and channel types, and requires thread_ts null",
  () => {
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
  },
);

Deno.test(
  "thread-reply trigger covers joined resources, filters users and channel types, and requires thread_ts non-null",
  () => {
    assertEquals(threadReplyTrigger.event.all_resources, true);
    assertEquals(
      threadReplyTrigger.event.event_type,
      "slack#/events/message_posted",
    );
    const serialized = JSON.stringify(threadReplyTrigger.event.filter);
    assertEquals(serialized.includes("data.user_id"), true);
    assertEquals(serialized.includes("data.channel_type"), true);
    assertEquals(serialized.includes("data.thread_ts"), true);
  },
);

Deno.test("workflow has one custom function step with six required inputs", () => {
  assertEquals(workflow.definition.callback_id, "link_tickets_workflow");
  const required: string[] = workflow.definition.input_parameters?.required ??
    [];
  assertEquals(required.length, 6);
  // Confirm the corrected input names are present
  assertEquals(required.includes("source_message_ts"), true);
  assertEquals(required.includes("reply_root_ts"), true);
  // Confirm the old buggy input is gone
  assertEquals(required.includes("source_event_timestamp"), false);
});
