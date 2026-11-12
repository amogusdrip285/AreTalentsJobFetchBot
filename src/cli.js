#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createAnidayClient } from "./anidayClient.js";
import { assertFlagsArrived, intAtLeast, loadEnv, print, runMain, writeJsonFile } from "./cliSupport.js";
import { fetchJobs } from "./fetchJobs.js";

const MIN_DELAY_MS = 200;

const FLAGS = ["pages", "limit", "job-type", "delay", "out", "show"];

const USAGE = `Usage: node src/cli.js [options]

  --pages <n>      Only read the first n list pages (default: all)
  --limit <n>      Only process the first n jobs (default: all)
  --job-type <id>  AniDay jobTypeId (default: 1, IT)
  --delay <ms>     Pause between requests (default: 1000, minimum: 200)
  --out <path>     Output file (default: data/jobs.json)
  --show <n>       Print n fetched job descriptions (default: 0)
  --help           Show this message
`;

const readOptions = () => {
  const { values } = parseArgs({
    options: {
      pages: { type: "string" },
      limit: { type: "string" },
      "job-type": { type: "string", default: "1" },
      delay: { type: "string", default: "1000" },
      out: { type: "string", default: "data/jobs.json" },
      show: { type: "string", default: "0" },
      help: { type: "boolean", default: false },
    },
  });
  return {
    help: values.help,
    maxPages: values.pages === undefined ? Infinity : intAtLeast(values.pages, "pages", 1),
    limit: values.limit === undefined ? Infinity : intAtLeast(values.limit, "limit", 1),
    jobTypeId: intAtLeast(values["job-type"], "job-type", 1),
    delayMs: intAtLeast(values.delay, "delay", MIN_DELAY_MS),
    out: values.out,
    show: intAtLeast(values.show, "show", 0),
  };
};

const readCredentials = () => {
  loadEnv();
  const { ANIDAY_EMAIL: email, ANIDAY_PASSWORD: password } = process.env;
  if (!email || !password) throw new Error("ANIDAY_EMAIL and ANIDAY_PASSWORD must be set in .env");
  return { email, password };
};

const section = (heading, body) => (body ? [`\n[${heading}]`, body] : []);

const formatJob = (job) => [
  "=".repeat(72),
  `${job.title} — ${job.company.name}`,
  `${job.locations.join(", ")} | ${job.levels.join(", ") || "level n/a"} | ${job.skills.join(", ") || "skills n/a"}`,
  job.url,
  ...section("Description", job.description),
  ...section("Requirements", job.requirements),
  ...section("Nice to have", job.niceToHave),
  ...section("Benefits", job.benefits),
  ...section("Interview process", job.interviewProcess),
].join("\n");

const main = async () => {
  assertFlagsArrived(FLAGS, "src/cli.js");
  const options = readOptions();
  if (options.help) {
    print(USAGE);
    return;
  }

  const client = createAnidayClient({ ...readCredentials(), delayMs: options.delayMs });
  const { accountRef, jobs, summary } = await fetchJobs(client, {
    ...options,
    onProgress: (done, total) => process.stderr.write(`\rFetched ${done}/${total}`),
  });
  process.stderr.write("\n");

  // A run that fetched nothing must not replace earlier good data.
  if (summary.ok === 0) throw new Error(`No job descriptions fetched, ${options.out} left unchanged: ${JSON.stringify(summary)}`);
  await writeJsonFile(options.out, { summary, accountRef, jobs });

  jobs.filter((job) => job.status === "ok").slice(0, options.show).forEach((job) => print(formatJob(job)));
  print(`\nSaved to ${options.out}: ${JSON.stringify(summary)}`);
  jobs.filter((job) => job.status === "failed").forEach((job) => print(`Failed ${job.id} ${job.title}: ${job.error}`));
  if (summary.failed > 0) process.exitCode = 1;
};

runMain(main);
