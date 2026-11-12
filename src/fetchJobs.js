import { toJobRecord, toRestrictedRecord } from "./jobMapper.js";

const IT_JOB_TYPE_ID = 1;

const listAllJobs = async (client, { jobTypeId, maxPages, limit }) => {
  const seen = new Map();
  let pageIndex = 0;
  let totalPages = 1;
  while (pageIndex < Math.min(totalPages, maxPages) && seen.size < limit) {
    const page = await client.listJobs({ jobTypeId, pageIndex });
    totalPages = page.totalPages;
    page.items.forEach((job) => { if (!seen.has(job.id)) seen.set(job.id, job); });
    pageIndex += 1;
  }
  return [...seen.values()].slice(0, limit);
};

const fetchRecord = async (client, job, fetchedAt) => {
  // Private jobs are refused for this account, so they are not requested at all.
  if (job.isPublic === false) return toRestrictedRecord(job, fetchedAt);
  try {
    const detail = await client.getJobDetail(job.id);
    return detail ? toJobRecord(detail, fetchedAt) : toRestrictedRecord(job, fetchedAt);
  } catch (error) {
    return { ...toRestrictedRecord(job, fetchedAt), status: "failed", error: error.message };
  }
};

const summarize = (jobs) => {
  const countOf = (status) => jobs.filter((job) => job.status === status).length;
  return { listed: jobs.length, ok: countOf("ok"), restricted: countOf("restricted"), failed: countOf("failed") };
};

/**
 * @param {ReturnType<typeof import("./anidayClient.js").createAnidayClient>} client
 * @param {{
 *   jobTypeId?: number,
 *   maxPages?: number,
 *   limit?: number,
 *   now?: () => string,
 *   onProgress?: (done: number, total: number) => void,
 * }} [options]
 * @returns {Promise<{ accountRef: string, jobs: Record<string, any>[], summary: Record<string, number> }>}
 */
export async function fetchJobs(client, {
  jobTypeId = IT_JOB_TYPE_ID,
  maxPages = Infinity,
  limit = Infinity,
  now = () => new Date().toISOString(),
  onProgress = () => {},
} = {}) {
  const accountId = await client.login();
  const listed = await listAllJobs(client, { jobTypeId, maxPages, limit });

  const jobs = [];
  for (const job of listed) {
    jobs.push(await fetchRecord(client, job, now()));
    onProgress(jobs.length, listed.length);
  }
  return { accountRef: `aniday-account-${accountId}`, jobs, summary: summarize(jobs) };
}
