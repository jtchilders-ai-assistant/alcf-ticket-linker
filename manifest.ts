import { Manifest } from "deno-slack-sdk/mod.ts";
import ProcessedMessages from "./datastores/processed_messages.ts";
import LinkTicketsWorkflow from "./workflows/link_tickets.ts";

export default Manifest({
  name: "ALCF Ticket Linker",
  description: "Links ALCF support request IDs in Slack threads",
  icon: "assets/icon.png",
  workflows: [LinkTicketsWorkflow],
  datastores: [ProcessedMessages],
  outgoingDomains: [],
  botScopes: [
    "channels:history",
    "groups:history",
    "chat:write",
    "datastore:read",
    "datastore:write",
  ],
});
