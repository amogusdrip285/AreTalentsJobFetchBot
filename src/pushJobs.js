import { toAreTalentsJob } from "./areTalentsClient.js";
import { inferWorkMode, toPublicMarkdown, toPublication } from "./publication.js";
import { classifyRoleFamily } from "./roleFamily.js";

const SOURCE_EXISTS_CODE = "JOB_SOURCE_EXISTS";
// Every remaining job would fail the same way, so the batch stops at the first one.
const BATCH_STOPPING_STATUSES = [401, 403, 429];

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Checked before any request, because a draft that can't be published can't be deleted either.
const findPublishProblem = (job, workMode) => {
  try {
    toPublication(job, workMode);
    toPublicMarkdown(job);
    return null;
  } catch (error) {
    return error.message;
  }
};

const planJob = (job, { pushed, published, assignments, workModes, dryRun, shouldPublish }) => {
  const base = { id: job.id, title: job.title };
  const areTalentsId = pushed[job.id];
  if (published[job.id]) {
    return { ...base, outcome: "already-published", areTalentsId, publicUrl: published[job.id].url };
  }
  if (areTalentsId && !shouldPublish) return { ...base, outcome: "already-pushed", areTalentsId };
  if (job.status !== "ok") return { ...base, outcome: "restricted" };
  const roleFamily = assignments[job.id] ?? classifyRoleFamily(job);
  if (!roleFamily && !areTalentsId) return { ...base, outcome: "unclassified" };
  const ready = { ...base, roleFamily, areTalentsId };
  if (!shouldPublish) return { ...ready, outcome: dryRun ? "would-push" : "ready" };
  const workMode = workModes[job.id] ?? inferWorkMode(job);
  const problem = findPublishProblem(job, workMode);
  if (problem) return { ...ready, workMode, outcome: "failed", error: problem };
  return { ...ready, workMode, outcome: dryRun ? "would-publish" : "ready" };
};

const createJob = async (client, job, plan, accountRef) => {
  try {
    const created = await client.createJob(toAreTalentsJob(job, plan.roleFamily, accountRef));
    return { ...plan, outcome: "pushed", areTalentsId: created.id };
  } catch (error) {
    if (error.code === SOURCE_EXISTS_CODE) return { ...plan, outcome: "exists" };
    return { ...plan, outcome: "failed", error: error.message, status: error.status };
  }
};

// The JD is replaced first so the job is never public with the full workspace version.
const publishJob = async (client, job, plan, pace) => {
  let isPublishing = false;
  try {
    const { areTalentsId } = plan;
    const body = toPublication(job, plan.workMode);
    const markdown = toPublicMarkdown(job);
    await pace();
    const current = await client.getJob(areTalentsId);
    if (current.raw_jd_markdown !== markdown) {
      await pace();
      await client.addJobVersion(areTalentsId, { expected_version: current.current_version, raw_jd_markdown: markdown });
    }
    await pace();
    isPublishing = true;
    const publication = await client.publishJob(areTalentsId, body);
    return { ...plan, outcome: "published", publicId: publication.public_id, publicUrl: publication.url };
  } catch (error) {
    // Here a 403 means an admin revoked this job. It says nothing about the jobs after it.
    const isJobSpecific = isPublishing && error.status === 403;
    return { ...plan, outcome: "failed", error: error.message, status: error.status, isJobSpecific };
  }
};

/**
 * @param {{
 *   createJob: (payload: Record<string, unknown>) => Promise<{ id: string }>,
 *   getJob?: (id: string) => Promise<{ current_version: number, raw_jd_markdown: string }>,
 *   addJobVersion?: (id: string, body: Record<string, unknown>) => Promise<unknown>,
 *   publishJob?: (id: string, body: Record<string, unknown>) => Promise<{ public_id: string, url: string }>,
 * } | null} client null for a dry run
 * @param {Record<string, any>[]} jobs records from data/jobs.json
 * @param {{
 *   accountRef: string,
 *   pushed?: Record<string, string>,
 *   published?: Record<string, { publicId: string, url: string }>,
 *   assignments?: Record<string, string>,
 *   workModes?: Record<string, string>,
 *   dryRun?: boolean,
 *   shouldPublish?: boolean,
 *   delayMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   onCreated?: (result: Record<string, any>) => void | Promise<void>,
 *   onResult?: (result: Record<string, any>) => void | Promise<void>,
 * }} options
 * @returns {Promise<Record<string, any>[]>} one result per job, in order. A result with an
 *   `areTalentsId` exists on AreTalents, even if its outcome is "failed" at the publish step.
 */
export async function pushJobs(client, jobs, {
  accountRef,
  pushed = {},
  published = {},
  assignments = {},
  workModes = {},
  dryRun = false,
  shouldPublish = false,
  delayMs = 1000,
  sleep = realSleep,
  onCreated = () => {},
  onResult = () => {},
}) {
  const results = [];
  let hasSent = false;
  let isStopped = false;

  // Paced per request, not per job: publishing takes several requests for each job.
  const pace = async () => {
    if (hasSent) await sleep(delayMs);
    hasSent = true;
  };

  const sendJob = async (job, plan) => {
    let current = plan;
    if (!plan.areTalentsId) {
      await pace();
      current = await createJob(client, job, plan, accountRef);
      if (current.areTalentsId) await onCreated(current);
    }
    if (!shouldPublish || !current.areTalentsId) return current;
    return publishJob(client, job, current, pace);
  };

  for (const job of jobs) {
    const plan = planJob(job, { pushed, published, assignments, workModes, dryRun, shouldPublish });
    let result = plan;
    if (plan.outcome === "ready" && isStopped) {
      result = { ...plan, outcome: "not-attempted" };
    } else if (plan.outcome === "ready") {
      result = await sendJob(job, plan);
      isStopped = BATCH_STOPPING_STATUSES.includes(result.status) && !result.isJobSpecific;
    }
    results.push(result);
    await onResult(result);
  }
  return results;
}
