// Unit tests for api/src/lib/quickmod.ts — the synchronous stage-1
// submission gate (multilingual spam/gibberish detection + lite topic
// classification). No DB, no network.

import { describe, expect, test } from "bun:test";
import { fastScan, classifyTopic, detectScript, normalizeText } from "../src/lib/quickmod";

describe("quickmod.fastScan — legit submissions pass", () => {
  test("plain local news story passes with topic detected", () => {
    const r = fastScan("Protest at city hall over water prices");
    expect(r.pass).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(["politics", "protest", "other"]).toContain(r.topic.category);
    expect(r.topic_summary.length).toBeGreaterThan(10);
  });

  test("disaster report passes and classifies", () => {
    const r = fastScan("Building collapse in old town, rescue operation underway", "Three floors came down after the earthquake. Neighbors say the death toll may rise.");
    expect(r.pass).toBe(true);
    expect(r.topic.category).toBe("earthquake"); // DB-valid disaster bucket
    expect(r.topic_summary).toContain("disaster/accident");
  });

  test("non-English submissions classify (Spanish)", () => {
    const r = fastScan("Elecciones municipales en Guadalajara", "Los votantes acuden a las urnas el domingo");
    expect(r.pass).toBe(true);
    expect(r.topic.category).toBe("politics");
    expect(r.topic.lang_hint).toBe("es");
  });

  test("Arabic script detected and scanned without false reject", () => {
    const r = fastScan("انتخابات رئاسية في القاهرة", "يتوجه الناخبون إلى صناديق الاقتراع");
    expect(r.pass).toBe(true);
    expect(r.script).toBe("arabic");
  });

  test("Indonesian sports story passes", () => {
    const r = fastScan("Timnas sepak bola menang di pertandingan liga");
    expect(r.pass).toBe(true);
    expect(r.topic.category).toBe("sports");
  });

  test("violence/disaster vocabulary is NOT rejected (news map!)", () => {
    const r = fastScan("Bomb explosion near market kills three, police investigate");
    expect(r.pass).toBe(true);
  });
});

describe("quickmod.fastScan — spam/scam rejected", () => {
  test("crypto scam blocked", () => {
    const r = fastScan("Earn money fast with free bitcoin — DM me on WhatsApp");
    expect(r.pass).toBe(false);
  });

  test("url shortener pattern blocked", () => {
    const r = fastScan("Check this amazing deal https://bit.ly/3xYz win now");
    expect(r.pass).toBe(false);
    expect(r.reasons).toContain("scam_pattern");
  });

  test("contact-harvest pattern blocked", () => {
    const r = fastScan("Great opportunity", "Call or whatsapp +92 300 1234567 today");
    expect(r.pass).toBe(false);
  });

  test("Indonesian gambling spam blocked", () => {
    const r = fastScan("Situs slot gacor judi online terpercaya deposit pulsa");
    expect(r.pass).toBe(false);
    expect(r.reasons).toContain("spam_blocklist");
  });

  test("Spanish spam blocked", () => {
    const r = fastScan("Gana dinero rapido con casino en linea");
    expect(r.pass).toBe(false);
  });

  test("repeated-character spam blocked", () => {
    const r = fastScan("WINNERRRRRRRRRRRR lottery winner guaranteed winner");
    expect(r.pass).toBe(false);
  });

  test("too many links blocked", () => {
    const r = fastScan("My blog", "http://a.com http://b.com http://c.com");
    expect(r.pass).toBe(false);
    expect(r.reasons).toContain("too_many_links");
  });
});

describe("quickmod.fastScan — gibberish & junk", () => {
  test("consonant soup rejected", () => {
    const r = fastScan("xkqvwz bcdfrtg hjklmnp qrstvwxyz bdfghjkl");
    expect(r.pass).toBe(false);
    expect(r.reasons).toContain("gibberish_text");
  });

  test("repetitive tokens rejected", () => {
    const r = fastScan("free free free free free free free");
    expect(r.pass).toBe(false);
  });

  test("all-caps long title rejected", () => {
    const r = fastScan("HUGE NEWS EVERYONE MUST READ THIS RIGHT NOW");
    expect(r.pass).toBe(false);
    expect(r.reasons).toContain("all_caps");
  });

  test("short title rejected", () => {
    const r = fastScan("hi");
    expect(r.pass).toBe(false);
    expect(r.reasons).toContain("title_too_short");
  });

  test("emoji-only title rejected", () => {
    const r = fastScan("🔥🔥🔥🔥");
    expect(r.pass).toBe(false);
  });
});

describe("quickmod helpers", () => {
  test("normalizeText strips zero-width evasion chars", () => {
    expect(normalizeText("ca\u200Bsino\u200F bonus")).toBe("casino bonus");
  });

  test("detectScript identifies cyrillic", () => {
    expect(detectScript("Выборы президента")).toBe("cyrillic");
  });

  test("classifyTopic returns 'other' with zero confidence for noise", () => {
    const t = classifyTopic("xyzzy plugh");
    expect(t.category).toBe("other");
    expect(t.confidence).toBe(0);
  });

  test("classifyTopic multi-language health", () => {
    const t = classifyTopic("hôpital: nouveau vaccin contre le virus");
    expect(t.category).toBe("health");
    expect(t.lang_hint).toBe("fr");
  });

  test("regression: 'war' must not match inside 'warning'", () => {
    const t = classifyTopic("Flood warning issued for the river district");
    expect(t.category).not.toBe("conflict");
    expect(t.matched).not.toContain("war");
  });

  test("inflections still match ('floods', 'troops')", () => {
    expect(classifyTopic("Floods devastate coastal villages").category).toBe("weather");
    expect(classifyTopic("Troops mass at the border").category).toBe("conflict");
  });
});
