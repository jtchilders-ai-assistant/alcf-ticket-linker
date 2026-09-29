import { assertEquals } from "@std/assert";
import manifest from "../manifest.ts";
import topLevelTrigger from "../triggers/message_posted_top_level.ts";
import threadReplyTrigger from "../triggers/message_posted_thread_reply.ts";
import workflow from "../workflows/link_tickets.ts";

const userPresent = {
  operator: "NOT",
  inputs: [{ statement: "{{data.user_id}} == null" }],
};

const supportedChannel = {
  operator: "OR",
  inputs: [
    { statement: "{{data.channel_type}} == public" },
    { statement: "{{data.channel_type}} == private" },
  ],
};

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

Deno.test("manifest icon is a committed PNG", async () => {
  const icon = await Deno.readFile(
    new URL("../assets/icon.png", import.meta.url),
  );
  assertEquals([...icon.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

Deno.test(
  "top-level trigger covers joined resources, filters users and channel types, and requires thread_ts null",
  () => {
    assertEquals(topLevelTrigger.event.all_resources, true);
    assertEquals(
      topLevelTrigger.event.event_type,
      "slack#/events/message_posted",
    );
    assertEquals(topLevelTrigger.event.filter, {
      version: 1,
      root: {
        operator: "AND",
        inputs: [
          userPresent,
          { statement: "{{data.thread_ts}} == null" },
          supportedChannel,
        ],
      },
    });
    assertEquals(
      topLevelTrigger.inputs.source_message_ts.value,
      "{{data.message_ts}}",
    );
    assertEquals(
      topLevelTrigger.inputs.reply_root_ts.value,
      "{{data.message_ts}}",
    );
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
    assertEquals(threadReplyTrigger.event.filter, {
      version: 1,
      root: {
        operator: "AND",
        inputs: [
          userPresent,
          {
            operator: "NOT",
            inputs: [{ statement: "{{data.thread_ts}} == null" }],
          },
          supportedChannel,
        ],
      },
    });
    assertEquals(
      threadReplyTrigger.inputs.source_message_ts.value,
      "{{data.thread_ts}}",
    );
    assertEquals(
      threadReplyTrigger.inputs.reply_root_ts.value,
      "{{data.message_ts}}",
    );
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
  assertEquals(workflow.steps.length, 1);
  assertEquals(
    (workflow.steps[0] as unknown as { functionReference: string })
      .functionReference,
    "#/functions/link_tickets",
  );
});
