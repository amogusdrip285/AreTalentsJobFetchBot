import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { sleep } from "./adbDevice.js";

const THREADS_PACKAGE = "com.instagram.barcelona";
const SHARE_ACTIVITY = `${THREADS_PACKAGE}/.handleractivity.BarcelonaShareHandlerActivity`;
const DEVICE_DIR = "/sdcard/Pictures/AreTalentsJobs";
const MEDIA_ROOT = "/storage/emulated/0/Pictures/AreTalentsJobs";
const SCRIPT_PATH = "/data/local/tmp/threads_bot_share.sh";
const MEDIA_SCAN_TIMEOUT_MS = 15_000;
const SETTLE_MS = 1_500;
const GALLERY_COLUMNS = 3;
const GALLERY_GRID_GAP_PX = 25;

// Resource ids and labels in Threads for Android, checked in Nov 2026.
const IDS = {
  shareSheetPost: "post_share_sheet_create_post_button",
  composer: "new_thread_screen_composer",
  postButton: "new_thread_screen_post_button",
  galleryButton: "new_thread_screen_gallery_button",
  cancel: "navigation_bar_back_button",
  dontSave: "igds_alert_dialog_secondary_button",
};
const REMOVE_ATTACHMENT = "Remove attachment";
const LINK_PREVIEW_DOMAIN = "aretalents.com";
const LINK_PREVIEW_WAIT_MS = 3_000;
const STORY_PROMPT = "Add to Instagram story";
const STORY_PROMPT_WAIT_MS = 8_000;
const ACCOUNT_WAIT_MS = 10_000;

const byId = (id) => (node) => node.id === id;
const graphemes = (text) => [...new Intl.Segmenter("vi", { granularity: "grapheme" }).segment(text)].map((part) => part.segment);

/** Quotes text for `sh`: single quotes can't be escaped inside single quotes, so close and reopen. */
export const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

/**
 * The share intent that opens Threads with the text filled in. It runs from a script file,
 * because `adb shell input text` can't type Vietnamese, emoji or line breaks.
 * @param {string} text
 */
export const buildShareCommand = (text) => [
  // No -W: Threads' share handler hands off to another screen and never reports done.
  "am start -a android.intent.action.SEND -t text/plain",
  `-n ${SHARE_ACTIVITY}`,
  `--es android.intent.extra.TEXT ${shellQuote(text)}`,
].join(" ");

/**
 * Threads turns each shared line break into a space. Starting with the cursor at the end,
 * the bot moves left to each of those spaces, last first so earlier positions don't shift,
 * and swaps it for a line break. Moves count graphemes, as the cursor keys do.
 * @param {string} text the post as it should read
 * @returns {number[]} left-arrow presses before each swap, in the order they're made
 */
export function lineBreakMoves(text) {
  const chars = graphemes(text);
  const breaks = chars.flatMap((char, index) => (char === "\n" ? [index] : []));
  let cursor = chars.length;
  return breaks.reverse().map((index) => {
    const moves = cursor - (index + 1);
    cursor = index + 1;
    return moves;
  });
}

// The Samsung keyboard swallows arrow keys sent in a burst, so they go one `input` call at a
// time. Run on the phone, each call takes about a quarter of a second, which is slow enough.
const pressLeft = (adb, times) => adb.shell(
  `i=0; while [ $i -lt ${times} ]; do input keyevent KEYCODE_DPAD_LEFT; i=$((i+1)); done`,
);

const EDIT_SETTLE_MS = 400;
const COMPOSE_ATTEMPTS = 2;

const pushScript = async (adb, command) => {
  const dir = await mkdtemp(join(tmpdir(), "threads-bot-"));
  try {
    const local = join(dir, "share.sh");
    await writeFile(local, `${command}\n`);
    await adb.push(local, SCRIPT_PATH);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/**
 * Copies the card into the phone's gallery as its newest photo, so it is the first one
 * Threads' gallery picker shows.
 */
async function addToGallery(adb, imagePath) {
  // Threads' picker needs the gallery permission it asks for the first time you add a
  // photo. Granting it here is the same as tapping Allow.
  await adb.shell(`pm grant ${THREADS_PACKAGE} android.permission.READ_EXTERNAL_STORAGE`);
  const name = basename(imagePath);
  const remote = `${DEVICE_DIR}/${name}`;
  await adb.shell(`mkdir -p ${DEVICE_DIR}`);
  await adb.push(imagePath, remote);
  await adb.shell(`touch ${remote}`);
  await adb.shell(`am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://${remote}`);
  const query = `content query --uri content://media/external/images/media --projection _id --where "_data='${MEDIA_ROOT}/${name}'"`;
  const deadline = Date.now() + MEDIA_SCAN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (/_id=\d+/.test(await adb.shell(query))) return;
    await sleep(SETTLE_MS);
  }
  throw new Error(`The phone's gallery did not pick up ${name}`);
}

const isLocked = async (adb) => /mShowingLockscreen=true|isStatusBarKeyguard=true|mDreamingLockscreen=true/
  .test(await adb.shell("dumpsys window"));

/** Between posts the screen times out. A swipe lock is dismissed; a PIN or pattern can't be. */
const wakeAndUnlock = async (adb) => {
  await adb.keyevent("KEYCODE_WAKEUP");
  await sleep(SETTLE_MS);
  if (!(await isLocked(adb))) return;
  await adb.shell("wm dismiss-keyguard");
  await sleep(SETTLE_MS);
  if (await isLocked(adb)) {
    throw new Error("The phone is locked with a PIN, pattern or password. Unlock it, or keep its screen on, and run again.");
  }
};

/** Leaves the composer without posting or saving a draft, so the next attempt starts clean. */
async function discardComposer(adb) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const nodes = await adb.dumpUi().catch(() => []);
    const dontSave = nodes.find(byId(IDS.dontSave));
    const onThreadsScreen = nodes.some((node) => [IDS.composer, IDS.shareSheetPost].includes(node.id) || node.text === "Gallery");
    if (!dontSave && !onThreadsScreen) return;
    const cancel = nodes.find(byId(IDS.cancel));
    if (dontSave) await adb.tap(dontSave);
    else if (cancel) await adb.tap(cancel);
    else await adb.keyevent("KEYCODE_BACK");
    await sleep(SETTLE_MS);
  }
}

const composerText = async (adb) => (await adb.dumpUi()).find(byId(IDS.composer))?.text ?? "";

async function openComposer(adb, text, account) {
  await pushScript(adb, buildShareCommand(text));
  await adb.shell(`sh ${SCRIPT_PATH}`);
  const { node: first } = await adb.waitFor(
    (node) => node.id === IDS.shareSheetPost || node.id === IDS.composer,
    { what: "the Threads share sheet" },
  );
  if (first.id === IDS.shareSheetPost) await adb.tap(first);
  await adb.waitFor(byId(IDS.composer), { what: "the Threads composer" });
  // The header with the username is drawn a moment after the text box, and a long post
  // scrolls it off screen, leaving only the avatar, labelled "<account> profile photo".
  const showsAccount = (node) => {
    const label = (node.desc || node.text).trim();
    return label === account || label === `${account} profile photo`;
  };
  await adb.waitFor(showsAccount, {
    what: `the composer to show the account ${account}`, timeoutMs: ACCOUNT_WAIT_MS,
  }).catch(async () => {
    const names = (await adb.dumpUi()).filter((node) => /profile photo$/.test(node.desc)).map((node) => node.desc);
    throw new Error(`Threads is not signed in as ${account} (composer shows: ${names.join(", ") || "no account"})`);
  });
  await sleep(SETTLE_MS);
}

async function restoreLineBreaks(adb, text) {
  const flattened = text.replaceAll("\n", " ");
  if ((await composerText(adb)) !== flattened) throw new Error("The composer did not receive the post text");
  const composer = (await adb.dumpUi()).find(byId(IDS.composer));
  await adb.tap(composer);
  // Down to the last visual line, then to its end: the cursor is now after the last character.
  await adb.shell(`input keyevent ${Array(30).fill("KEYCODE_DPAD_DOWN").join(" ")}`);
  await sleep(EDIT_SETTLE_MS);
  await adb.keyevent("KEYCODE_MOVE_END");
  await sleep(EDIT_SETTLE_MS);
  for (const moves of lineBreakMoves(text)) {
    await pressLeft(adb, moves);
    await sleep(EDIT_SETTLE_MS);
    await adb.keyevent("KEYCODE_DEL");
    await sleep(EDIT_SETTLE_MS);
    await adb.keyevent("KEYCODE_ENTER");
    await sleep(EDIT_SETTLE_MS);
  }
  await sleep(SETTLE_MS);
  const result = await composerText(adb);
  if (result !== text) throw new Error(`The line breaks came out wrong. The composer had:\n${result}`);
}

/** A long post pushes the composer's toolbar under the keyboard, where it isn't drawn. */
async function hideKeyboard(adb) {
  // Back with no keyboard showing would ask to save a draft instead, so check first.
  if (!/mInputShown=true/.test(await adb.shell("dumpsys input_method"))) return;
  await adb.keyevent("KEYCODE_BACK");
  await sleep(SETTLE_MS);
}

const isLinkPreview = (node) => node.text === LINK_PREVIEW_DOMAIN;

/**
 * Threads attaches a preview of the job link, and hides the gallery button while any
 * attachment is there. AreTalents pages have no preview image, so the card replaces it.
 * The link stays in the text and still works.
 */
async function removeLinkPreview(adb) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { nodes } = await adb.waitFor(
      (node) => node.id === IDS.galleryButton || node.desc === REMOVE_ATTACHMENT,
      { what: "the gallery button" },
    );
    const remove = nodes.find((node) => node.desc === REMOVE_ATTACHMENT);
    if (!remove) return nodes.find(byId(IDS.galleryButton));
    await adb.tap(remove);
    await sleep(SETTLE_MS);
  }
  throw new Error("Could not remove the link preview to make room for the image");
}

async function attachNewestPhoto(adb) {
  await hideKeyboard(adb);
  // Give Threads time to fetch the link preview, so it isn't added after the photo.
  await sleep(LINK_PREVIEW_WAIT_MS);
  const gallery = await removeLinkPreview(adb);
  await adb.tap(gallery);
  const { nodes } = await adb.waitFor((node) => node.text === "Recents", { what: "the gallery picker" });
  const recents = nodes.find((node) => node.text === "Recents");
  const screenWidth = Math.max(...nodes.map((node) => node.bounds.right));
  const cell = screenWidth / GALLERY_COLUMNS;
  // The first cell is the camera, so the newest photo is the second.
  await adb.shell(`input tap ${Math.round(cell * 1.5)} ${Math.round(recents.bounds.bottom + GALLERY_GRID_GAP_PX + cell / 2)}`);
  await sleep(SETTLE_MS);
  const { node: done } = await adb.waitFor((node) => node.text === "Done", { what: "the Done button" });
  await adb.tap(done);
  const { nodes: after } = await adb.waitFor(byId(IDS.composer), { what: "the composer after picking the photo" });
  const attachments = after.filter((node) => node.desc === REMOVE_ATTACHMENT).length;
  if (attachments !== 1 || after.some(isLinkPreview)) {
    throw new Error(`Expected just the image card attached, found ${attachments} attachment(s)`);
  }
}

/**
 * Opens the Threads composer with the post, checks the account and text, adds the image
 * card, then taps Post. With `submit: false` it stops before Post and discards the draft.
 * @param {ReturnType<typeof import("./adbDevice.js").createAdb>} adb
 * @param {{ text: string, imagePath?: string, account: string, submit?: boolean }} post
 * @returns {Promise<"posted" | "composed">}
 */
export async function postToThreads(adb, { text, imagePath, account, submit = true }) {
  await wakeAndUnlock(adb);
  if (imagePath) await addToGallery(adb, imagePath);
  for (let attempt = 1; ; attempt += 1) {
    try {
      await openComposer(adb, text, account);
      await restoreLineBreaks(adb, text);
      if (imagePath) await attachNewestPhoto(adb);
      if (!submit) {
        await discardComposer(adb);
        return "composed";
      }
      const { node: postButton } = await adb.waitFor(byId(IDS.postButton), { what: "the Post button" });
      await adb.tap(postButton);
      break;
    } catch (error) {
      await discardComposer(adb).catch(() => {});
      if (attempt >= COMPOSE_ATTEMPTS) throw new Error(`${error.message}. Nothing was posted.`);
    }
  }
  // Post was tapped: from here a failure may still mean the post went out.
  await adb.waitUntilGone(byId(IDS.composer), { what: "the composer", timeoutMs: 60_000 });
  await dismissStoryPrompt(adb);
  return "posted";
}

/** After a post Threads may offer to share it to an Instagram story. Always decline. */
async function dismissStoryPrompt(adb) {
  const found = await adb.waitFor((node) => node.text === STORY_PROMPT, { what: "the story prompt", timeoutMs: STORY_PROMPT_WAIT_MS })
    .catch(() => null);
  const cancel = found?.nodes.find((node) => node.text === "Cancel");
  if (cancel) await adb.tap(cancel);
}
