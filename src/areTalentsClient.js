export const ROLE_FAMILIES = ["DEVELOPER", "TESTER", "IT_MIDDLE_MANAGER"];
const SOURCE = "ANIDAY";
const REQUEST_TIMEOUT_MS = 30000;

export class AreTalentsError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   * @param {string} code
   */
  constructor(message, status, code) {
    super(message);
    this.name = "AreTalentsError";
    this.status = status;
    this.code = code;
  }
}

/** @param {string} baseUrl */
export function assertHttps(baseUrl) {
  if (!baseUrl.startsWith("https://")) throw new Error("ARETALENTS_BASE_URL must start with https://");
}

const section = (heading, body) => (body ? [`## ${heading}\n${body}`] : []);

const formatFacts = (job) => [
  `**Company:** ${job.company.name}`,
  `**Location:** ${job.locations.join(", ")}`,
  ...(job.levels.length ? [`**Level:** ${job.levels.join(", ")}`] : []),
  ...(job.skills.length ? [`**Skills:** ${job.skills.join(", ")}`] : []),
].join("\n\n");

/**
 * Referral bonus is left out: it is headhunter commission, not part of the JD.
 * @param {Record<string, any>} job record from data/jobs.json
 * @param {string} roleFamily
 * @param {string} accountRef opaque AniDay account reference, never a credential
 * @returns {Record<string, string>} AreTalents rejects a second job with the same source, account and external id
 */
export function toAreTalentsJob(job, roleFamily, accountRef) {
  if (!ROLE_FAMILIES.includes(roleFamily)) {
    throw new Error(`Unknown role family ${roleFamily}; use one of ${ROLE_FAMILIES.join(", ")}`);
  }
  if (!accountRef) throw new Error("An AniDay account reference is required");
  if (!job.description) throw new Error(`Job ${job.id} has no description to push`);
  const markdown = [
    `# ${job.title}`,
    formatFacts(job),
    ...section("Description", job.description),
    ...section("Requirements", job.requirements),
    ...section("Nice to have", job.niceToHave),
    ...section("Benefits", job.benefits),
    ...section("Interview process", job.interviewProcess),
  ].join("\n\n");
  return {
    title: job.title,
    role_family: roleFamily,
    raw_jd_markdown: markdown,
    source: SOURCE,
    source_account_ref: accountRef,
    external_id: String(job.id),
  };
}

/**
 * @param {{ baseUrl: string, apiKey: string, fetchImpl?: typeof fetch }} options
 */
export function createAreTalentsClient({ baseUrl, apiKey, fetchImpl = fetch }) {
  assertHttps(baseUrl);

  const request = async (path, init = {}) => {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, ...init.headers },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const { code = "UNKNOWN", message = "" } = body?.error ?? {};
      throw new AreTalentsError(
        `AreTalents HTTP ${response.status} ${code}: ${message} (request ${body?.request_id ?? "n/a"})`,
        response.status,
        code,
      );
    }
    return body?.data;
  };

  /** @param {Record<string, unknown>} payload */
  const createJob = async (payload) => {
    const created = await request("/api/v1/jobs", { method: "POST", body: JSON.stringify(payload) });
    if (!created?.id) throw new AreTalentsError("AreTalents accepted a job but returned no id", 200, "NO_ID");
    return created;
  };

  /** @param {string} id */
  const getJob = (id) => request(`/api/v1/jobs/${id}`);

  /**
   * Safe to repeat: AreTalents updates the existing publication.
   * @param {string} id AreTalents job id
   * @param {Record<string, unknown>} body see toPublication
   * @returns {Promise<Record<string, any>>} the publication, with its absolute `url`
   */
  const publishJob = async (id, body) => {
    const publication = await request(`/api/v1/jobs/${id}/publish`, { method: "POST", body: JSON.stringify(body) });
    if (!publication?.public_url) {
      throw new AreTalentsError("AreTalents published a job but returned no public url", 200, "NO_URL");
    }
    return { ...publication, url: `${baseUrl}${publication.public_url}` };
  };

  /**
   * Also updates the public page of a published job.
   * @param {string} id AreTalents job id
   * @param {{ expected_version: number, raw_jd_markdown: string }} body
   */
  const addJobVersion = (id, body) => request(`/api/v1/jobs/${id}/versions`, { method: "POST", body: JSON.stringify(body) });

  return { createJob, getJob, addJobVersion, publishJob };
}
