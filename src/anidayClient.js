const API_URL = "https://apigateway.aniday.com";
const SITE_ORIGIN = "https://app.aniday.com";
const PAGE_SIZE = 20;
const MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 5000;
const MAX_RETRY_DELAY_MS = 60000;
const NO_PERMISSION_ERROR_CODE = 20;
// Same filters the site's own /jobs page sends.
const LIST_DEFAULTS = {
  sorting: "status.index asc, index desc",
  advance: "20,30",
  isBookmark: "false",
  isSuggestion: "false",
};
const BASE_HEADERS = {
  "Content-Type": "application/json",
  Origin: SITE_ORIGIN,
  Referer: `${SITE_ORIGIN}/`,
  "User-Agent": "Mozilla/5.0 (compatible; AreTalentsJobFetchBot/0.1)",
};

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class AnidayError extends Error {
  /**
   * @param {string} message
   * @param {number} [status]
   */
  constructor(message, status) {
    super(message);
    this.name = "AnidayError";
    this.status = status;
  }
}

const readJson = (response) => response.json().catch(() => null);

const retryDelayMs = (response) => {
  const seconds = Number(response.headers.get("Retry-After"));
  return seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_DELAY_MS) : DEFAULT_RETRY_DELAY_MS;
};

const isRetryable = (status) => status === 429 || status >= 500;

const isPermissionDenied = (status, body) =>
  status === 403 || (status === 400 && body?.data?.errorCode === NO_PERMISSION_ERROR_CODE);

/**
 * @param {{
 *   email: string,
 *   password: string,
 *   delayMs?: number,
 *   fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>,
 * }} options
 */
export function createAnidayClient({ email, password, delayMs = 1000, fetchImpl = fetch, sleep = realSleep }) {
  let token = null;
  let hasSentRequest = false;

  const throttledFetch = async (path, init) => {
    if (hasSentRequest) await sleep(delayMs);
    hasSentRequest = true;
    return fetchImpl(`${API_URL}${path}`, init);
  };

  const withRetries = async (send, attempt = 1) => {
    const response = await send();
    if (!isRetryable(response.status) || attempt >= MAX_ATTEMPTS) return response;
    await sleep(retryDelayMs(response));
    return withRetries(send, attempt + 1);
  };

  /** @returns {Promise<number>} the AniDay account id */
  const login = async () => {
    const response = await withRetries(() => throttledFetch("/api/v3/account/login", {
      method: "POST",
      headers: BASE_HEADERS,
      body: JSON.stringify({ email, password }),
    }));
    const body = await readJson(response);
    if (!response.ok || !body?.token) {
      throw new AnidayError(`AniDay login failed: ${body?.message ?? `HTTP ${response.status}`}`, response.status);
    }
    // The id becomes the permanent duplicate key on AreTalents, so a bad one must never get through.
    if (!Number.isInteger(body.id) || body.id <= 0) throw new AnidayError("AniDay login returned no account id", response.status);
    token = body.token;
    return body.id;
  };

  const authorizedGet = async (path, hasRelogged = false) => {
    const response = await withRetries(() => throttledFetch(path, {
      headers: { ...BASE_HEADERS, Authorization: `Bearer ${token}` },
    }));
    if (response.status === 401 && !hasRelogged) {
      await login();
      return authorizedGet(path, true);
    }
    return response;
  };

  /**
   * @param {{ jobTypeId: number, pageIndex: number }} query pageIndex is zero based
   * @returns {Promise<{ items: Record<string, any>[], totalPages: number }>}
   */
  const listJobs = async ({ jobTypeId, pageIndex }) => {
    const params = new URLSearchParams({
      ...LIST_DEFAULTS,
      pageSize: String(PAGE_SIZE),
      pageIndex: String(pageIndex),
      jobTypeId: String(jobTypeId),
    });
    const response = await authorizedGet(`/api/v3/job/getjobpagelistby?${params}`);
    const body = await readJson(response);
    if (!response.ok || !Array.isArray(body?.items) || !Number.isInteger(body?.totalPages)) {
      throw new AnidayError(`Job list failed: HTTP ${response.status}`, response.status);
    }
    return body;
  };

  /**
   * @param {number} id
   * @returns {Promise<Record<string, any> | null>} null when this account may not view the job
   */
  const getJobDetail = async (id) => {
    const response = await authorizedGet(`/api/v3/job/detail/${id}`);
    const body = await readJson(response);
    if (isPermissionDenied(response.status, body)) return null;
    if (!response.ok || !body) {
      throw new AnidayError(`Job ${id} failed: HTTP ${response.status}`, response.status);
    }
    return body;
  };

  return { login, listJobs, getJobDetail };
}
