import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { openThreads } from "../src/threadsWeb.js";

// Drives a real Chrome against a small stand-in for threads.com, built to match the
// parts of the real site the bot relies on. Skipped where Chrome isn't installed.
const CHROME_PATHS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];
const hasChrome = CHROME_PATHS.some((path) => existsSync(path));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

const escapeHtml = (text) => text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);

const page = (body) => `<!doctype html><html><body>${body}</body></html>`;

const loginPage = page(`
  <form id="f"><input autocomplete="username"><input type="password" autocomplete="current-password"><input type="submit"></form>
  <div role="alert" id="err"></div>
  <script>
    document.getElementById("f").addEventListener("submit", (event) => {
      event.preventDefault();
      const [user, pass] = [...document.querySelectorAll("input")].map((input) => input.value);
      if (pass !== "right-password") { document.getElementById("err").textContent = "Wrong password"; return; }
      document.cookie = "sid=" + user + "; path=/";
      location.href = "/";
    });
  </script>`);

const homePage = (user) => page(user ? `<nav><a href="/@${user}">Profile</a></nav>` : `<a href="/login">Log in</a>`);

const intentPage = (user, text) => page(`
  <nav><a href="/@${user}">Profile</a></nav>
  <div role="dialog">
    <div contenteditable="true">${text.split("\n").map((line) => `<p>${escapeHtml(line) || "<br>"}</p>`).join("")}</div>
    <input type="file" accept="image/*" style="display:none">
    <div id="media"></div>
    <div role="button" id="post">Post</div>
  </div>
  <script>
    const dialog = document.querySelector("[role=dialog]");
    dialog.querySelector("input[type=file]").addEventListener("change", (event) => {
      const img = document.createElement("img");
      img.src = URL.createObjectURL(event.target.files[0]);
      document.getElementById("media").append(img);
    });
    document.getElementById("post").addEventListener("click", () => {
      fetch("/posted", { method: "POST", body: dialog.querySelector("[contenteditable]").innerText
        + "|images=" + dialog.querySelectorAll("img").length })
        .then(() => setTimeout(() => dialog.remove(), 200));
    });
  </script>`);

let server;
let baseUrl;
let dir;
let posted = [];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "threads-web-"));
  await writeFile(join(dir, "card.png"), PNG);
  server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const user = /sid=([^;]+)/.exec(request.headers.cookie ?? "")?.[1];
    if (request.method === "POST" && url.pathname === "/posted") {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => { posted = [...posted, body]; response.end("ok"); });
      return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (url.pathname === "/login") return response.end(loginPage);
    if (url.pathname === "/intent/post") return response.end(user ? intentPage(user, url.searchParams.get("text")) : homePage());
    return response.end(homePage(user));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

const open = (overrides = {}) => openThreads({
  username: "tester",
  password: "right-password",
  sessionFile: join(dir, "session-tester.json"),
  baseUrl,
  ...overrides,
});

const TEXT = "🚀 Tuyển QA & Tester\n\n📍 Hà Nội\n👉 Ứng tuyển: https://www.aretalents.com/viec-lam/x";

test("logs in, saves the session, and posts the text with the card", { skip: !hasChrome }, async () => {
  const threads = await open();
  try {
    assert.equal(await threads.post({ text: TEXT, imagePath: join(dir, "card.png") }), "posted");
  } finally {
    await threads.close();
  }

  assert.equal(posted.length, 1);
  assert.match(posted[0], /Tuyển QA & Tester/);
  assert.match(posted[0], /\|images=1$/);
  assert.match(await readFile(join(dir, "session-tester.json"), "utf8"), /"sid"/);
});

test("reuses the saved session without a password", { skip: !hasChrome }, async () => {
  const threads = await open({ password: undefined });
  await threads.close();
});

test("compose-only fills in the post but never clicks Post", { skip: !hasChrome }, async () => {
  const before = posted.length;
  const screenshotPath = join(dir, "compose.png");
  const threads = await open();
  try {
    assert.equal(await threads.post({ text: TEXT, submit: false, screenshotPath }), "composed");
  } finally {
    await threads.close();
  }

  assert.equal(posted.length, before);
  assert.equal(existsSync(screenshotPath), true);
});

test("reports a wrong password with Threads' own message", { skip: !hasChrome }, async () => {
  await assert.rejects(
    open({ username: "other", password: "nope", sessionFile: join(dir, "session-other.json") }),
    /Could not log in to Threads as other: Wrong password/,
  );
});

test("asks for the password when there is no saved session", { skip: !hasChrome }, async () => {
  await assert.rejects(
    open({ username: "nobody", password: undefined, sessionFile: join(dir, "session-nobody.json") }),
    /THREADS_PASSWORD/,
  );
});
