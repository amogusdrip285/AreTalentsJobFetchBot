import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchJobs } from "../src/fetchJobs.js";

const fakeClient = ({ pages, details = {} }) => {
  const detailCalls = [];
  return {
    detailCalls,
    login: async () => {},
    listJobs: async ({ pageIndex }) => ({ items: pages[pageIndex] ?? [], totalPages: pages.length }),
    getJobDetail: async (id) => {
      detailCalls.push(id);
      const detail = details[id];
      if (detail instanceof Error) throw detail;
      return detail ?? null;
    },
  };
};

const job = (id, isPublic = true) => ({ id, name: `Job ${id}`, isPublic });
const now = () => "t";

test("fetchJobs reports an opaque account reference", async () => {
  const client = { login: async () => 42, listJobs: async () => ({ items: [], totalPages: 0 }), getJobDetail: async () => null };

  const { accountRef } = await fetchJobs(client);

  assert.equal(accountRef, "aniday-account-42");
});

test("walks every page and fetches details for public jobs", async () => {
  const client = fakeClient({
    pages: [[job(1)], [job(2)]],
    details: { 1: { id: 1, name: "One", jobDescription: "a" }, 2: { id: 2, name: "Two", jobDescription: "b" } },
  });

  const { jobs, summary } = await fetchJobs(client, { now });

  assert.deepEqual(jobs.map((j) => j.description), ["a", "b"]);
  assert.deepEqual(summary, { listed: 2, ok: 2, restricted: 0, failed: 0 });
});

test("never requests the detail of a job marked private", async () => {
  const client = fakeClient({ pages: [[job(1, false)]] });

  const { jobs, summary } = await fetchJobs(client, { now });

  assert.deepEqual(client.detailCalls, []);
  assert.equal(jobs[0].status, "restricted");
  assert.equal(summary.restricted, 1);
});

test("a job without the isPublic field is requested so the server can decide", async () => {
  const client = fakeClient({ pages: [[{ id: 1, name: "One" }]], details: { 1: { id: 1, name: "One" } } });

  const { jobs } = await fetchJobs(client, { now });

  assert.equal(jobs[0].status, "ok");
});

test("a permission refusal on a public job is recorded as restricted", async () => {
  const client = fakeClient({ pages: [[job(1)]], details: { 1: null } });

  const { jobs } = await fetchJobs(client, { now });

  assert.equal(jobs[0].status, "restricted");
});

test("one failing job does not stop the run", async () => {
  const client = fakeClient({
    pages: [[job(1), job(2)]],
    details: { 1: new Error("HTTP 500"), 2: { id: 2, name: "Two" } },
  });

  const { jobs, summary } = await fetchJobs(client, { now });

  assert.equal(jobs[0].status, "failed");
  assert.equal(jobs[0].error, "HTTP 500");
  assert.equal(jobs[1].status, "ok");
  assert.equal(summary.failed, 1);
});

test("drops jobs repeated across pages", async () => {
  const client = fakeClient({ pages: [[job(1)], [job(1), job(2)]], details: { 1: { id: 1 }, 2: { id: 2 } } });

  const { jobs } = await fetchJobs(client, { now });

  assert.deepEqual(jobs.map((j) => j.id), [1, 2]);
  assert.deepEqual(client.detailCalls, [1, 2]);
});

test("maxPages and limit bound the run", async () => {
  const client = fakeClient({
    pages: [[job(1), job(2)], [job(3)]],
    details: { 1: { id: 1 }, 2: { id: 2 }, 3: { id: 3 } },
  });

  const { jobs } = await fetchJobs(client, { maxPages: 1, limit: 1, now });

  assert.deepEqual(jobs.map((j) => j.id), [1]);
});
