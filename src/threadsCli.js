#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { connectDevice, createAdb, discoverDevices, sleep } from "./adbDevice.js";
import { assertFlagsArrived, intAtLeast, loadEnv, print, runMain, writeJsonFile } from "./cliSupport.js";
import { renderCards } from "./jobCard.js";
import { postToThreads } from "./threadsBot.js";
import { buildCardSpec, buildPostText } from "./threadsPost.js";

const dataPath = (name) => fileURLToPath(new URL(`../data/${name}`, import.meta.url));
const JOBS_PATH = dataPath("jobs.json");
const PUBLISHED_PATH = dataPath("published.json");
const LEDGER_PATH = dataPath("threadsPosted.json");
const OUT_DIR = dataPath("threads");
const MINUTE_MS = 60_000;

const FLAGS = ["dry-run", "compose-only", "id", "limit", "device", "account", "min-gap", "max-gap", "no-image"];

const USAGE = `Usage: node src/threadsCli.js [options]

Posts every job that is live on AreTalents to Threads, one post per job, from an
Android phone with ADB over Wi-Fi switched on and Threads signed in.

  --dry-run          Write the posts and images to data/threads/ only; no phone needed
  --compose-only     Open each post in Threads and check it, but don't post it
  --id <aniday id>   Only this job (repeatable)
  --limit <n>        Post at most n jobs this run
  --device <ip:port> The phone (default: THREADS_ADB_DEVICE, or scan the local network)
  --account <name>   Threads username that must be signed in (default: THREADS_ACCOUNT)
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
      account: { type: "string" },
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
    device: values.device ?? process.env.THREADS_ADB_DEVICE,
    account: values.account ?? process.env.THREADS_ACCOUNT,
    gapMs: [minGap * MINUTE_MS, maxGap * MINUTE_MS],
    withImage: !values["no-image"],
  };
};

const readJson = async (path, fallback) => (existsSync(path) ? JSON.parse(await readFile(path, "utf8")) : fallback);

/** Jobs that are live on AreTalents and not yet on Threads, newest AniDay id first. */
const selectJobs = (jobs, published, ledger, { ids, limit }) => jobs
  .filter((job) => published[job.id]?.url && !ledger[job.id])
  .filter((job) => !ids.length || ids.includes(String(job.id)))
  .sort((a, b) => b.id - a.id)
  .slice(0, limit);

const resolveDevice = async (device) => {
  if (device) return device;
  print("No --device given, so scanning the local network for ADB on port 5555...");
  const found = await discoverDevices();
  if (found.length !== 1) {
    throw new Error(found.length
      ? `Found several devices (${found.join(", ")}). Pick one with --device.`
      : "No device with ADB over Wi-Fi found. Switch it on, or pass --device <ip:port>.");
  }
  print(`Found ${found[0]}`);
  return found[0];
};

const writePreview = async (posts) => {
  const body = posts.map(({ job, text, imagePath }) => [
    `## ${job.id} · ${job.title}`, "", "```text", text, "```", "", imagePath ? `![card](${imagePath})` : "", "",
  ].join("\n"));
  const path = `${OUT_DIR}/posts.md`;
  await writeFile(path, `# Threads posts preview\n\n${body.join("\n")}`);
  return path;
};

const randomGap = ([min, max]) => min + Math.floor(Math.random() * (max - min + 1));

const runPosts = async (adb, posts, ledger, options) => {
  let current = ledger;
  for (const [index, { job, text, imagePath, url }] of posts.entries()) {
    const label = `${job.id}  ${job.title}`;
    try {
      const outcome = await postToThreads(adb, { text, imagePath, account: options.account, submit: !options.composeOnly });
      print(`${outcome.padEnd(10)} ${label}`);
      if (outcome === "posted") {
        current = { ...current, [job.id]: { postedAt: new Date().toISOString(), url } };
        await writeJsonFile(LEDGER_PATH, current);
      }
    } catch (error) {
      // If Post was tapped but the composer didn't close in time, the post may be live, so the
      // batch stops for a person to check rather than risk a duplicate.
      throw new Error(`failed     ${label}: ${error.message}\nStopped. Check the Threads profile, then run again to continue.`);
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
  assertFlagsArrived(FLAGS, "src/threadsCli.js");
  loadEnv();
  const options = readOptions();
  if (options.help) return print(USAGE);
  if (!options.dryRun && !options.account) throw new Error("Set THREADS_ACCOUNT in .env or pass --account <username>");

  const { jobs } = await readJson(JOBS_PATH, { jobs: [] });
  const published = await readJson(PUBLISHED_PATH, {});
  const ledger = await readJson(LEDGER_PATH, {});
  const selected = selectJobs(jobs, published, ledger, options);
  if (!selected.length) return print("Nothing to post: every published job is already in data/threadsPosted.json.");

  const images = options.withImage
    ? await renderCards(selected.map(buildCardSpec), `${OUT_DIR}/cards`, options.account ?? "")
    : {};
  const posts = selected.map((job) => ({
    job,
    url: published[job.id].url,
    text: buildPostText(job, published[job.id].url),
    imagePath: images[job.id],
  }));
  print(`${posts.length} job(s) to post.`);

  if (options.dryRun) return print(`Preview written to ${await writePreview(posts)}`);

  const serial = await resolveDevice(options.device);
  await connectDevice(serial, process.env.ADB_PATH);
  await runPosts(createAdb({ serial, adbPath: process.env.ADB_PATH }), posts, ledger, options);
  print("Done.");
};

runMain(main);
