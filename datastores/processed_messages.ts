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
