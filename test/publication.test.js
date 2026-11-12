import assert from "node:assert/strict";
import { test } from "node:test";
import { inferCategory, inferWorkMode, toPublicMarkdown, toPublication } from "../src/publication.js";

const job = (overrides = {}) => ({
  id: 7,
  title: "Senior Java Engineer",
  company: { name: "Acme" },
  locations: ["Ho Chi Minh", "Ha Noi"],
  skills: ["Java", "AWS"],
  description: "- Build things",
  requirements: "- 5 years of Java",
  niceToHave: "- Kafka",
  benefits: "- 13th month pay",
  referralBonusVnd: 25000000,
  salary: null,
  ...overrides,
});

test("infers Remote from the AniDay location", () => {
  assert.equal(inferWorkMode(job({ locations: ["Remote"] })), "Remote");
});

test("infers Hybrid from the JD text", () => {
  assert.equal(inferWorkMode(job({ benefits: "- Hybrid working, 2 days in office" })), "Hybrid");
});

test("does not read the word hybrid inside the company blurb", () => {
  assert.equal(inferWorkMode(job({ company: { name: "Acme", about: "Hybrid cloud leader" } })), "Onsite");
});

test("defaults to Onsite when the JD says nothing", () => {
  assert.equal(inferWorkMode(job()), "Onsite");
});

test("maps a job to the publish body", () => {
  assert.deepEqual(toPublication(job(), "Hybrid"), {
    company: "Acme",
    location: "Ho Chi Minh, Ha Noi",
    work_mode: "Hybrid",
    tags: ["Java", "AWS"],
    requirements: "- 5 years of Java",
    preferred: "- Kafka",
    benefits: "- 13th month pay",
  });
});

test("never sends the referral bonus or an invented salary", () => {
  const body = toPublication(job(), "Onsite");

  assert.equal("salary_min" in body, false);
  assert.equal("salary_max" in body, false);
  assert.equal(JSON.stringify(body).includes("25000000"), false);
});

test("leaves out empty optional sections", () => {
  const body = toPublication(job({ niceToHave: null, benefits: "" }), "Onsite");

  assert.equal("preferred" in body, false);
  assert.equal("benefits" in body, false);
});

test("keeps tags within the AreTalents limits", () => {
  const skills = [...Array.from({ length: 25 }, (_, index) => `skill-${index}`), "x".repeat(51)];

  const { tags } = toPublication(job({ skills }), "Onsite");

  assert.equal(tags.length, 20);
  assert.equal(tags.every((tag) => tag.length <= 50), true);
});

test("rejects a job with no location", () => {
  assert.throws(() => toPublication(job({ locations: [] }), "Onsite"), /no location/);
});

test("rejects an unknown work mode", () => {
  assert.throws(() => toPublication(job(), "Office"), /Unknown work mode/);
});

test("the public markdown skips what the page already shows and has no headings", () => {
  const markdown = toPublicMarkdown(job({ levels: ["Senior"], interviewProcess: "HR call -> Tech interview" }));

  assert.equal(markdown, "**Level:** Senior\n\n- Build things\n\n**Interview process**\n\nHR call -> Tech interview");
});

test("the public markdown leaves out a missing level and interview process", () => {
  assert.equal(toPublicMarkdown(job({ levels: [], interviewProcess: null })), "- Build things");
});

test("the public markdown rejects a job without a description", () => {
  assert.throws(() => toPublicMarkdown(job({ description: "" })), /no description/);
});

test("turns markers the public page cannot render into ones it can", () => {
  const body = toPublication(job({ requirements: "### Skills:\n\t• Java\n● Go\n* Rust\n- Kept\n**Kept too**" }), "Onsite");

  assert.equal(body.requirements, "**Skills:**\n- Java\n- Go\n- Rust\n- Kept\n**Kept too**");
});

for (const [title, category] of [
  ["DevSecOps Engineer", "devops"],
  ["Senior Cloud Engineer", "devops"],
  ["Site Reliability Engineer", "devops"],
  ["Data Engineer", "data"],
  ["Frontend Developer", "frontend"],
  ["Front-end Engineer", "frontend"],
  ["iOS Developer", "mobile"],
  ["Flutter Engineer", "mobile"],
]) {
  test(`files ${title} under ${category}`, () => {
    assert.equal(inferCategory(job({ title })), category);
  });
}

test("leaves the category to AreTalents when the title gives no clear signal", () => {
  assert.equal(inferCategory(job({ title: "Senior Full-Stack Engineer" })), undefined);
  assert.equal("category_slug" in toPublication(job(), "Onsite"), false);
});

test("sends the inferred category", () => {
  assert.equal(toPublication(job({ title: "DevOps Engineer" }), "Onsite").category_slug, "devops");
});

test("keeps a manager with a technical word in the title out of the technical categories", () => {
  assert.equal(inferCategory(job({ title: "Cloud Project Manager" })), undefined);
});

test("infers Hybrid from the wording AniDay clients use", () => {
  assert.equal(inferWorkMode(job({ benefits: "- Flexible hybrid working model (2 days work from everywhere)" })), "Hybrid");
});

for (const text of [
  "Familiarity with hybrid and multi-cloud environments",
  "hybrid retrieval, reranking and data-grounding",
  "Edge Integration Cell for hybrid integration scenarios",
  "An operational Hybrid Machine Learning and LLM model",
]) {
  test(`does not treat "${text}" as a work arrangement`, () => {
    assert.equal(inferWorkMode(job({ requirements: text })), "Onsite");
  });
}

test("files a title with a spaced Front End under frontend", () => {
  assert.equal(inferCategory(job({ title: "Front End Developer" })), "frontend");
});
