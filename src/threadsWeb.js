import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium } from "playwright-core";

export const THREADS_URL = "https://www.threads.com";
const STEP_TIMEOUT_MS = 30_000;
const POST_TIMEOUT_MS = 90_000;
const SETTLE_MS = 1_500;
// After login Threads may ask for a code or a security check. With --headed a person has
// this long to finish it in the browser window.
const CHALLENGE_TIMEOUT_MS = 5 * 60_000;
const CHALLENGE_URL = /\/(challenge|checkpoint|two_factor|accounts\/suspended|auth_platform)/i;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Threads' own share link. It opens the composer with the text filled in, line breaks
 * included, so nothing has to be typed.
 * @param {string} text
 * @param {string} [baseUrl]
 */
export const buildIntentUrl = (text, baseUrl = THREADS_URL) => `${baseUrl}/intent/post?text=${encodeURIComponent(text)}`;

/**
 * The composer shows each line as its own block, and browsers report blank lines and
 * non-breaking spaces inconsistently, so both sides are compared in this form.
 * @param {string} text
 */
export const normalizeText = (text) => text
  .replace(/\r/g, "")
  .replace(/ /g, " ")
  .split("\n")
  .map((line) => line.trimEnd())
  .filter(Boolean)
  .join("\n")
  .trim();

/** @param {string} url */
export const isChallengeUrl = (url) => CHALLENGE_URL.test(new URL(url).pathname);

/**
 * A per-account file, such as the saved session or the posted ledger.
 * @param {string} dir
 * @param {string} kind
 * @param {string} username
 */
export const accountFile = (dir, kind, username) => `${dir}/${kind}-${username.toLowerCase().replace(/[^a-z0-9._]/g, "_")}.json`;

const loginForm = (page) => page.locator('input[autocomplete="username"]');
const profileLink = (page, username) => page.locator(`a[href="/@${username}"], a[href="/@${username.toLowerCase()}"]`).first();

const isSignedInAs = async (page, username, baseUrl) => {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  // Signed in, the page links to the account's profile; signed out, to the login page.
  const signedOut = page.locator('a[href^="/login"], input[autocomplete="username"]');
  try {
    await profileLink(page, username).or(signedOut).first().waitFor({ state: "attached", timeout: STEP_TIMEOUT_MS });
  } catch {
    return false;
  }
  return (await profileLink(page, username).count()) > 0;
};

const waitForChallenge = async (page, username, headed) => {
  if (!headed) {
    throw new Error(
      "Threads asked for a security check or login code. Run once with --headed, finish it in "
      + "the browser window, and the saved session is used from then on.",
    );
  }
  process.stdout.write("Threads wants a security check. Finish it in the browser window...\n");
  await profileLink(page, username).waitFor({ state: "attached", timeout: CHALLENGE_TIMEOUT_MS });
};

const loginError = (page) => page.locator('[role="alert"], [aria-live="assertive"]').filter({ hasText: /\S/ }).first();

const readLoginError = async (page) => {
  const alert = loginError(page);
  return (await alert.count()) ? (await alert.innerText()).trim() : "";
};

async function logIn(page, { username, password, headed, baseUrl }) {
  if (!password) throw new Error("Set THREADS_PASSWORD in .env: there is no saved session to reuse");
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  await loginForm(page).waitFor({ timeout: STEP_TIMEOUT_MS });
  await loginForm(page).fill(username);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.locator('input[autocomplete="current-password"]').press("Enter");

  const outcome = await Promise.race([
    profileLink(page, username).waitFor({ state: "attached", timeout: STEP_TIMEOUT_MS }).then(() => "ok"),
    page.waitForURL((url) => isChallengeUrl(url.href), { timeout: STEP_TIMEOUT_MS }).then(() => "challenge"),
    loginError(page).waitFor({ timeout: STEP_TIMEOUT_MS }).then(() => "error"),
  ]).catch(() => "unknown");

  if (outcome === "challenge") return waitForChallenge(page, username, headed);
  if (outcome === "ok") return undefined;
  // Read before isSignedInAs, which leaves the login page and its message.
  const reason = outcome === "error" ? await readLoginError(page) : "";
  if (!reason && await isSignedInAs(page, username, baseUrl)) return undefined;
  throw new Error(`Could not log in to Threads as ${username}${reason ? `: ${reason}` : ""}. Check THREADS_USERNAME and THREADS_PASSWORD.`);
}

const composerDialog = (page) => page.locator('[role="dialog"]').filter({ has: page.locator('[contenteditable="true"]') }).last();

const composerText = async (dialog) => dialog.locator('[contenteditable="true"]').first().innerText();

/**
 * Threads attaches a preview of the first link. With the image card added it should be
 * dropped, but if Threads keeps it, its own remove button takes it off. The link stays in
 * the text and still works.
 */
async function removeLinkPreview(dialog) {
  const remove = dialog.locator('[aria-label*="link preview" i] [role="button"], [role="button"][aria-label*="Remove link" i]');
  for (let index = await remove.count(); index > 0; index -= 1) {
    await remove.first().click();
    await sleep(SETTLE_MS / 2);
  }
}

async function attachImage(page, dialog, imagePath) {
  // The file input is hidden behind the "Attach media" icon, so the file is set on it directly.
  const input = dialog.locator('input[type="file"]').first();
  await input.waitFor({ state: "attached", timeout: STEP_TIMEOUT_MS });
  await input.setInputFiles(imagePath);
  const images = dialog.locator('img[src^="blob:"], video[src^="blob:"]');
  await images.first().waitFor({ timeout: STEP_TIMEOUT_MS });
  await sleep(SETTLE_MS);
  await removeLinkPreview(dialog);
  const count = await images.count();
  if (count !== 1) throw new Error(`Expected just the image card attached, found ${count} attachment(s)`);
}

const postButton = (dialog) => dialog.locator('[role="button"], button').filter({ hasText: /^Post$/ }).last();

async function compose(page, { text, imagePath, baseUrl }) {
  await page.goto(buildIntentUrl(text, baseUrl), { waitUntil: "domcontentloaded" });
  const dialog = composerDialog(page);
  await dialog.waitFor({ timeout: STEP_TIMEOUT_MS });
  await sleep(SETTLE_MS);
  const shown = await composerText(dialog);
  if (normalizeText(shown) !== normalizeText(text)) {
    throw new Error(`The composer did not get the post text. It had:\n${shown}`);
  }
  if (imagePath) await attachImage(page, dialog, imagePath);
  return dialog;
}

/**
 * A browser signed in to Threads. The session is saved after login, so later runs skip
 * the login form, and are less likely to trigger Threads' security checks.
 * @param {{
 *   username: string,
 *   password?: string,
 *   sessionFile: string,
 *   headed?: boolean,
 *   channel?: string,
 *   baseUrl?: string, only changed by tests
 * }} options
 */
export async function openThreads({
  username, password, sessionFile, headed = false, channel = "chrome", baseUrl = THREADS_URL,
}) {
  if (!username) throw new Error("Set THREADS_USERNAME in .env");
  const browser = await chromium.launch({ channel, headless: !headed });
  try {
    const context = await browser.newContext({
      locale: "en-US",
      viewport: { width: 1280, height: 900 },
      ...(existsSync(sessionFile) ? { storageState: sessionFile } : {}),
    });
    context.setDefaultTimeout(STEP_TIMEOUT_MS);
    const page = await context.newPage();
    if (!(await isSignedInAs(page, username, baseUrl))) {
      await logIn(page, { username, password, headed, baseUrl });
    }
    await mkdir(dirname(sessionFile), { recursive: true });
    await context.storageState({ path: sessionFile });

    /**
     * Opens the composer with the post, checks the text and image, then clicks Post.
     * With `submit: false` it stops before Post and saves a screenshot instead.
     * @param {{ text: string, imagePath?: string, submit?: boolean, screenshotPath?: string }} post
     * @returns {Promise<"posted" | "composed">}
     */
    const post = async ({ text, imagePath, submit = true, screenshotPath }) => {
      const dialog = await compose(page, { text, imagePath, baseUrl });
      if (!submit) {
        if (screenshotPath) await dialog.screenshot({ path: screenshotPath });
        return "composed";
      }
      const button = postButton(dialog);
      await button.waitFor({ timeout: STEP_TIMEOUT_MS });
      await button.click();
      // Post was clicked: from here a failure may still mean the post went out.
      await dialog.waitFor({ state: "detached", timeout: POST_TIMEOUT_MS });
      await context.storageState({ path: sessionFile });
      return "posted";
    };

    return { post, close: () => browser.close() };
  } catch (error) {
    await browser.close();
    throw error;
  }
}
