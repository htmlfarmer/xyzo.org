import { describe, expect, test } from "bun:test";
import { normalizeUrl, normalizeEmail } from "../src/normalize";

describe("normalizeUrl", () => {
  test("lowercases host", () => {
    expect(normalizeUrl("https://EXAMPLE.com/x")).toBe("https://example.com/x");
  });
  test("upgrades http to https", () => {
    expect(normalizeUrl("http://example.com/x")).toBe("https://example.com/x");
  });
  test("strips fragment", () => {
    expect(normalizeUrl("https://example.com/x#section")).toBe("https://example.com/x");
  });
  test("strips trailing slash on path-less URLs", () => {
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com");
    expect(normalizeUrl("https://example.com")).toBe("https://example.com");
  });
  test("drops common tracking params", () => {
    expect(normalizeUrl("https://example.com/x?utm_source=tw&id=1"))
      .toBe("https://example.com/x?id=1");
    expect(normalizeUrl("https://example.com/x?fbclid=abc&y=2"))
      .toBe("https://example.com/x?y=2");
    expect(normalizeUrl("https://example.com/x?gclid=g&z=3"))
      .toBe("https://example.com/x?z=3");
  });
  test("preserves non-tracking params", () => {
    expect(normalizeUrl("https://example.com/x?a=1&b=2")).toBe("https://example.com/x?a=1&b=2");
  });
});

describe("normalizeEmail", () => {
  test("lowercases and trims", () => {
    expect(normalizeEmail("  Foo@Example.COM  ")).toBe("foo@example.com");
  });
  test("passes through already-normal email", () => {
    expect(normalizeEmail("a@b.co")).toBe("a@b.co");
  });
});