import assert from "node:assert/strict";
import { test } from "node:test";
import { issueApiKey, setEnvValues } from "../src/areTalentsSetup.js";

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers });

const loginOk = () => json(200, { data: { csrf_token: "csrf1" } }, { "Set-Cookie": "aretalents_session=s1; Path=/; HttpOnly" });
const keyOk = () => json(201, { data: { token: "art_new", token_prefix: "art_n", expires_at: "2027-01-01T00:00:00Z" } });

const fakeFetch = (responses) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return responses.shift()();
  };
  return { calls, fetchImpl };
};

const credentials = { baseUrl: "https://at.test", email: "a@b.test", password: "pw-secret" };

test("issueApiKey logs in and requests a key limited to job scopes", async () => {
  const { calls, fetchImpl } = fakeFetch([loginOk, keyOk]);

  const key = await issueApiKey({ ...credentials, fetchImpl });

  assert.deepEqual(key, { token: "art_new", prefix: "art_n", expiresAt: "2027-01-01T00:00:00Z" });
  assert.equal(calls[0].url, "https://at.test/api/v1/auth/login");
  assert.equal(calls[1].url, "https://at.test/api/v1/me/api-keys");
  assert.equal(calls[1].init.headers.Cookie, "aretalents_session=s1");
  assert.equal(calls[1].init.headers["X-CSRF-Token"], "csrf1");
  assert.deepEqual(JSON.parse(calls[1].init.body).scopes, ["jobs:read", "jobs:write"]);
});

test("issueApiKey registers first only when asked", async () => {
  const { calls, fetchImpl } = fakeFetch([() => json(201, { data: {} }), loginOk, keyOk]);

  await issueApiKey({ ...credentials, shouldRegister: true, fetchImpl });

  assert.equal(calls[0].url, "https://at.test/api/v1/auth/register");
  assert.deepEqual(JSON.parse(calls[0].init.body).roles, ["HEADHUNTER"]);
});

test("a failed login reports the API error without the password", async () => {
  const { fetchImpl } = fakeFetch([() => json(401, { error: { code: "INVALID_CREDENTIALS", message: "wrong" } })]);

  await assert.rejects(issueApiKey({ ...credentials, fetchImpl }), (error) => {
    assert.match(error.message, /login failed: HTTP 401 INVALID_CREDENTIALS wrong/);
    assert.equal(error.message.includes("pw-secret"), false);
    return true;
  });
});

test("a login without a session cookie is an error", async () => {
  const { fetchImpl } = fakeFetch([() => json(200, { data: {} })]);

  await assert.rejects(issueApiKey({ ...credentials, fetchImpl }), /no session/);
});

test("setEnvValues replaces existing keys and appends new ones", () => {
  const updated = setEnvValues("A=1\r\nB=2\n", { B: "x=y", C: "3" });

  assert.equal(updated, "A=1\nB=x=y\nC=3\n");
});

test("setEnvValues keeps comments and blank lines", () => {
  assert.equal(setEnvValues("# note\n\nA=1\n", { A: "2" }), "# note\n\nA=2\n");
});
