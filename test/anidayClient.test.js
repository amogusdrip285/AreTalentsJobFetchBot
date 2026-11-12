import assert from "node:assert/strict";
import { test } from "node:test";
import { AnidayError, createAnidayClient } from "../src/anidayClient.js";

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers });

// Replays canned responses in order and records every call.
const scriptedFetch = (responses) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses[calls.length - 1];
    if (!next) throw new Error(`unexpected request ${url}`);
    return next();
  };
  return { fetchImpl, calls };
};

const createClient = (responses, sleeps = []) => {
  const scripted = scriptedFetch(responses);
  const client = createAnidayClient({
    email: "a@b.test",
    password: "pw",
    delayMs: 0,
    fetchImpl: scripted.fetchImpl,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  return { client, calls: scripted.calls };
};

const loginOk = (token = "t1") => () => json(200, { id: 1, token });

test("login sends the credentials and listJobs uses the bearer token", async () => {
  const { client, calls } = createClient([loginOk(), () => json(200, { items: [], totalPages: 0 })]);

  await client.login();
  await client.listJobs({ jobTypeId: 1, pageIndex: 2 });

  assert.deepEqual(JSON.parse(calls[0].init.body), { email: "a@b.test", password: "pw" });
  assert.equal(calls[1].init.headers.Authorization, "Bearer t1");
  const url = new URL(calls[1].url);
  assert.equal(url.pathname, "/api/v3/job/getjobpagelistby");
  assert.equal(url.searchParams.get("pageIndex"), "2");
  assert.equal(url.searchParams.get("jobTypeId"), "1");
});

test("login returns the account id", async () => {
  const { client } = createClient([loginOk()]);

  assert.equal(await client.login(), 1);
});

test("login without a valid account id is an error", async () => {
  const { client } = createClient([() => json(200, { token: "t1" })]);

  await assert.rejects(client.login(), /no account id/);
});

test("login failure raises an error without leaking the password", async () => {
  const { client } = createClient([() => json(400, { success: false, message: "The account or password is incorrect." })]);

  await assert.rejects(client.login(), (error) => {
    assert.ok(error instanceof AnidayError);
    assert.match(error.message, /incorrect/);
    assert.equal(error.message.includes("pw"), false);
    return true;
  });
});

test("getJobDetail returns null when the account lacks permission", async () => {
  const { client } = createClient([
    loginOk(),
    () => json(400, { success: false, message: "You do not have permission to view this job.", data: { errorCode: 20 } }),
  ]);

  await client.login();

  assert.equal(await client.getJobDetail(5), null);
});

test("an expired token triggers one re-login and a retry", async () => {
  const { client, calls } = createClient([
    loginOk("old"),
    () => json(401, {}),
    loginOk("new"),
    () => json(200, { id: 5 }),
  ]);

  await client.login();
  const job = await client.getJobDetail(5);

  assert.equal(job.id, 5);
  assert.equal(calls[3].init.headers.Authorization, "Bearer new");
});

test("a second 401 after re-login is an error", async () => {
  const { client } = createClient([loginOk(), () => json(401, {}), loginOk(), () => json(401, {})]);

  await client.login();

  await assert.rejects(client.getJobDetail(5), AnidayError);
});

test("429 waits for Retry-After before retrying", async () => {
  const sleeps = [];
  const { client } = createClient(
    [loginOk(), () => json(429, {}, { "Retry-After": "3" }), () => json(200, { id: 5 })],
    sleeps,
  );

  await client.login();
  await client.getJobDetail(5);

  assert.ok(sleeps.includes(3000));
});

test("getJobDetail returns null on HTTP 403", async () => {
  const { client } = createClient([loginOk(), () => json(403, {})]);

  await client.login();

  assert.equal(await client.getJobDetail(5), null);
});

test("login retries a temporary server error", async () => {
  const { client, calls } = createClient([() => json(503, {}), loginOk()]);

  await client.login();

  assert.equal(calls.length, 2);
});

test("Retry-After is capped", async () => {
  const sleeps = [];
  const { client } = createClient(
    [loginOk(), () => json(429, {}, { "Retry-After": "86400" }), () => json(200, { id: 5 })],
    sleeps,
  );

  await client.login();
  await client.getJobDetail(5);

  assert.equal(Math.max(...sleeps), 60000);
});

test("listJobs rejects a response without totalPages", async () => {
  const { client } = createClient([loginOk(), () => json(200, { items: [] })]);

  await client.login();

  await assert.rejects(client.listJobs({ jobTypeId: 1, pageIndex: 0 }), AnidayError);
});

test("gives up after repeated server errors", async () => {
  const { client, calls } = createClient([
    loginOk(),
    () => json(503, {}),
    () => json(503, {}),
    () => json(503, {}),
  ]);

  await client.login();

  await assert.rejects(client.getJobDetail(5), /HTTP 503/);
  assert.equal(calls.length, 4);
});

test("waits the configured delay between requests", async () => {
  const sleeps = [];
  const fetchImpl = async () => json(200, { id: 1, token: "t" });
  const client = createAnidayClient({
    email: "a", password: "b", delayMs: 500, fetchImpl,
    sleep: async (ms) => { sleeps.push(ms); },
  });

  await client.login();
  await client.getJobDetail(1);

  assert.deepEqual(sleeps, [500]);
});
