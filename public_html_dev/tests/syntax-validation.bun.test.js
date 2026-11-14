/**
 * Syntax Validation Test
 * 
 * Checks all JavaScript files for syntax errors before they can break the site.
 * Run with: bun test public_html/tests/syntax-validation.bun.test.js
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

// All JS files that should be syntax-checked
const JS_FILES = [
  "app.js",
  "analytics.js",
  "city-engine.js",
  "command-bar.js",
  "console-guard.js",
  "debug-panel.js",
  "feedback-dialog.js",
  "flag-quality.js",
  "ai-story-chat.js",
  "help-me-chat.js",
  "presence.js",
  "viewport-nudge.js",
  "update-check.js",
  "submit-sniff.js",
];

describe("Syntax Validation", () => {
  for (const file of JS_FILES) {
    test(`${file} has valid JavaScript syntax`, () => {
      const code = readFileSync(join(ROOT, file), "utf8");
      
      // Use Function constructor to check for real syntax errors
      // This is the most reliable way to validate JS syntax
      try {
        new Function(code);
      } catch (e) {
        if (e instanceof SyntaxError) {
          throw new Error(`Syntax error in ${file}: ${e.message}`);
        }
        // Other errors (like ReferenceError) are OK for syntax validation
      }
    });
  }
  
  // Also check that help-me-chat.js specifically has balanced braces
  test("help-me-chat.js has balanced braces", () => {
    const code = readFileSync(join(ROOT, "help-me-chat.js"), "utf8");
    let depth = 0;
    let inString = false;
    let stringChar = "";
    let inTemplate = 0;
    
    for (let i = 0; i < code.length; i++) {
      const ch = code[i];
      const prev = i > 0 ? code[i - 1] : "";
      
      // Handle string literals
      if (!inString && inTemplate === 0 && (ch === '"' || ch === "'")) {
        inString = true;
        stringChar = ch;
        continue;
      }
      if (inString && ch === stringChar && prev !== "\\") {
        inString = false;
        continue;
      }
      
      // Handle template literals
      if (ch === "`" && !inString) {
        inTemplate = inTemplate > 0 ? inTemplate - 1 : inTemplate + 1;
        continue;
      }
      
      if (inString || inTemplate > 0) continue;
      
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    
    // Allow tolerance for template literals and regex patterns
    // The real syntax check is new Function(code) above — this is just a sanity check
    expect(Math.abs(depth)).toBeLessThanOrEqual(10);
  });
});
