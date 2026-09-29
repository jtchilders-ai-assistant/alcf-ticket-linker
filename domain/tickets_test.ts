import { assertEquals } from "@std/assert";
import {
  buildDeduplicationKey,
  buildReplyText,
  extractTicketIds,
} from "./tickets.ts";

Deno.test("extractTicketIds normalizes and preserves unique first occurrence", () => {
  assertEquals(
    extractTicketIds("REQ-13981 req-14002 ReQ-13981"),
    ["REQ-13981", "REQ-14002"],
  );
});

Deno.test("extractTicketIds accepts unbounded digits and punctuation", () => {
  assertEquals(
    extractTicketIds("(REQ-1), REQ-12345678901234567890; REQ-123,456"),
    ["REQ-1", "REQ-12345678901234567890", "REQ-123"],
  );
});

Deno.test("extractTicketIds rejects malformed or embedded identifiers", () => {
  assertEquals(
    extractTicketIds("REQ- REQ-12A XREQ-12 REQ-12_more"),
    [],
  );
});

Deno.test("extractTicketIds recognizes Slack link-label text as delivered", () => {
  assertEquals(
    extractTicketIds("<https://example.invalid|REQ-123>"),
    ["REQ-123"],
  );
});

Deno.test("buildReplyText emits one Slack link per line", () => {
  assertEquals(
    buildReplyText(["REQ-13981", "REQ-14002"]),
    "REQ-13981: <https://support.alcf.anl.gov/helpdesk/tickets/13981>\n" +
      "REQ-14002: <https://support.alcf.anl.gov/helpdesk/tickets/14002>",
  );
});

Deno.test("buildDeduplicationKey distinguishes replies in one thread by sub-second message_ts", () => {
  // Two replies arriving in the same wall-clock second but with distinct
  // Slack message_ts fractional parts must produce distinct dedup keys.
  // This is the property that prevents the whole-second event_timestamp collision.
  assertEquals(
    buildDeduplicationKey("C123", "1700000000.000001"),
    "C123:1700000000.000001",
  );
  assertEquals(
    buildDeduplicationKey("C123", "1700000000.000002"),
    "C123:1700000000.000002",
  );
});

Deno.test("buildDeduplicationKey distinguishes top-level messages in the same channel", () => {
  assertEquals(
    buildDeduplicationKey("C123", "1700000001.000001"),
    "C123:1700000001.000001",
  );
  assertEquals(
    buildDeduplicationKey("C456", "1700000001.000001"),
    "C456:1700000001.000001",
  );
});
