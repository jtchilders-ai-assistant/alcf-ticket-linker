import { DefineWorkflow, Schema } from "deno-slack-sdk/mod.ts";
import { LinkTicketsDefinition } from "../functions/link_tickets.ts";

const LinkTicketsWorkflow = DefineWorkflow({
  callback_id: "link_tickets_workflow",
  title: "Link ALCF Support Tickets",
  description: "Links ALCF REQ identifiers found in Slack messages",
  input_parameters: {
    properties: {
      channel_id: { type: Schema.slack.types.channel_id },
      channel_type: { type: Schema.types.string },
      source_message_ts: { type: Schema.slack.types.message_ts },
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
});

LinkTicketsWorkflow.addStep(LinkTicketsDefinition, {
  channel_id: LinkTicketsWorkflow.inputs.channel_id,
  channel_type: LinkTicketsWorkflow.inputs.channel_type,
  source_message_ts: LinkTicketsWorkflow.inputs.source_message_ts,
  reply_root_ts: LinkTicketsWorkflow.inputs.reply_root_ts,
  text: LinkTicketsWorkflow.inputs.text,
  user_id: LinkTicketsWorkflow.inputs.user_id,
});

export default LinkTicketsWorkflow;
