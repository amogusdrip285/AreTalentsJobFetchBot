#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assertFlagsArrived, intAtLeast, loadEnv, print, runMain, writeJsonFile } from "./cliSupport.js";
import { renderCards } from "./jobCard.js";
import { buildCardSpec, buildPostText } from "./threadsPost.js";
import { accountFile, openThreads, sleep } from "./threadsWeb.js";

const dataPath = (name) => fileURLToPath(new URL(`../data/${name}`, import.meta.url));
const JOBS_PATH = dataPath("jobs.json");
const PUBLISHED_PATH = dataPath("published.json");
const OUT_DIR = dataPath("threads");
const COMPOSE_DIR = `${OUT_DIR}/compose`;
// One ledger per account, so a new account posts every job again.
const ledgerPath = (username) => accountFile(OUT_DIR, "posted", username);
const MINUTE_MS = 60_000;
const BROWSERS = ["chrome", "msedge"];

const FLAGS = ["dry-run", "compose-only", "id", "limit", "headed", "browser", "min-gap", "max-gap", "no-image"];

const USAGE = `Usage: node src/threadsCli.js [options]

Posts every job that is live on AreTalents to Threads, one post per job, from a
browser that logs in as THREADS_USERNAME with THREADS_PASSWORD (both in .env).

  --dry-run          Write the posts and images to data/threads/ only; doesn't open Threads
  --compose-only     Log in and fill in each post, but don't post it. Saves a screenshot
                     of each to data/threads/compose/
  --id <aniday id>   Only this job (repeatable)
  --limit <n>        Post at most n jobs this run
  --headed           Show the browser window, to finish a login check by hand
  --browser <name>   ${BROWSERS.join(" or ")}, as installed on this computer (default: chrome)
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
      headed: { type: "boolean", default: false },
      browser: { type: "string", default: "chrome" },
      "min-gap": { type: "string", default: "4" },
      "max-gap": { type: "string", default: "9" },
      "no-image": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (!BROWSERS.includes(values.browser)) throw new Error(`--browser must be one of ${BROWSERS.join(", ")}`);
  const minGap = intAtLeast(values["min-gap"], "min-gap", 1);
  const maxGap = intAtLeast(values["max-gap"], "max-gap", minGap);
  return {
    help: values.help,
    dryRun: values["dry-run"],
    composeOnly: values["compose-only"],
    ids: values.id,
    limit: values.limit === undefined ? Infinity : intAtLeast(values.limit, "limit", 1),
    headed: values.headed,
    browser: values.browser,
    username: process.env.THREADS_USERNAME?.trim().replace(/^@/, "") || undefined,
    password: process.env.THREADS_PASSWORD || undefined,
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

const writePreview = async (posts) => {
  const body = posts.map(({ job, text, imagePath }) => [
    `## ${job.id} · ${job.title}`, "", "```text", text, "```", "", imagePath ? `![card](${imagePath})` : "", "",
  ].join("\n"));
  const path = `${OUT_DIR}/posts.md`;
  await writeFile(path, `# Threads posts preview\n\n${body.join("\n")}`);
  return path;
};

const randomGap = ([min, max]) => min + Math.floor(Math.random() * (max - min + 1));

const runPosts = async (threads, posts, ledger, options) => {
  const path = ledgerPath(options.username);
  let current = ledger;
  for (const [index, { job, text, imagePath, url }] of posts.entries()) {
    const label = `${job.id}  ${job.title}`;
    try {
      const outcome = await threads.post({
        text, imagePath, submit: !options.composeOnly, screenshotPath: `${COMPOSE_DIR}/job-${job.id}.png`,
      });
      print(`${outcome.padEnd(10)} ${label}`);
      if (outcome === "posted") {
        current = { ...current, [job.id]: { postedAt: new Date().toISOString(), url } };
        await writeJsonFile(path, current);
      }
    } catch (error) {
      // If Post was clicked but the composer didn't close in time, the post may be live, so the
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
  if (!options.dryRun && !options.username) throw new Error("Set THREADS_USERNAME and THREADS_PASSWORD in .env");

  const { jobs } = await readJson(JOBS_PATH, { jobs: [] });
  const published = await readJson(PUBLISHED_PATH, {});
  // A dry run has no account, so it previews every published job.
  const ledger = options.username ? await readJson(ledgerPath(options.username), {}) : {};
  const selected = selectJobs(jobs, published, ledger, options);
  if (!selected.length) return print(`Nothing to post: ${options.username} has already posted every published job.`);

  const images = options.withImage
    ? await renderCards(selected.map(buildCardSpec), `${OUT_DIR}/cards`, options.username ?? "")
    : {};
  const posts = selected.map((job) => ({
    job,
    url: published[job.id].url,
    text: buildPostText(job, published[job.id].url),
    imagePath: images[job.id],
  }));
  print(`${posts.length} job(s) to post.`);

  if (options.dryRun) return print(`Preview written to ${await writePreview(posts)}`);

  if (options.composeOnly) await mkdir(COMPOSE_DIR, { recursive: true });
  print(`Opening Threads as ${options.username}...`);
  const threads = await openThreads({
    username: options.username,
    password: options.password,
    sessionFile: accountFile(OUT_DIR, "session", options.username),
    headed: options.headed,
    channel: options.browser,
  });
  try {
    await runPosts(threads, posts, ledger, options);
  } finally {
    await threads.close();
  }
  return print("Done.");
};

runMain(main);
