import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accentFor, buildCardSpec, buildPostText, displayLevel, displayTitle, MAX_POST_LENGTH, pickPerks,
} from "../src/threadsPost.js";

const URL = "https://www.aretalents.com/viec-lam/senior-java-engineer-j123";

const job = (overrides = {}) => ({
  id: 10,
  title: "Senior Java Engineer",
  company: { name: "Acme" },
  locations: ["Ho Chi Minh"],
  levels: ["Senior (5-10 YOE)"],
  skills: ["Java", "Software Development", "AWS", "Kafka", "Docker", "Redis"],
  description: "- Build things",
  requirements: "- 5 years of Java",
  benefits: "- 13th-month salary\n- Premium health insurance\n- 15 days of annual leave",
  referralBonusVnd: 25000000,
  ...overrides,
});

test("the post leads with the company and title and ends with the job link", () => {
  const text = buildPostText(job(), URL);
  assert.match(text.split("\n")[0], /Acme/);
  assert.match(text.split("\n")[0], /Senior Java Engineer/);
  assert.match(text, new RegExp(`Ứng tuyển ngay: ${URL}\\n#TuyenDungIT$`));
});

test("the post never mentions the headhunter referral bonus", () => {
  const text = buildPostText(job(), URL);
  assert.doesNotMatch(text, /25[.,]?000[.,]?000|referral|thưởng giới thiệu/i);
});

test("the post lists useful skills only, at most four", () => {
  const text = buildPostText(job(), URL);
  assert.match(text, /🛠 Java · AWS · Kafka · Docker\n/);
  assert.doesNotMatch(text, /Software Development/);
});

test("the post shows the level in Vietnamese and the location with work mode", () => {
  const text = buildPostText(job({ locations: ["Ha Noi", "Remote"] }), URL);
  assert.match(text, /🎯 Senior \(5–10 năm\)/);
  assert.match(text, /📍 Ha Noi · Remote 100%/);
});

test("the post leaves out the level line when there is none", () => {
  assert.doesNotMatch(buildPostText(job({ levels: [] }), URL), /🎯/);
});

test("different job ids get different opening lines", () => {
  const openers = new Set([10, 11, 12, 13, 14].map((id) => buildPostText(job({ id }), URL).split("\n")[0]));
  assert.equal(openers.size, 5);
});

test("a long post drops perks and skills until it fits", () => {
  const long = job({ title: "A".repeat(150), company: { name: "B".repeat(120) } });
  const text = buildPostText(long, URL);
  assert.ok([...text].length <= MAX_POST_LENGTH);
  assert.match(text, new RegExp(URL));
});

test("a post that can't fit at all is refused", () => {
  assert.throws(() => buildPostText(job({ title: "A".repeat(500) }), URL), /over 500 characters/);
});

test("picks the strongest perks first, three at most", () => {
  const perks = pickPerks(job({ benefits: "Lunch. Full salary during probation. 13th month. MacBook Pro. Training." }));
  assert.deepEqual(perks, ["Full lương thử việc", "Lương tháng 13", "Cấp laptop/MacBook"]);
});

test("reads the number of leave days", () => {
  assert.deepEqual(pickPerks(job({ benefits: "- 18 days of annual leave" })), ["18 ngày phép/năm"]);
});

test("finds no perks in an empty job", () => {
  assert.deepEqual(pickPerks(job({ benefits: null, description: "" })), []);
});

test("title-cases titles written in capitals", () => {
  assert.equal(displayTitle("TRƯỞNG PHÒNG CÔNG NGHỆ & QUẢN LÝ DỰ ÁN"), "Trưởng Phòng Công Nghệ & Quản Lý Dự Án");
});

test("leaves mixed-case titles alone", () => {
  assert.equal(displayTitle("  Senior  .NET Developer "), "Senior .NET Developer");
  assert.equal(displayTitle("SAP BW Expert"), "SAP BW Expert");
});

test("formats levels with years of experience", () => {
  assert.equal(displayLevel("Middle (3-5 YOE)"), "Middle (3–5 năm)");
  assert.equal(displayLevel("Expert (10+ YOE)"), "Expert (10+ năm)");
  assert.equal(displayLevel("Lead"), "Lead");
});

test("picks an accent colour by kind of role", () => {
  assert.equal(accentFor("Senior AI Engineer"), "#A78BFA");
  assert.equal(accentFor("SAP BW Expert"), "#38BDF8");
  assert.equal(accentFor("QA Engineer"), "#2DD4BF");
  assert.equal(accentFor("Project Manager"), "#FB923C");
  assert.equal(accentFor("Java Developer"), "#C6F432");
});

test("the card spec carries what the image shows", () => {
  const spec = buildCardSpec(job());
  assert.deepEqual(spec, {
    id: 10,
    title: "Senior Java Engineer",
    company: "Acme",
    location: "Ho Chi Minh · Onsite",
    level: "Senior (5–10 năm)",
    skills: ["Java", "AWS", "Kafka", "Docker", "Redis"],
    perks: ["Lương tháng 13", "Bảo hiểm sức khỏe cao cấp", "15 ngày phép/năm"],
    accent: "#C6F432",
  });
});

test("a job without a company name gets a neutral one", () => {
  assert.equal(buildCardSpec(job({ company: null })).company, "Công ty đối tác");
});
