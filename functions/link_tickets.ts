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
      // source_message_ts: the precise Slack message_ts of THIS message.
      //   Top-level trigger maps data.message_ts → source_message_ts.
      //   Thread-reply trigger maps data.thread_ts → source_message_ts
      //   (thread_ts is the reply's own timestamp in ROSI semantics).
      source_message_ts: { type: Schema.slack.types.message_ts },
      // reply_root_ts: the thread root to target with chat.postMessage.
      //   Both triggers map data.message_ts → reply_root_ts:
      //     Top-level: message_ts is the message itself (acts as root).
      //     Thread-reply: message_ts is the thread root in ROSI semantics.
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
    // Origin guard: ignore DMs, MPDMs, and bot-only messages
    if (
      !inputs.user_id ||
      !["public", "private"].includes(inputs.channel_type)
    ) {
      return { outputs: {} };
    }

    const ticketIds = extractTicketIds(inputs.text);
    if (ticketIds.length === 0) return { outputs: {} };

    // Deduplication key: channel_id + source_message_ts (sub-second precision).
    // Using message_ts guarantees distinct keys for two messages in the same
    // channel in the same wall-clock second — the whole-second event_timestamp
    // could not provide this guarantee.
    const sourceKey = buildDeduplicationKey(
      inputs.channel_id,
      inputs.source_message_ts,
    );

    // Best-effort sequential retry suppression via expiring datastore record.
    // Fail-closed: a read failure blocks posting to avoid duplicate spam.
    const getResponse = await client.apps.datastore.get<
      typeof ProcessedMessages.definition
    >({ datastore: ProcessedMessages.name, id: sourceKey });

    if (!getResponse.ok) {
      return { error: `datastore-read-failed: ${getResponse.error}` };
    }

    // Suppress if an unexpired record already exists for this event.
    const now = Math.floor(Date.now() / 1000);
    if (
      getResponse.item?.source_key &&
      (getResponse.item.expires_at as number) > now
    ) {
      return { outputs: {} };
    }

    // Post the ticket link list as a thread reply.
    // reply_root_ts is the thread root for both top-level and threaded messages.
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

    // Record success so sequential re-deliveries are suppressed for 24 hours.
    // A write failure does not un-post the message; we surface the risk so
    // operators can detect and handle potential duplicates.
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
