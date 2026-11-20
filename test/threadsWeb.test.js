import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIntentUrl, isChallengeUrl, normalizeText, accountFile } from "../src/threadsWeb.js";

test("the intent link carries the whole post, line breaks and Vietnamese included", () => {
  const text = "🚀 Tuyển QA & Tester\n\n👉 https://www.aretalents.com/viec-lam/x?a=1";

  const url = new URL(buildIntentUrl(text));

  assert.equal(url.origin + url.pathname, "https://www.threads.com/intent/post");
  assert.equal(url.searchParams.get("text"), text);
});

test("compares composer text without caring about blank lines or nbsp", () => {
  assert.equal(normalizeText("a b  \r\n\n\nc\n"), "a b\nc");
  assert.equal(normalizeText("a b\n\nc"), normalizeText("a b\nc"));
});

test("a changed word still counts as different text", () => {
  assert.notEqual(normalizeText("Lương 30 triệu"), normalizeText("Lương 31 triệu"));
});

test("recognises Threads' security check pages", () => {
  assert.equal(isChallengeUrl("https://www.threads.com/challenge/abc/"), true);
  assert.equal(isChallengeUrl("https://www.instagram.com/accounts/login/two_factor?next=/"), true);
  assert.equal(isChallengeUrl("https://www.threads.com/"), false);
  assert.equal(isChallengeUrl("https://www.threads.com/@challenge_fan"), false);
});

test("keeps one file of each kind per account, with a safe file name", () => {
  assert.equal(accountFile("data/threads", "session", "Lttr.Bbt"), "data/threads/session-lttr.bbt.json");
  assert.equal(accountFile("data/threads", "posted", "../evil"), "data/threads/posted-.._evil.json");
});
