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

/**
 * Build the idempotency key for a source message.
 *
 * The key is channel_id + source_message_ts, where source_message_ts is
 * the Slack message_ts of THIS specific message (fractional-second precision).
 * Using message_ts instead of a whole-second event_timestamp prevents a
 * collision when two messages arrive in the same channel within one second.
 *
 * Trigger mapping (two triggers, one function):
 *   Top-level message: data.message_ts → source_message_ts
 *   Thread reply:      data.thread_ts  → source_message_ts
 *                      data.message_ts → reply_root_ts (for chat.postMessage)
 */
export function buildDeduplicationKey(
  channelId: string,
  sourceMessageTs: string,
): string {
  return `${channelId}:${sourceMessageTs}`;
}
