import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCopyPageUrl, ensureSignedIn, postToFacebook, shellQuote } from "../src/facebookBot.js";

const POST = "🚀 Tuyển QA & Tester\n\n👉 Ứng tuyển: https://www.aretalents.com/viec-lam/x?a=1\n#TuyenDungIT";

const decodePage = (url) => Buffer.from(url.replace("data:text/html;base64,", ""), "base64").toString("utf8");

test("quotes single quotes for sh", () => {
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test("the copy page carries the whole post, line breaks and Vietnamese included", () => {
  const url = buildCopyPageUrl(POST);
  assert.match(url, /^data:text\/html;base64,[A-Za-z0-9+/=]+$/);
  const html = decodePage(url);
  const encoded = html.match(/atob\("([^"]+)"\)/)[1];
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), POST);
  assert.match(html, /id=fbbot_copy/);
});

const node = (props) => ({ text: "", id: "", desc: "", className: "android.view.ViewGroup", clickable: false, bounds: { left: 0, top: 0, right: 10, bottom: 10 }, ...props });
const button = (name, props = {}) => node({ desc: name, clickable: true, className: "android.widget.Button", ...props });

/**
 * A phone whose screen follows the bot's taps, enough to walk through the posting flow.
 * @param {{ screen: string, pasted?: string, photos?: number }} start
 */
function fakePhone({ screen, pasted = POST, photos = 1 }) {
  const state = { screen, composerText: "What's on your mind?", copied: false, taps: [], shell: [], pushed: [], posted: false };
  const screens = {
    feed: () => [button("What's on your mind?", { text: "What's on your mind?" })],
    login: () => [
      node({ desc: "Mobile number or email address,", className: "android.widget.EditText", clickable: true }),
      node({ desc: "Password,", className: "android.widget.EditText", clickable: true }),
      button("Log in"),
    ],
    saveLogin: () => [node({ desc: "Save your login info to Facebook?" }), button("Save"), button("Not now")],
    chrome: () => [node({ id: "fbbot_copy", text: state.copied ? "COPIED" : "COPY POST", clickable: true })],
    composer: () => [
      button("Close"),
      node({ desc: "New post", text: "New post" }),
      node({ text: state.composerText, className: "android.widget.EditText", clickable: true }),
      ...Array.from({ length: photos }, () => node({ desc: "Photo" })),
      button("Next"),
    ],
    preview: () => [button("Back"), node({ desc: "Choose audience" }), button("Public", { checked: state.isPublic }), button("Post")],
    discardDialog: () => [button("DISCARD", { desc: "", text: "DISCARD" })],
  };
  const dumpUi = async () => screens[state.screen]();
  const onTap = {
    "Log in": () => { state.screen = "saveLogin"; },
    Save: () => { state.screen = "feed"; },
    fbbot_copy: () => { state.copied = true; },
    Next: () => { state.screen = "preview"; },
    Public: () => { state.isPublic = true; },
    Post: () => { state.posted = true; state.screen = "feed"; },
    Back: () => { state.screen = "composer"; },
    Close: () => { state.screen = "discardDialog"; },
    DISCARD: () => { state.screen = "feed"; },
  };
  const find = async (predicate) => (await dumpUi()).find(predicate);
  const adb = {
    state,
    dumpUi,
    push: async (local, remote) => { state.pushed.push(remote); },
    shell: async (command) => {
      state.shell.push(command);
      if (command.startsWith("sh /data/local/tmp/facebook_bot.sh")) {
        // Each compose runs two scripts: open the copy page in Chrome, then share to Facebook.
        state.scripts = (state.scripts ?? 0) + 1;
        state.screen = state.scripts % 2 ? "chrome" : "composer";
        if (state.screen === "chrome") state.copied = false;
        else state.composerText = "What's on your mind?";
      }
      if (command.includes("content query")) return "Row: 0 _id=47";
      return "";
    },
    keyevent: async (key) => { if (key === 279) state.composerText = pasted; },
    tap: async (target) => { const key = target.id || target.desc || target.text; state.taps.push(key); onTap[key]?.(); },
    waitFor: async (predicate, { what }) => {
      const found = await find(predicate);
      if (!found) throw new Error(`Timed out waiting for ${what}`);
      return { node: found, nodes: await dumpUi() };
    },
    waitUntilGone: async (predicate, { what }) => { if (await find(predicate)) throw new Error(`${what} still open`); },
    screenshot: async (path) => { state.screenshot = path; },
  };
  return adb;
}

test("posts with the card attached, the text pasted and the audience set to Public", async () => {
  const adb = fakePhone({ screen: "feed" });

  const outcome = await postToFacebook(adb, { text: POST, imagePath: "C:/cards/job-1.png" });

  assert.equal(outcome, "posted");
  assert.equal(adb.state.posted, true);
  assert.deepEqual(adb.state.taps.filter((name) => ["Next", "Public", "Post"].includes(name)), ["Next", "Public", "Post"]);
  assert.ok(adb.state.pushed.includes("/sdcard/Pictures/AreTalentsJobs/job-1.png"));
  assert.ok(adb.state.shell.some((command) => command.includes("pm grant com.facebook.katana")));
});

test("compose-only stops before Post, takes a screenshot and discards the draft", async () => {
  const adb = fakePhone({ screen: "feed" });

  const outcome = await postToFacebook(adb, { text: POST, imagePath: "C:/cards/job-1.png", submit: false, screenshotPath: "shot.png" });

  assert.equal(outcome, "composed");
  assert.equal(adb.state.posted, false);
  assert.equal(adb.state.screenshot, "shot.png");
  assert.equal(adb.state.screen, "feed");
});

test("refuses to post when the pasted text differs, and leaves no draft", async () => {
  const adb = fakePhone({ screen: "feed", pasted: "something else" });

  await assert.rejects(postToFacebook(adb, { text: POST, imagePath: "C:/cards/job-1.png" }), /did not get the post text[\s\S]*Nothing was posted/);
  assert.equal(adb.state.posted, false);
  assert.equal(adb.state.screen, "feed");
});

test("refuses to post when the card isn't the only attachment", async () => {
  const adb = fakePhone({ screen: "feed", photos: 0 });

  await assert.rejects(postToFacebook(adb, { text: POST, imagePath: "C:/cards/job-1.png" }), /Expected just the image card/);
  assert.equal(adb.state.posted, false);
});

test("logs in when Facebook is signed out", async () => {
  const adb = fakePhone({ screen: "login" });

  await ensureSignedIn(adb, { email: "me@example.com", password: "it's secret" });

  assert.equal(adb.state.screen, "feed");
  assert.ok(adb.state.shell.includes("input text 'me@example.com'"));
  assert.ok(adb.state.shell.includes("input text 'it'\\''s secret'"));
});

test("asks for the credentials when signed out without them", async () => {
  const adb = fakePhone({ screen: "login" });

  await assert.rejects(ensureSignedIn(adb, {}), /FACEBOOK_EMAIL and FACEBOOK_PASSWORD/);
});
