import { describe, expect, test } from "bun:test";
import { encodeCursor, decodeCursor } from "../src/cursors";

describe("cursors", () => {
  test("roundtrip preserves timestamp and id", () => {
    const ts = new Date("2026-08-20T14:32:00.000Z");
    const cursor = encodeCursor(ts, 42);
    const decoded = decodeCursor(cursor);
    expect(decoded.timestamp.toISOString()).toBe(ts.toISOString());
    expect(decoded.id).toBe(42);
  });

  test("encoded cursor is base64url (no +, /, or =)", () => {
    const cursor = encodeCursor(new Date("2026-01-01T00:00:00.000Z"), 999999);
    expect(cursor).not.toMatch(/[+/=]/);
  });

  test("decodeCursor returns null for malformed input", () => {
    expect(decodeCursor("not-base64!@#")).toBeNull();
    expect(decodeCursor("")).toBeNull();
  });
});
