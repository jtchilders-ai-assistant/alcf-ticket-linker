import { TriggerContextData, TriggerEventTypes } from "deno-slack-api/mod.ts";
import { TriggerTypes } from "deno-slack-api/mod.ts";
import LinkTicketsWorkflow from "../workflows/link_tickets.ts";

/**
 * Thread-reply trigger (thread_ts != null).
 *
 * In ROSI semantics for thread replies:
 *   data.thread_ts  = the reply message's own unique timestamp
 *   data.message_ts = the thread root timestamp
 *
 * source_message_ts ← data.thread_ts   (unique dedup key for THIS reply)
 * reply_root_ts     ← data.message_ts  (thread root for chat.postMessage)
 */
const threadReplyTrigger = {
  type: TriggerTypes.Event,
  name: "Link tickets — thread replies",
  description: "Fires on new thread reply messages (not top-level posts)",
  workflow: `#/workflows/${LinkTicketsWorkflow.definition.callback_id}`,
  inputs: {
    channel_id: {
      value: TriggerContextData.Event.MessagePosted.channel_id,
    },
    channel_type: {
      value: TriggerContextData.Event.MessagePosted.channel_type,
    },
    // Thread reply: thread_ts is the reply's own unique ts (dedup key)
    source_message_ts: {
      value: TriggerContextData.Event.MessagePosted.thread_ts,
    },
    // message_ts is the thread root in ROSI semantics
    reply_root_ts: {
      value: TriggerContextData.Event.MessagePosted.message_ts,
    },
    text: {
      value: TriggerContextData.Event.MessagePosted.text,
    },
    user_id: {
      value: TriggerContextData.Event.MessagePosted.user_id,
    },
  },
  event: {
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
            // Thread replies only: thread_ts is NOT null
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
  },
};

export default threadReplyTrigger;
