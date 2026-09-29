import { assertEquals } from "@std/assert";
import ProcessedMessages from "../datastores/processed_messages.ts";

Deno.test("processed message datastore is privacy-minimized and TTL-enabled", () => {
  assertEquals(ProcessedMessages.definition.name, "ProcessedMessages");
  assertEquals(ProcessedMessages.definition.primary_key, "source_key");
  assertEquals(
    ProcessedMessages.definition.time_to_live_attribute,
    "expires_at",
  );
  assertEquals(
    Object.keys(ProcessedMessages.definition.attributes).sort(),
    ["created_at", "expires_at", "reply_ts", "source_key"],
  );
});
