import { assertHttps } from "./areTalentsClient.js";

const KEY_NAME = "Job Fetch Bot";
const KEY_SCOPES = ["jobs:read", "jobs:write"];
const KEY_LIFETIME_DAYS = 90;
const SESSION_COOKIE = "aretalents_session=";
const JSON_HEADERS = { "Content-Type": "application/json" };

const failure = async (step, response) => {
  const body = await response.json().catch(() => null);
  const { code = "UNKNOWN", message = "" } = body?.error ?? {};
  return new Error(`AreTalents ${step} failed: HTTP ${response.status} ${code} ${message}`.trimEnd());
};

/**
 * Keys can only be issued from a login session, so this logs in first.
 * @param {{
 *   baseUrl: string,
 *   email: string,
 *   password: string,
 *   shouldRegister?: boolean,
 *   displayName?: string,
 *   fetchImpl?: typeof fetch,
 * }} options
 * @returns {Promise<{ token: string, prefix: string, expiresAt: string }>}
 */
export async function issueApiKey({ baseUrl, email, password, shouldRegister = false, displayName = KEY_NAME, fetchImpl = fetch }) {
  assertHttps(baseUrl);
  const post = (path, body, headers = {}) => fetchImpl(`${baseUrl}${path}`, {
    method: "POST",
    headers: { ...JSON_HEADERS, ...headers },
    body: JSON.stringify(body),
  });

  if (shouldRegister) {
    const registered = await post("/api/v1/auth/register", { email, password, display_name: displayName, roles: ["HEADHUNTER"] });
    if (!registered.ok) throw await failure("registration", registered);
  }

  const login = await post("/api/v1/auth/login", { email, password });
  if (!login.ok) throw await failure("login", login);
  const cookie = login.headers.getSetCookie().map((text) => text.split(";")[0]).find((text) => text.startsWith(SESSION_COOKIE));
  const csrfToken = (await login.json())?.data?.csrf_token;
  if (!cookie || !csrfToken) throw new Error("AreTalents login returned no session");

  const issued = await post(
    "/api/v1/me/api-keys",
    { name: KEY_NAME, scopes: KEY_SCOPES, expires_in_days: KEY_LIFETIME_DAYS },
    { Cookie: cookie, "X-CSRF-Token": csrfToken, Origin: baseUrl },
  );
  if (!issued.ok) throw await failure("key creation", issued);
  const { token, token_prefix: prefix, expires_at: expiresAt } = (await issued.json()).data;
  return { token, prefix, expiresAt };
}

/**
 * @param {string} text current .env contents
 * @param {Record<string, string>} values
 * @returns {string} the contents with those keys replaced, or appended when absent
 */
export function setEnvValues(text, values) {
  const lines = text.split(/\r?\n/).filter((line, index, all) => line !== "" || index < all.length - 1);
  const keyOf = (line) => line.slice(0, line.indexOf("="));
  const updated = lines.map((line) => (keyOf(line) in values ? `${keyOf(line)}=${values[keyOf(line)]}` : line));
  const added = Object.entries(values)
    .filter(([key]) => !lines.some((line) => keyOf(line) === key))
    .map(([key, value]) => `${key}=${value}`);
  return `${[...updated, ...added].join("\n")}\n`;
}
