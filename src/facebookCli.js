#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { connectDevice, createAdb, discoverDevices, sleep } from "./adbDevice.js";
import { assertFlagsArrived, intAtLeast, loadEnv, print, runMain, writeJsonFile } from "./cliSupport.js";
import { ensureSignedIn, postToFacebook } from "./facebookBot.js";
import { renderCards } from "./jobCard.js";
import { buildCardSpec, buildPostText } from "./threadsPost.js";
import { accountFile } from "./threadsWeb.js";

const dataPath = (name) => fileURLToPath(new URL(`../data/${name}`, import.meta.url));
const JOBS_PATH = dataPath("jobs.json");
const PUBLISHED_PATH = dataPath("published.json");
const OUT_DIR = dataPath("facebook");
const COMPOSE_DIR = `${OUT_DIR}/compose`;
// One ledger per account, so a new account posts every job again.
const ledgerPath = (email) => accountFile(OUT_DIR, "posted", email);
const MINUTE_MS = 60_000;

const FLAGS = ["dry-run", "compose-only", "id", "limit", "device", "min-gap", "max-gap", "no-image"];

const USAGE = `Usage: node src/facebookCli.js [options]

Posts every job that is live on AreTalents to Facebook, one public post per job, from an
Android phone with ADB over Wi-Fi switched on. If Facebook is signed out on the phone, the
bot logs in with FACEBOOK_EMAIL and FACEBOOK_PASSWORD (both in .env).

  --dry-run          Write the posts and images to data/facebook/ only; no phone needed
  --compose-only     Fill in each post up to the Post button, but don't post it. Saves a
                     screenshot of each to data/facebook/compose/
  --id <aniday id>   Only this job (repeatable)
  --limit <n>        Post at most n jobs this run
  --device <ip:port> The phone (default: FACEBOOK_ADB_DEVICE, or scan the local network)
  --min-gap <min>    Shortest pause between posts in minutes (default: 4)
  --max-gap <min>    Longest pause between posts in minutes (default: 9)
  --no-image         Post text only, without the image card
  --help             Show this message
`;

const readOptions = () => {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      "compose-only": { type: "boolean", default: false },
      id: { type: "string", multiple: true, default: [] },
      limit: { type: "string" },
      device: { type: "string" },
      "min-gap": { type: "string", default: "4" },
      "max-gap": { type: "string", default: "9" },
      "no-image": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  const minGap = intAtLeast(values["min-gap"], "min-gap", 1);
  const maxGap = intAtLeast(values["max-gap"], "max-gap", minGap);
  return {
    help: values.help,
    dryRun: values["dry-run"],
    composeOnly: values["compose-only"],
    ids: values.id,
    limit: values.limit === undefined ? Infinity : intAtLeast(values.limit, "limit", 1),
    device: values.device ?? (process.env.FACEBOOK_ADB_DEVICE?.trim() || undefined),
    email: process.env.FACEBOOK_EMAIL?.trim().toLowerCase() || undefined,
    password: process.env.FACEBOOK_PASSWORD || undefined,
    gapMs: [minGap * MINUTE_MS, maxGap * MINUTE_MS],
    withImage: !values["no-image"],
  };
};

const readJson = async (path, fallback) => (existsSync(path) ? JSON.parse(await readFile(path, "utf8")) : fallback);

/** Jobs that are live on AreTalents and not yet on Facebook, newest AniDay id first. */
const selectJobs = (jobs, published, ledger, { ids, limit }) => jobs
  .filter((job) => published[job.id]?.url && !ledger[job.id])
  .filter((job) => !ids.length || ids.includes(String(job.id)))
  .sort((a, b) => b.id - a.id)
  .slice(0, limit);

const writePreview = async (posts) => {
  const body = posts.map(({ job, text, imagePath }) => [
    `## ${job.id} · ${job.title}`, "", "```text", text, "```", "", imagePath ? `![card](${imagePath})` : "", "",
  ].join("\n"));
  const path = `${OUT_DIR}/posts.md`;
  await writeFile(path, `# Facebook posts preview\n\n${body.join("\n")}`);
  return path;
};

const randomGap = ([min, max]) => min + Math.floor(Math.random() * (max - min + 1));

const pickDevice = async (device) => {
  if (device) return device;
  print("Looking for a phone with ADB over Wi-Fi on the local network...");
  const found = await discoverDevices();
  if (found.length !== 1) {
    throw new Error(found.length
      ? `Found several phones (${found.join(", ")}). Choose one with --device or FACEBOOK_ADB_DEVICE.`
      : "No phone with ADB over Wi-Fi found. Switch it on, or pass --device <ip:port>.");
  }
  return found[0];
};

const runPosts = async (adb, posts, ledger, options) => {
  const path = ledgerPath(options.email);
  let current = ledger;
  for (const [index, { job, text, imagePath, url }] of posts.entries()) {
    const label = `${job.id}  ${job.title}`;
    try {
      const outcome = await postToFacebook(adb, {
        text, imagePath, submit: !options.composeOnly, screenshotPath: `${COMPOSE_DIR}/job-${job.id}.png`,
      });
      print(`${outcome.padEnd(10)} ${label}`);
      if (outcome === "posted") {
        current = { ...current, [job.id]: { postedAt: new Date().toISOString(), url } };
        await writeJsonFile(path, current);
      }
    } catch (error) {
      // If Post was tapped but the preview didn't close in time, the post may be live, so the
      // batch stops for a person to check rather than risk a duplicate.
      throw new Error(`failed     ${label}: ${error.message}\nStopped. Check the Facebook profile, then run again to continue.`);
    }
    const isLast = index === posts.length - 1;
    if (!isLast && !options.composeOnly) {
      const gap = randomGap(options.gapMs);
      print(`           next post in ${(gap / MINUTE_MS).toFixed(1)} min`);
      await sleep(gap);
    }
  }
};

const main = async () => {
  assertFlagsArrived(FLAGS, "src/facebookCli.js");
  loadEnv();
  const options = readOptions();
  if (options.help) return print(USAGE);
  if (!options.dryRun && !options.email) throw new Error("Set FACEBOOK_EMAIL and FACEBOOK_PASSWORD in .env");

  const { jobs } = await readJson(JOBS_PATH, { jobs: [] });
  const published = await readJson(PUBLISHED_PATH, {});
  // A dry run has no account, so it previews every published job.
  const ledger = options.email ? await readJson(ledgerPath(options.email), {}) : {};
  const selected = selectJobs(jobs, published, ledger, options);
  if (!selected.length) return print(`Nothing to post: ${options.email} has already posted every published job.`);

  // Facebook shows the page name, so the card carries no @handle.
  const images = options.withImage ? await renderCards(selected.map(buildCardSpec), `${OUT_DIR}/cards`) : {};
  const posts = selected.map((job) => ({
    job,
    url: published[job.id].url,
    text: buildPostText(job, published[job.id].url),
    imagePath: images[job.id],
  }));
  print(`${posts.length} job(s) to post.`);

  if (options.dryRun) return print(`Preview written to ${await writePreview(posts)}`);

  const serial = await pickDevice(options.device);
  await connectDevice(serial);
  const adb = createAdb({ serial });
  print(`Opening Facebook on ${serial} as ${options.email}...`);
  await ensureSignedIn(adb, { email: options.email, password: options.password });
  await runPosts(adb, posts, ledger, options);
  return print("Done.");
};

runMain(main);
