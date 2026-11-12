import assert from "node:assert/strict";
import { test } from "node:test";
import { AreTalentsError } from "../src/areTalentsClient.js";
import { pushJobs } from "../src/pushJobs.js";

const job = (id, title = "Senior Java Engineer") => ({
  id,
  status: "ok",
  title,
  company: { name: "Acme" },
  locations: ["Hanoi"],
  levels: [],
  skills: [],
  description: "- Build things",
});

const fakeClient = (respond = (payload) => ({ id: `at-${payload.external_id}` })) => {
  const calls = [];
  return {
    calls,
    createJob: async (payload) => {
      calls.push(payload);
      return respond(payload);
    },
  };
};

const options = { accountRef: "aniday-account-1", delayMs: 0, sleep: async () => {} };

test("pushes classified jobs as ANIDAY entries and reports each result", async () => {
  const client = fakeClient();
  const seen = [];

  const results = await pushJobs(client, [job(1)], { ...options, onResult: (result) => seen.push(result) });

  assert.equal(client.calls[0].source, "ANIDAY");
  assert.equal(client.calls[0].external_id, "1");
  assert.equal(client.calls[0].source_account_ref, "aniday-account-1");
  assert.equal(results[0].outcome, "pushed");
  assert.equal(results[0].areTalentsId, "at-1");
  assert.deepEqual(seen, results);
});

test("never sends a job already in the ledger", async () => {
  const client = fakeClient();

  const [result] = await pushJobs(client, [job(1)], { ...options, pushed: { 1: "at-old" } });

  assert.equal(client.calls.length, 0);
  assert.equal(result.outcome, "already-pushed");
  assert.equal(result.areTalentsId, "at-old");
});

test("skips restricted jobs and jobs with no matching role family", async () => {
  const client = fakeClient();
  const restricted = { id: 2, status: "restricted", title: "Senior Java Engineer" };

  const results = await pushJobs(client, [restricted, job(3, "RF Engineer")], options);

  assert.equal(client.calls.length, 0);
  assert.deepEqual(results.map((result) => result.outcome), ["restricted", "unclassified"]);
});

test("an explicit assignment overrides the classifier", async () => {
  const client = fakeClient();

  await pushJobs(client, [job(3, "RF Engineer")], { ...options, assignments: { 3: "DEVELOPER" } });

  assert.equal(client.calls[0].role_family, "DEVELOPER");
});

test("a dry run sends nothing", async () => {
  const client = fakeClient();

  const [result] = await pushJobs(client, [job(1)], { ...options, dryRun: true });

  assert.equal(client.calls.length, 0);
  assert.equal(result.outcome, "would-push");
  assert.equal(result.roleFamily, "DEVELOPER");
});

test("treats JOB_SOURCE_EXISTS as already on AreTalents", async () => {
  const client = fakeClient(() => {
    throw new AreTalentsError("exists", 409, "JOB_SOURCE_EXISTS");
  });

  const [result] = await pushJobs(client, [job(1)], options);

  assert.equal(result.outcome, "exists");
});

test("one failed job does not stop the batch", async () => {
  const client = fakeClient((payload) => {
    if (payload.external_id === "1") throw new AreTalentsError("boom", 500, "INTERNAL");
    return { id: "at-2" };
  });

  const results = await pushJobs(client, [job(1), job(2)], options);

  assert.deepEqual(results.map((result) => result.outcome), ["failed", "pushed"]);
  assert.match(results[0].error, /boom/);
});

for (const status of [401, 403, 429]) {
  test(`HTTP ${status} stops the batch instead of repeating it for every job`, async () => {
    const client = fakeClient(() => {
      throw new AreTalentsError("stop", status, "ANY");
    });

    const results = await pushJobs(client, [job(1), job(2)], options);

    assert.equal(client.calls.length, 1);
    assert.deepEqual(results.map((result) => result.outcome), ["failed", "not-attempted"]);
  });
}

test("waits between sends but not before the first", async () => {
  const waits = [];

  await pushJobs(fakeClient(), [job(1), job(2)], { ...options, delayMs: 50, sleep: async (ms) => waits.push(ms) });

  assert.deepEqual(waits, [50]);
});

const publishingClient = (respond) => {
  const client = fakeClient();
  const publishCalls = [];
  const versionCalls = [];
  return {
    ...client,
    publishCalls,
    versionCalls,
    getJob: async () => ({ current_version: 3, raw_jd_markdown: "old" }),
    addJobVersion: async (id, body) => {
      versionCalls.push({ id, body, publishedSoFar: publishCalls.length });
    },
    publishJob: async (id, body) => {
      publishCalls.push({ id, body });
      if (respond) return respond(id, body);
      return { public_id: `pub-${id}`, url: `https://example.test/viec-lam/${id}` };
    },
  };
};

const publishing = { ...options, shouldPublish: true };

test("does not publish unless asked", async () => {
  const client = publishingClient();

  const [result] = await pushJobs(client, [job(1)], options);

  assert.equal(client.publishCalls.length, 0);
  assert.equal(result.outcome, "pushed");
});

test("creates then publishes a new job", async () => {
  const client = publishingClient();

  const [result] = await pushJobs(client, [job(1)], publishing);

  assert.equal(client.calls.length, 1);
  assert.equal(client.publishCalls[0].id, "at-1");
  assert.equal(client.publishCalls[0].body.work_mode, "Onsite");
  assert.equal(result.outcome, "published");
  assert.equal(result.areTalentsId, "at-1");
  assert.equal(result.publicId, "pub-at-1");
  assert.equal(result.publicUrl, "https://example.test/viec-lam/at-1");
});

test("publishes an existing draft without creating it again", async () => {
  const client = publishingClient();

  const [result] = await pushJobs(client, [job(1)], { ...publishing, pushed: { 1: "at-old" } });

  assert.equal(client.calls.length, 0);
  assert.equal(client.publishCalls[0].id, "at-old");
  assert.equal(result.outcome, "published");
});

test("publishes a pushed draft even if its title no longer classifies", async () => {
  const client = publishingClient();

  const [result] = await pushJobs(client, [job(1, "RF Engineer")], { ...publishing, pushed: { 1: "at-old" } });

  assert.equal(result.outcome, "published");
});

test("never republishes a job in the published ledger", async () => {
  const client = publishingClient();
  const published = { 1: { publicId: "pub-1", url: "https://example.test/x" } };

  const [result] = await pushJobs(client, [job(1)], { ...publishing, pushed: { 1: "at-old" }, published });

  assert.equal(client.publishCalls.length, 0);
  assert.equal(result.outcome, "already-published");
  assert.equal(result.publicUrl, "https://example.test/x");
});

test("a work mode set by hand overrides the inferred one", async () => {
  const client = publishingClient();

  await pushJobs(client, [job(1)], { ...publishing, workModes: { 1: "Remote" } });

  assert.equal(client.publishCalls[0].body.work_mode, "Remote");
});

test("a publish dry run sends nothing and shows the work mode", async () => {
  const client = publishingClient();

  const [result] = await pushJobs(client, [job(1)], { ...publishing, dryRun: true });

  assert.equal(client.calls.length + client.publishCalls.length, 0);
  assert.equal(result.outcome, "would-publish");
  assert.equal(result.workMode, "Onsite");
});

test("keeps the AreTalents id when the publish step fails, so a rerun can finish it", async () => {
  const client = publishingClient(() => {
    throw new AreTalentsError("bad location", 400, "BAD_REQUEST");
  });

  const [result] = await pushJobs(client, [job(1)], publishing);

  assert.equal(result.outcome, "failed");
  assert.equal(result.areTalentsId, "at-1");
  assert.match(result.error, /bad location/);
});

test("a job that cannot be mapped fails alone without stopping the batch", async () => {
  const client = publishingClient();

  const results = await pushJobs(client, [{ ...job(1), locations: [] }, job(2)], publishing);

  assert.deepEqual(results.map((result) => result.outcome), ["failed", "published"]);
});

test("HTTP 429 from the publish step stops the batch", async () => {
  const client = publishingClient(() => {
    throw new AreTalentsError("slow down", 429, "RATE_LIMITED");
  });

  const results = await pushJobs(client, [job(1), job(2)], publishing);

  assert.deepEqual(results.map((result) => result.outcome), ["failed", "not-attempted"]);
});

test("waits before every request, so create plus publish stays under the rate limit", async () => {
  const waits = [];

  await pushJobs(publishingClient(), [job(1), job(2)], { ...publishing, delayMs: 50, sleep: async (ms) => waits.push(ms) });

  assert.deepEqual(waits, [50, 50, 50, 50, 50, 50, 50]);
});

test("replaces the JD with the public version before the job goes live", async () => {
  const client = publishingClient();

  await pushJobs(client, [job(1)], publishing);

  assert.equal(client.versionCalls[0].id, "at-1");
  assert.equal(client.versionCalls[0].body.expected_version, 3);
  assert.equal(client.versionCalls[0].body.raw_jd_markdown, "- Build things");
  assert.equal(client.versionCalls[0].publishedSoFar, 0);
});

test("adds no new version when the public JD is already in place", async () => {
  const client = { ...publishingClient(), getJob: async () => ({ current_version: 3, raw_jd_markdown: "- Build things" }) };

  const [result] = await pushJobs(client, [job(1)], publishing);

  assert.equal(client.versionCalls.length, 0);
  assert.equal(result.outcome, "published");
});

test("does not publish when the JD update fails", async () => {
  const client = {
    ...publishingClient(),
    addJobVersion: async () => {
      throw new AreTalentsError("version conflict", 409, "CONFLICT");
    },
  };

  const [result] = await pushJobs(client, [job(1)], publishing);

  assert.equal(client.publishCalls.length, 0);
  assert.equal(result.outcome, "failed");
  assert.equal(result.areTalentsId, "at-1");
});

test("a 403 from the publish call is about that job, so the batch carries on", async () => {
  const client = publishingClient((id) => {
    if (id === "at-1") throw new AreTalentsError("revoked by an admin", 403, "FORBIDDEN");
    return { public_id: "pub-2", url: "https://example.test/2" };
  });

  const results = await pushJobs(client, [job(1), job(2)], publishing);

  assert.deepEqual(results.map((result) => result.outcome), ["failed", "published"]);
});

test("a 403 before the publish call is about the key, so the batch stops", async () => {
  const client = {
    ...publishingClient(),
    getJob: async () => {
      throw new AreTalentsError("missing scope", 403, "FORBIDDEN");
    },
  };

  const results = await pushJobs(client, [job(1), job(2)], { ...publishing, pushed: { 1: "at-1", 2: "at-2" } });

  assert.deepEqual(results.map((result) => result.outcome), ["failed", "not-attempted"]);
});

test("reports a new draft as soon as it exists, before the publish steps", async () => {
  const events = [];
  const client = {
    ...publishingClient(),
    getJob: async () => {
      events.push("getJob");
      return { current_version: 1, raw_jd_markdown: "old" };
    },
  };

  await pushJobs(client, [job(1)], { ...publishing, onCreated: (result) => events.push(result.areTalentsId) });

  assert.deepEqual(events, ["at-1", "getJob"]);
});

test("does not report a draft that was never created", async () => {
  const created = [];
  const client = fakeClient(() => {
    throw new AreTalentsError("boom", 500, "INTERNAL");
  });

  await pushJobs(client, [job(1)], { ...options, onCreated: (result) => created.push(result) });

  assert.equal(created.length, 0);
});

test("creates no draft for a job that cannot be published", async () => {
  const client = publishingClient();

  const [result] = await pushJobs(client, [{ ...job(1), locations: [] }], publishing);

  assert.equal(client.calls.length, 0);
  assert.equal(result.outcome, "failed");
  assert.match(result.error, /no location/);
});

test("a dry run reports a job that cannot be published", async () => {
  const client = publishingClient();

  const [result] = await pushJobs(client, [{ ...job(1), locations: [] }], { ...publishing, dryRun: true });

  assert.equal(result.outcome, "failed");
  assert.match(result.error, /no location/);
});
