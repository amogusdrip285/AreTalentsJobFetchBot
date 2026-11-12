import assert from "node:assert/strict";
import { test } from "node:test";
import { AreTalentsError, createAreTalentsClient, toAreTalentsJob } from "../src/areTalentsClient.js";

const job = {
  id: 7,
  status: "ok",
  title: "QA Engineer",
  company: { name: "Acme" },
  locations: ["Hanoi"],
  levels: ["Senior"],
  skills: ["Playwright", "API"],
  description: "- Test things",
  requirements: "- 3 years",
  niceToHave: "",
  benefits: "- Laptop",
  interviewProcess: "2 rounds",
  referralBonusVnd: 25000000,
};

test("toAreTalentsJob builds the payload and leaves out empty sections", () => {
  const payload = toAreTalentsJob(job, "TESTER", "aniday-account-1");

  assert.equal(payload.title, "QA Engineer");
  assert.equal(payload.role_family, "TESTER");
  assert.equal(payload.source, "ANIDAY");
  assert.equal(payload.source_account_ref, "aniday-account-1");
  assert.equal(payload.external_id, "7");
  assert.match(payload.raw_jd_markdown, /^# QA Engineer\n/);
  assert.match(payload.raw_jd_markdown, /## Requirements\n- 3 years/);
  assert.equal(payload.raw_jd_markdown.includes("Nice to have"), false);
});

test("toAreTalentsJob does not expose the referral bonus", () => {
  assert.equal(JSON.stringify(toAreTalentsJob(job, "TESTER", "aniday-account-1")).includes("25000000"), false);
});

test("toAreTalentsJob rejects an unknown role family", () => {
  assert.throws(() => toAreTalentsJob(job, "SALES", "aniday-account-1"), /role family/);
});

test("toAreTalentsJob rejects a job without a description", () => {
  assert.throws(() => toAreTalentsJob({ ...job, status: "restricted", description: undefined }, "TESTER", "aniday-account-1"), /description/);
});

test("createJob sends the bearer key", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ data: { id: "j1" } }), { status: 201 });
  };
  const client = createAreTalentsClient({ baseUrl: "https://at.test", apiKey: "art_x", fetchImpl });

  const created = await client.createJob({ title: "T" });

  assert.equal(created.id, "j1");
  assert.equal(calls[0].url, "https://at.test/api/v1/jobs");
  assert.equal(calls[0].init.headers.Authorization, "Bearer art_x");
});

test("API errors surface the code and request id but never the key", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: { code: "BAD_REQUEST", message: "bad" }, request_id: "r1" }), { status: 400 });
  const client = createAreTalentsClient({ baseUrl: "https://at.test", apiKey: "art_secret", fetchImpl });

  await assert.rejects(client.createJob({}), (error) => {
    assert.ok(error instanceof AreTalentsError);
    assert.equal(error.status, 400);
    assert.equal(error.code, "BAD_REQUEST");
    assert.match(error.message, /BAD_REQUEST.*bad.*r1/);
    assert.equal(error.message.includes("art_secret"), false);
    return true;
  });
});

test("toAreTalentsJob rejects a missing account reference", () => {
  assert.throws(() => toAreTalentsJob(job, "TESTER", undefined), /account reference/);
});

test("createJob rejects a success response without an id", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ data: {} }), { status: 201 });
  const client = createAreTalentsClient({ baseUrl: "https://at.test", apiKey: "k", fetchImpl });

  await assert.rejects(client.createJob({}), /no id/);
});

test("refuses to send the key over plain http", () => {
  assert.throws(() => createAreTalentsClient({ baseUrl: "http://at.test", apiKey: "k" }), /https/);
});

test("requests carry a timeout", async () => {
  let signal;
  const fetchImpl = async (url, init) => {
    signal = init.signal;
    return new Response(JSON.stringify({ data: { id: "j1" } }), { status: 200 });
  };
  const client = createAreTalentsClient({ baseUrl: "https://at.test", apiKey: "k", fetchImpl });

  await client.getJob("j1");

  assert.ok(signal instanceof AbortSignal);
});

test("getJob reads one job", async () => {
  const fetchImpl = async (url) => new Response(JSON.stringify({ data: { id: "j1", url } }), { status: 200 });
  const client = createAreTalentsClient({ baseUrl: "https://at.test", apiKey: "k", fetchImpl });

  assert.equal((await client.getJob("j1")).url, "https://at.test/api/v1/jobs/j1");
});

test("publishJob posts to the job and returns an absolute public url", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const data = { public_id: "j12", public_url: "/viec-lam/java-j12" };
    return new Response(JSON.stringify({ data, job: { status: "ACTIVE" } }), { status: 200 });
  };
  const client = createAreTalentsClient({ baseUrl: "https://at.test", apiKey: "k", fetchImpl });

  const publication = await client.publishJob("j1", { location: "Hanoi", work_mode: "Onsite" });

  assert.equal(calls[0].url, "https://at.test/api/v1/jobs/j1/publish");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { location: "Hanoi", work_mode: "Onsite" });
  assert.equal(publication.public_id, "j12");
  assert.equal(publication.url, "https://at.test/viec-lam/java-j12");
});

test("publishJob rejects a success response without a public url", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ data: {} }), { status: 200 });
  const client = createAreTalentsClient({ baseUrl: "https://at.test", apiKey: "k", fetchImpl });

  await assert.rejects(client.publishJob("j1", {}), /no public url/);
});

test("addJobVersion posts the new version", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ data: { version: 2 } }), { status: 201 });
  };
  const client = createAreTalentsClient({ baseUrl: "https://at.test", apiKey: "k", fetchImpl });

  await client.addJobVersion("j1", { expected_version: 1, raw_jd_markdown: "new" });

  assert.equal(calls[0].url, "https://at.test/api/v1/jobs/j1/versions");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { expected_version: 1, raw_jd_markdown: "new" });
});
