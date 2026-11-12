#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createAreTalentsClient, ROLE_FAMILIES } from "./areTalentsClient.js";
import { assertFlagsArrived, intAtLeast, loadEnv, print, runMain, writeJsonFile } from "./cliSupport.js";
import { WORK_MODES } from "./publication.js";
import { pushJobs } from "./pushJobs.js";

const LEDGER_PATH = fileURLToPath(new URL("../data/pushed.json", import.meta.url));
const PUBLISHED_PATH = fileURLToPath(new URL("../data/published.json", import.meta.url));
const MIN_DELAY_MS = 200;

const FLAGS = ["dry-run", "publish", "id", "assign", "work-mode", "delay", "in"];

const USAGE = `Usage: node src/pushCli.js [options]

  --dry-run            Show what would happen, send nothing
  --publish            Also publish to the public job board
  --id <aniday id>     Only this job (repeatable)
  --assign <id=ROLE>   Set a job's role family by hand (repeatable)
                       ROLE is ${ROLE_FAMILIES.join(", ")}
  --work-mode <id=MODE>
                       Set a job's work mode by hand (repeatable)
                       MODE is ${WORK_MODES.join(", ")}
  --delay <ms>         Pause between requests (default: 1000, minimum: ${MIN_DELAY_MS})
  --in <path>          Input file (default: data/jobs.json)
  --help               Show this message
`;

const parsePair = (text, allowed, example) => {
  const [id, value, ...rest] = text.split("=");
  if (!/^\d+$/.test(id) || !allowed.includes(value) || rest.length > 0) {
    throw new Error(`Expected something like ${example}, got ${text}`);
  }
  return [id, value];
};

const readOptions = () => {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      publish: { type: "boolean", default: false },
      id: { type: "string", multiple: true, default: [] },
      assign: { type: "string", multiple: true, default: [] },
      "work-mode": { type: "string", multiple: true, default: [] },
      delay: { type: "string", default: "1000" },
      in: { type: "string", default: "data/jobs.json" },
      help: { type: "boolean", default: false },
    },
  });
  return {
    help: values.help,
    dryRun: values["dry-run"],
    shouldPublish: values.publish,
    ids: values.id,
    assignments: Object.fromEntries(values.assign.map((text) => parsePair(text, ROLE_FAMILIES, "--assign 16464=DEVELOPER"))),
    workModes: Object.fromEntries(values["work-mode"].map((text) => parsePair(text, WORK_MODES, "--work-mode 16464=Hybrid"))),
    delayMs: intAtLeast(values.delay, "delay", MIN_DELAY_MS),
    input: values.in,
  };
};

const readLedger = async () => {
  if (existsSync(LEDGER_PATH)) return JSON.parse(await readFile(LEDGER_PATH, "utf8"));
  process.stderr.write("No data/pushed.json yet, so this looks like a first push.\n");
  return {};
};

const readPublished = async () => (existsSync(PUBLISHED_PATH) ? JSON.parse(await readFile(PUBLISHED_PATH, "utf8")) : {});

const createClient = (dryRun) => {
  if (dryRun) return null;
  const { ARETALENTS_BASE_URL: baseUrl, ARETALENTS_API_KEY: apiKey } = process.env;
  if (!baseUrl || !apiKey) throw new Error("ARETALENTS_BASE_URL and ARETALENTS_API_KEY must be set in .env");
  return createAreTalentsClient({ baseUrl, apiKey });
};

const selectJobs = (jobs, { ids, assignments, workModes }) => {
  const named = [...ids, ...Object.keys(assignments), ...Object.keys(workModes)];
  const missing = named.filter((id) => !jobs.some((job) => String(job.id) === id));
  if (missing.length) throw new Error(`Not in the input file: ${missing.join(", ")}`);
  return ids.length ? jobs.filter((job) => ids.includes(String(job.id))) : jobs;
};

const formatResult = ({ id, title, outcome, roleFamily, workMode, areTalentsId, publicUrl, error }) =>
  [
    outcome.padEnd(17),
    String(id).padEnd(6),
    (roleFamily ?? "-").padEnd(17),
    (workMode ?? "-").padEnd(6),
    title,
    publicUrl ?? areTalentsId ?? "",
    error ?? "",
  ].join(" ").trimEnd();

const countOutcomes = (results) => Object.fromEntries(
  [...new Set(results.map((result) => result.outcome))]
    .map((outcome) => [outcome, results.filter((result) => result.outcome === outcome).length]),
);

const main = async () => {
  assertFlagsArrived(FLAGS, "src/pushCli.js");
  const options = readOptions();
  if (options.help) {
    print(USAGE);
    return;
  }

  loadEnv();
  const { jobs, accountRef } = JSON.parse(await readFile(options.input, "utf8"));
  if (!accountRef) throw new Error(`${options.input} has no accountRef; run npm start again`);

  let pushed = await readLedger();
  let published = await readPublished();
  const results = await pushJobs(createClient(options.dryRun), selectJobs(jobs, options), {
    ...options,
    accountRef,
    pushed,
    published,
    // Saved straight away so a crash cannot lose what already went through.
    onCreated: async (result) => {
      pushed = { ...pushed, [result.id]: result.areTalentsId };
      await writeJsonFile(LEDGER_PATH, pushed);
    },
    onResult: async (result) => {
      print(formatResult(result));
      if (result.outcome === "published") {
        published = { ...published, [result.id]: { publicId: result.publicId, url: result.publicUrl } };
        await writeJsonFile(PUBLISHED_PATH, published);
      }
    },
  });

  print(`\n${JSON.stringify(countOutcomes(results))}`);
  if (results.some((result) => ["failed", "not-attempted"].includes(result.outcome))) process.exitCode = 1;
};

runMain(main);
