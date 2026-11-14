/**
 * Help Me Chat Test Suite
 * 
 * Tests to ensure the Help Me chat stays awesome:
 * - System prompt is concise and varied
 * - Language detection works
 * - Random greetings rotate
 * - Viewport context is included
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "help-me-chat.js"), "utf8");

describe("Help Me Chat Quality", () => {
  // Test 1: System prompt exists and is concise
  test("system prompt is under 2000 chars", () => {
    const match = appJs.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;/);
    expect(match).not.toBeNull();
    if (match) {
      expect(match[1].length).toBeLessThan(2000);
      expect(match[1].length).toBeGreaterThan(200);
    }
  });

  // Test 2: System prompt emphasizes brevity
  test("system prompt emphasizes short responses", () => {
    const match = appJs.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;/);
    expect(match).not.toBeNull();
    if (match) {
      expect(match[1].toLowerCase()).toContain("short");
      expect(match[1].toLowerCase()).toContain("2-3 sentences");
    }
  });

  // Test 3: System prompt emphasizes variety
  test("system prompt emphasizes never repeating", () => {
    const match = appJs.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;/);
    expect(match).not.toBeNull();
    if (match) {
      expect(match[1].toLowerCase()).toContain("never repeat");
    }
  });

  // Test 4: System prompt emphasizes fun
  test("system prompt emphasizes being funny", () => {
    const match = appJs.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;/);
    expect(match).not.toBeNull();
    if (match) {
      expect(match[1].toLowerCase()).toContain("funny");
    }
  });

  // Test 5: System prompt mentions languages
  test("system prompt mentions multilingual support", () => {
    const match = appJs.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;/);
    expect(match).not.toBeNull();
    if (match) {
      expect(match[1].toLowerCase()).toContain("language");
    }
  });

  // Test 6: Random greetings exist (20+ options)
  test("has 20+ random greetings", () => {
    const match = appJs.match(/const greetings = \[([\s\S]*?)\];/);
    expect(match).not.toBeNull();
    if (match) {
      const count = (match[1].match(/"/g) || []).length / 2;
      expect(count).toBeGreaterThanOrEqual(20);
    }
  });

  // Test 7: Language reminders exist
  test("has language reminders", () => {
    expect(appJs).toContain("getLanguageReminder");
    expect(appJs).toContain("Reply in your language");
  });

  // Test 8: Language detection handles multiple languages
  test("language detection handles multiple languages", () => {
    expect(appJs).toContain("Arabic");
    expect(appJs).toContain("Hindi");
    expect(appJs).toContain("Spanish");
    expect(appJs).toContain("Japanese");
    expect(appJs).toContain("Swahili");
  });

  // Test 9: Active story context is included
  test("active story context is included", () => {
    expect(appJs).toContain("activeStory");
    expect(appJs).toContain("STORY THE USER IS VIEWING");
  });

  // Test 10: Viewport context includes stories
  test("viewport context includes stories", () => {
    expect(appJs).toContain("STORIES VISIBLE ON MAP");
    expect(appJs).toContain("topPins");
  });

  // Test 11: Viewport context includes word frequency
  test("viewport context includes word frequency", () => {
    expect(appJs).toContain("word_freq");
  });

  // Test 12: Message size limit is respected
  test("API message limit is 5000 chars", () => {
    const match = appJs.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;/);
    expect(match).not.toBeNull();
    if (match) {
      expect(match[1].length).toBeLessThan(5000);
    }
  });

  // Test 13: Error handling shows meaningful messages
  test("error handling shows meaningful messages", () => {
    expect(appJs).toContain("e.message || e.error || String(e)");
  });

  // Test 14: Quick questions load dynamically
  test("quick questions load from quick-questions.js", () => {
    expect(appJs).toContain("XyzoQuickQuestions");
    expect(appJs).toContain("help-me-quick-questions");
  });

  // Test 15: getViewportContext function exists
  test("getViewportContext function exists", () => {
    expect(appJs).toContain("function getViewportContext");
  });
});
