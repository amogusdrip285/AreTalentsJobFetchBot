import assert from "node:assert/strict";
import { test } from "node:test";
import { htmlToText, toJobRecord, toRestrictedRecord } from "../src/jobMapper.js";

test("htmlToText keeps plain text unchanged", () => {
  assert.equal(htmlToText("- Own the infra\n- Keep it secure"), "- Own the infra\n- Keep it secure");
});

test("htmlToText turns paragraphs and list items into readable lines", () => {
  const html = "<p>Intro</p><ul><li>One</li><li>Two<br/>more</li></ul>";
  assert.equal(htmlToText(html), "Intro\n\n- One\n- Two\nmore");
});

test("htmlToText decodes entities without double decoding", () => {
  assert.equal(htmlToText("R&amp;D &lt;team&gt; &#39;x&#39; &amp;lt; caf&#xe9;&nbsp;!"), "R&D <team> 'x' &lt; café !");
});

test("htmlToText leaves out of range numeric entities as they are", () => {
  assert.equal(htmlToText("a &#99999999; b"), "a &#99999999; b");
});

test("htmlToText returns an empty string for missing values", () => {
  assert.equal(htmlToText(null), "");
  assert.equal(htmlToText(undefined), "");
});

test("toJobRecord maps the description fields", () => {
  const record = toJobRecord(
    {
      id: 7,
      code: "dev",
      name: "Dev",
      shopName: "Acme",
      jobDescription: "<p>Build</p>",
      jobRequirement: "Go",
      priority: "K8s",
      whyWokingHere: "13th month",
      benefit1: "Laptop",
      benefit2: "",
      interviewingProcess: "Test -> Interview",
      workLocations: "Ho Chi Minh",
      skills: "Go, AWS",
    },
    "2026-11-04T00:00:00.000Z",
  );

  assert.equal(record.status, "ok");
  assert.equal(record.title, "Dev");
  assert.equal(record.company.name, "Acme");
  assert.equal(record.description, "Build");
  assert.equal(record.requirements, "Go");
  assert.equal(record.niceToHave, "K8s");
  assert.equal(record.benefits, "13th month\nLaptop");
  assert.deepEqual(record.skills, ["Go", "AWS"]);
  assert.equal(record.url, "https://app.aniday.com/vi/jobs/7");
  assert.equal(record.fetchedAt, "2026-11-04T00:00:00.000Z");
});

test("toJobRecord drops recruiter contact details and private notes", () => {
  const record = toJobRecord(
    {
      id: 7,
      name: "Dev",
      contactEmail: "hr@acme.test",
      contactPhone: "0900000000",
      createdByEmail: "cs@aniday.test",
      amEmail: "am@aniday.test",
      notePrivate: "internal only",
      mailTest: "secret test",
    },
    "2026-11-04T00:00:00.000Z",
  );

  const serialized = JSON.stringify(record);
  for (const value of ["hr@acme.test", "0900000000", "cs@aniday.test", "am@aniday.test", "internal only", "secret test"]) {
    assert.equal(serialized.includes(value), false, value);
  }
});

test("toRestrictedRecord keeps only list level data and no description", () => {
  const record = toRestrictedRecord({ id: 9, code: "sa", name: "Solutions Architect", workLocations: "Hanoi" }, "t");

  assert.equal(record.status, "restricted");
  assert.equal(record.title, "Solutions Architect");
  assert.deepEqual(record.locations, ["Hanoi"]);
  assert.equal("description" in record, false);
});
