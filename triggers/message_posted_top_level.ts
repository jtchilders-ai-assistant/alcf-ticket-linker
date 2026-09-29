import { TriggerContextData, TriggerEventTypes } from "deno-slack-api/mod.ts";
import { TriggerTypes } from "deno-slack-api/mod.ts";
import LinkTicketsWorkflow from "../workflows/link_tickets.ts";

/**
 * Top-level message trigger (thread_ts == null).
 *
 * source_message_ts ← data.message_ts  (the top-level message's own ts)
 * reply_root_ts     ← data.message_ts  (top-level message is its own root)
 */
const topLevelTrigger = {
  type: TriggerTypes.Event,
  name: "Link tickets — top-level messages",
  description: "Fires on new top-level channel messages (not thread replies)",
  workflow: `#/workflows/${LinkTicketsWorkflow.definition.callback_id}`,
  inputs: {
    channel_id: {
      value: TriggerContextData.Event.MessagePosted.channel_id,
    },
    channel_type: {
      value: TriggerContextData.Event.MessagePosted.channel_type,
    },
    // Top-level: message_ts is the message itself AND the thread root
    source_message_ts: {
      value: TriggerContextData.Event.MessagePosted.message_ts,
    },
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
            // Top-level messages only: thread_ts is null
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
  },
};

export default topLevelTrigger;
