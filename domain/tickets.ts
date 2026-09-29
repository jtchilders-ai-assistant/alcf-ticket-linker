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

export function replyRootTimestamp(messageTs: string): string {
  return messageTs;
}

export function buildDeduplicationKey(
  channelId: string,
  sourceEventTimestamp: string,
): string {
  return `${channelId}:${sourceEventTimestamp}`;
}
