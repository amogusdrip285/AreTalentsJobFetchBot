import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { sleep } from "./adbDevice.js";

const FACEBOOK_PACKAGE = "com.facebook.katana";
const SHARE_ACTIVITY = `${FACEBOOK_PACKAGE}/com.facebook.composer.shareintent.ImplicitShareIntentHandlerDefaultAlias`;
const LAUNCH_ACTIVITY = `${FACEBOOK_PACKAGE}/.LoginActivity`;
const CHROME_ACTIVITY = "com.android.chrome/com.google.android.apps.chrome.Main";
// Chrome reuses one tab per application id, so repeated runs don't pile up tabs.
const CHROME_TAB_ID = "aretalents_facebook_bot";
const DEVICE_DIR = "/sdcard/Pictures/AreTalentsJobs";
const MEDIA_ROOT = "/storage/emulated/0/Pictures/AreTalentsJobs";
const SCRIPT_PATH = "/data/local/tmp/facebook_bot.sh";
const MEDIA_SCAN_TIMEOUT_MS = 15_000;
const SETTLE_MS = 1_500;
const LOGIN_TIMEOUT_MS = 45_000;
const POST_TIMEOUT_MS = 60_000;
const COMPOSE_ATTEMPTS = 2;
const KEYCODE_PASTE = 279;
const AUDIENCE_ATTEMPTS = 4;
// Drags the middle of the preview up, clear of the Post button at the bottom.
const SCROLL_PREVIEW = "input swipe 540 1500 540 700 400";

// Labels in Facebook for Android 585 (English UK), checked in Nov 2026. Its view ids are
// obfuscated, so the bot matches the accessibility labels instead.
const LABELS = {
  feedComposer: "What's on your mind?",
  emailField: "Mobile number or email address,",
  passwordField: "Password,",
  logIn: "Log in",
  saveLogin: "Save your login info to Facebook?",
  photo: "Photo",
  sharedLink: "Shared link:",
  next: "Next",
  done: "Done",
  post: "Post",
  audience: "Choose audience",
  public: "Public",
  back: "Back",
  newPost: "New post",
  close: "Close",
  discard: "DISCARD",
};
const COPY_BUTTON_ID = "fbbot_copy";
const COPIED = "COPIED";
const CHECKPOINT_TEXT = /(enter|confirm).{0,20}code|two-factor|checkpoint|confirm (it's|its) you|suspicious/i;

const label = (node) => node.desc || node.text;
const is = (name) => (node) => label(node) === name;
const isButton = (name) => (node) => node.clickable && label(node) === name;
const isComposerField = (node) => node.className.endsWith("EditText") && node.text !== LABELS.emailField;

/** Quotes text for `sh`: single quotes can't be escaped inside single quotes, so close and reopen. */
export const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

/**
 * Facebook drops any text shared to it, and `adb shell input text` can't type Vietnamese,
 * emoji or line breaks. So the post goes through the clipboard: this page holds the text,
 * and a tap on its button copies it. A real tap is needed, as browsers only copy on one.
 * @param {string} text
 */
export function buildCopyPageUrl(text) {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  const html = [
    "<!doctype html><meta name=viewport content=\"width=device-width\"><body style=\"margin:0\">",
    "<textarea id=fbbot_text style=\"position:fixed;top:0;left:0;width:1px;height:1px;opacity:0\"></textarea>",
    `<button id=${COPY_BUTTON_ID} style="width:100vw;height:100vh;font-size:40px">COPY POST</button><script>`,
    `const text=new TextDecoder().decode(Uint8Array.from(atob("${encoded}"),c=>c.charCodeAt(0)));`,
    "const area=document.getElementById(\"fbbot_text\");area.value=text;",
    `const button=document.getElementById("${COPY_BUTTON_ID}");`,
    `button.onclick=()=>{area.select();button.textContent=document.execCommand("copy")?"${COPIED}":"COPY FAILED";};`,
    "</script>",
  ].join("");
  return `data:text/html;base64,${Buffer.from(html, "utf8").toString("base64")}`;
}

const pushScript = async (adb, command) => {
  const dir = await mkdtemp(join(tmpdir(), "facebook-bot-"));
  try {
    const local = join(dir, "run.sh");
    await writeFile(local, `${command}\n`);
    await adb.push(local, SCRIPT_PATH);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return adb.shell(`sh ${SCRIPT_PATH}`);
};

async function copyToClipboard(adb, text) {
  await pushScript(adb, [
    `am start -a android.intent.action.VIEW -n ${CHROME_ACTIVITY}`,
    `--es com.android.browser.application_id ${CHROME_TAB_ID}`,
    `-d ${shellQuote(buildCopyPageUrl(text))}`,
  ].join(" "));
  const { node } = await adb.waitFor(
    (candidate) => candidate.id === COPY_BUTTON_ID && candidate.text !== COPIED,
    { what: "the copy page in Chrome" },
  );
  await adb.tap(node);
  await adb.waitFor((candidate) => candidate.id === COPY_BUTTON_ID && candidate.text === COPIED, {
    what: "Chrome to copy the post", timeoutMs: 5_000,
  });
}

/** Copies the card into the phone's gallery and returns its content:// address. */
async function addToGallery(adb, imagePath) {
  // Same as tapping Allow the first time Facebook asks to read photos.
  await adb.shell(`pm grant ${FACEBOOK_PACKAGE} android.permission.READ_EXTERNAL_STORAGE`);
  const name = basename(imagePath);
  // The name goes into shell commands unquoted, so only plain names are allowed.
  if (!/^[\w.-]+$/.test(name)) throw new Error(`Card file name ${name} must be letters, digits, dot, dash or underscore`);
  const remote = `${DEVICE_DIR}/${name}`;
  await adb.shell(`mkdir -p ${DEVICE_DIR}`);
  await adb.push(imagePath, remote);
  await adb.shell(`am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://${remote}`);
  const query = `content query --uri content://media/external/images/media --projection _id --where "_data='${MEDIA_ROOT}/${name}'"`;
  const deadline = Date.now() + MEDIA_SCAN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const id = (await adb.shell(query)).match(/_id=(\d+)/)?.[1];
    if (id) return `content://media/external/images/media/${id}`;
    await sleep(SETTLE_MS);
  }
  throw new Error(`The phone's gallery did not pick up ${name}`);
}

const isLocked = async (adb) => /mShowingLockscreen=true|isStatusBarKeyguard=true|mDreamingLockscreen=true/
  .test(await adb.shell("dumpsys window"));

/** Between posts the screen times out. A swipe lock is dismissed; a PIN or pattern can't be. */
export async function wakeAndUnlock(adb) {
  await adb.keyevent("KEYCODE_WAKEUP");
  await sleep(SETTLE_MS);
  if (!(await isLocked(adb))) return;
  await adb.shell("wm dismiss-keyguard");
  await sleep(SETTLE_MS);
  if (await isLocked(adb)) {
    throw new Error("The phone is locked with a PIN, pattern or password. Unlock it, or keep its screen on, and run again.");
  }
}

/** Facebook hides buttons under the keyboard, and they can't be tapped there. */
async function hideKeyboard(adb) {
  // Back with no keyboard showing would leave the screen instead, so check first.
  if (!/mInputShown=true/.test(await adb.shell("dumpsys input_method"))) return;
  await adb.keyevent("KEYCODE_BACK");
  await sleep(SETTLE_MS);
}

const typeInto = async (adb, field, value) => {
  await adb.tap(field);
  await sleep(SETTLE_MS / 2);
  await adb.shell(`input text ${shellQuote(value)}`);
};

/** Taps through what Facebook shows after a login: save the login, skip location. */
async function finishLogin(adb) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const nodes = await adb.dumpUi().catch(() => []);
    if (nodes.some(is(LABELS.feedComposer))) return;
    if (nodes.some((node) => CHECKPOINT_TEXT.test(label(node)))) {
      throw new Error("Facebook wants a security check. Finish it on the phone, then run again.");
    }
    const step = nodes.some(is(LABELS.saveLogin))
      ? nodes.find(isButton("Save"))
      : nodes.find((node) => node.clickable && ["Skip", "Not now", "OK"].includes(label(node)));
    if (step) await adb.tap(step);
    await sleep(SETTLE_MS);
  }
  throw new Error("Logged in, but Facebook's news feed never appeared. Check the phone.");
}

async function logIn(adb, { email, password }) {
  if (!email || !password) throw new Error("Facebook is signed out on the phone. Set FACEBOOK_EMAIL and FACEBOOK_PASSWORD in .env");
  const { nodes } = await adb.waitFor(is(LABELS.passwordField), { what: "the login form" });
  await typeInto(adb, nodes.find(is(LABELS.emailField)), email);
  await typeInto(adb, nodes.find(is(LABELS.passwordField)), password);
  await hideKeyboard(adb);
  const { node: button } = await adb.waitFor(isButton(LABELS.logIn), { what: "the Log in button" });
  await adb.tap(button);
  await finishLogin(adb);
}

/**
 * Opens Facebook and logs in with the email and password if it is signed out.
 * @param {ReturnType<typeof import("./adbDevice.js").createAdb>} adb
 * @param {{ email?: string, password?: string }} account
 */
export async function ensureSignedIn(adb, account) {
  await wakeAndUnlock(adb);
  // A restart opens the news feed, not a share screen left over from an earlier run.
  await adb.shell(`am force-stop ${FACEBOOK_PACKAGE}`);
  await sleep(SETTLE_MS);
  await adb.shell(`am start -W -n ${LAUNCH_ACTIVITY}`);
  const { node } = await adb.waitFor(
    (candidate) => is(LABELS.feedComposer)(candidate) || is(LABELS.passwordField)(candidate),
    { what: "Facebook's news feed or login form", timeoutMs: LOGIN_TIMEOUT_MS },
  );
  if (label(node) === LABELS.passwordField) await logIn(adb, account);
}

/** Leaves the composer without posting or keeping a draft, so the next attempt starts clean. */
async function discardComposer(adb) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const nodes = await adb.dumpUi().catch(() => []);
    const discard = nodes.find(isButton(LABELS.discard));
    const back = nodes.some(is(LABELS.audience)) && nodes.find(isButton(LABELS.back));
    const close = nodes.some(is(LABELS.newPost)) && nodes.find(isButton(LABELS.close));
    const target = discard || back || close;
    if (!target) return;
    await adb.tap(target);
    await sleep(SETTLE_MS);
  }
}

const shareCommand = (imageUri, text) => (imageUri
  ? `am start -a android.intent.action.SEND -t image/png -n ${SHARE_ACTIVITY} --eu android.intent.extra.STREAM ${imageUri} --grant-read-uri-permission`
  // Text-only: Facebook keeps just the link from shared text, but that still opens the composer.
  : `am start -a android.intent.action.SEND -t text/plain -n ${SHARE_ACTIVITY} --es android.intent.extra.TEXT ${shellQuote(text.match(/https?:\/\/\S+/)?.[0] ?? " ")}`);

/**
 * While the keyboard is up, Facebook swaps Next for Done. The keyboard can open a moment
 * after the paste, so this keeps closing it until Next shows.
 */
async function finishEditing(adb) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const nodes = await adb.dumpUi().catch(() => []);
    if (nodes.some(isButton(LABELS.next))) return nodes;
    const done = nodes.find(isButton(LABELS.done));
    if (done) await adb.tap(done);
    else await hideKeyboard(adb);
    await sleep(SETTLE_MS);
  }
  throw new Error("The composer's Next button never appeared");
}

/** Opens the composer with the card, pastes the post in and checks both. */
async function compose(adb, { text, imageUri }) {
  await copyToClipboard(adb, text);
  await pushScript(adb, shareCommand(imageUri, text));
  const { node: field } = await adb.waitFor(isComposerField, { what: "the Facebook composer" });
  if (field.text !== LABELS.feedComposer) throw new Error("Facebook reopened an old draft");
  await adb.tap(field);
  await sleep(SETTLE_MS / 2);
  await adb.keyevent(KEYCODE_PASTE);
  await sleep(SETTLE_MS);
  const after = await finishEditing(adb);
  if (imageUri) await adb.waitFor(is(LABELS.photo), { what: "the image card in the composer", timeoutMs: 10_000 }).catch(() => {});
  const shown = after.find(isComposerField)?.text ?? "";
  if (shown !== text) throw new Error(`The composer did not get the post text. It had:\n${shown}`);
  if (imageUri) {
    const settled = await adb.dumpUi();
    const photos = settled.filter(is(LABELS.photo)).length;
    const links = settled.filter((node) => label(node).startsWith(LABELS.sharedLink)).length;
    if (photos !== 1 || links) throw new Error(`Expected just the image card attached, found ${photos} photo(s) and ${links} link preview(s)`);
  }
}

/** A long post pushes the audience options below the Post button, so the preview scrolls to them. */
async function choosePublic(adb) {
  for (let attempt = 0; attempt < AUDIENCE_ATTEMPTS; attempt += 1) {
    const publicChip = (await adb.dumpUi()).find(isButton(LABELS.public));
    if (publicChip?.checked) return;
    if (publicChip) await adb.tap(publicChip);
    else await adb.shell(SCROLL_PREVIEW);
    await sleep(SETTLE_MS);
  }
  throw new Error("Could not set the audience to Public");
}

/** Next leads to the preview, where the audience is set to Public. */
async function openPreview(adb) {
  const { node: next } = await adb.waitFor(isButton(LABELS.next), { what: "the Next button" });
  await adb.tap(next);
  await adb.waitFor(isButton(LABELS.post), { what: "the Post button" });
  await choosePublic(adb);
}

/**
 * Opens the Facebook composer with the image card, pastes the post in and checks it, then
 * taps Post with the audience set to Public. With `submit: false` it stops before Post,
 * saves a screenshot if asked, and discards the draft.
 * @param {ReturnType<typeof import("./adbDevice.js").createAdb>} adb
 * @param {{ text: string, imagePath?: string, submit?: boolean, screenshotPath?: string }} post
 * @returns {Promise<"posted" | "composed">}
 */
export async function postToFacebook(adb, { text, imagePath, submit = true, screenshotPath }) {
  await wakeAndUnlock(adb);
  const imageUri = imagePath ? await addToGallery(adb, imagePath) : undefined;
  let tapped = false;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await compose(adb, { text, imageUri });
      await openPreview(adb);
      if (!submit) {
        if (screenshotPath) await adb.screenshot(screenshotPath);
        await discardComposer(adb);
        return "composed";
      }
      const { node: postButton } = await adb.waitFor(isButton(LABELS.post), { what: "the Post button" });
      tapped = true;
      await adb.tap(postButton);
      break;
    } catch (error) {
      // Once Post may have been tapped, trying again could post twice.
      if (tapped) throw error;
      await discardComposer(adb).catch(() => {});
      if (attempt >= COMPOSE_ATTEMPTS) throw new Error(`${error.message}. Nothing was posted.`);
    }
  }
  // Post was tapped: from here a failure may still mean the post went out.
  await adb.waitUntilGone(is(LABELS.audience), { what: "the post preview", timeoutMs: POST_TIMEOUT_MS });
  return "posted";
}
