import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyRoleFamily } from "../src/roleFamily.js";

const cases = [
  ["QA Automation Engineer", "TESTER"],
  ["Senior Automation Test Engineer", "TESTER"],
  ["Senior Java Fullstack Engineer", "DEVELOPER"],
  ["Lead Java Backend Developer", "DEVELOPER"],
  ["Project Technical Lead", "DEVELOPER"],
  ["AI Solution Architect", "DEVELOPER"],
  ["SAP ABAP Consultant (US hrs)", "DEVELOPER"],
  ["Data Engineer", "DEVELOPER"],
  ["Cloud Project Manager", "IT_MIDDLE_MANAGER"],
  ["Engineering Manager - Digital Banking", "IT_MIDDLE_MANAGER"],
  ["IT Manager", "IT_MIDDLE_MANAGER"],
  ["Product Owner", "IT_MIDDLE_MANAGER"],
  ["Senior Business Analyst (PO)", "IT_MIDDLE_MANAGER"],
  ["TRƯỞNG PHÒNG CÔNG NGHỆ & QUẢN LÝ DỰ ÁN CHUYỂN ĐỔI SỐ", "IT_MIDDLE_MANAGER"],
];

for (const [title, expected] of cases) {
  test(`classifies "${title}" as ${expected}`, () => {
    assert.equal(classifyRoleFamily({ title }), expected);
  });
}

for (const title of [
  "Middle Electrical Engineer",
  "Hull Structural Basic Design Engineer",
  "RF Engineer",
  "4G/5G RAN Engineer",
  "DWDM Engineer",
  "IP Engineer",
  "Site Quality and Solutions Engineer",
  "Client Success Manager",
  "Full Cycle Account Executive (USA)",
  "Product Specialist",
]) {
  test(`leaves "${title}" unclassified`, () => {
    assert.equal(classifyRoleFamily({ title }), null);
  });
}
