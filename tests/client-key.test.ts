import { it, expect } from "vitest";
import { clientKey } from "../src/client-key";
it("groups equivalent and rotated IPv6 addresses while preserving separate IPv4 peers", () => {
  expect(clientKey("2001:db8:1234:5678::1")).toBe(
    clientKey("2001:0db8:1234:5678:abcd:0:0:ffff"),
  );
  expect(clientKey("2001:db8:1234:5679::1")).not.toBe(
    clientKey("2001:db8:1234:5678::1"),
  );
  expect(clientKey("192.0.2.1")).not.toBe(clientKey("192.0.2.2"));
  expect(clientKey("::ffff:192.0.2.1")).toBe(clientKey("::ffff:c000:201"));
  expect(clientKey("untrusted text")).toBe("unknown");
});
