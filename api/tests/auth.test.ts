import { describe, expect, test, beforeEach } from "bun:test";
import { parseAdminKey } from "../src/auth";

describe("parseAdminKey", () => {
  test("splits a valid key into key_id and secret", () => {
    const result = parseAdminKey("nk_live_abc123.xyz789");
    expect(result).not.toBeNull();
    expect(result!.keyId).toBe("nk_live_abc123");
    expect(result!.secret).toBe("xyz789");
    expect(result!.fullSecret).toBe("nk_live_abc123.xyz789");
  });

  test("returns null when no dot present", () => {
    expect(parseAdminKey("no-dot-here")).toBeNull();
  });

  test("returns null when empty or null", () => {
    expect(parseAdminKey("")).toBeNull();
    expect(parseAdminKey(null)).toBeNull();
  });
});
