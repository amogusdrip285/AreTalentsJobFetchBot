import { classifyRoleFamily } from "./roleFamily.js";

export const WORK_MODES = ["Remote", "Hybrid", "Onsite"];
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 50;
const REMOTE_LOCATION = "remote";
// "Hybrid" alone is no use: JDs also say hybrid cloud, hybrid retrieval and hybrid models.
const HYBRID_PATTERN = /\bhybrid[ -](work|working|schedule|arrangement)/i;
// Checked in order. Only developers need this: AreTalents derives a category from
// role_family, which files every developer under backend.
const CATEGORY_RULES = [
  ["mobile", /\b(mobile|ios|android|flutter|react native)\b/i],
  ["devops", /\b(devops|devsecops|sre|site reliability|cloud|infrastructure)\b/i],
  ["data", /\bdata\b/i],
  ["frontend", /\bfront[- ]?end\b/i],
];

/**
 * AniDay has no work mode field, so this reads the job's own text. The company blurb
 * is left out because it describes the business, not the job. Words like "remote" in
 * the text are too often about distributed teams to trust, so only the location counts.
 * @param {Record<string, any>} job record from data/jobs.json
 * @returns {"Remote" | "Hybrid" | "Onsite"}
 */
export function inferWorkMode(job) {
  if (job.locations.some((location) => location.toLowerCase() === REMOTE_LOCATION)) return "Remote";
  const text = [job.description, job.requirements, job.niceToHave, job.benefits].join(" ");
  return HYBRID_PATTERN.test(text) ? "Hybrid" : "Onsite";
}

/**
 * @param {Record<string, any>} job record from data/jobs.json
 * @returns {string | undefined} a category slug, or undefined to use the AreTalents default
 */
export function inferCategory(job) {
  if (classifyRoleFamily(job) !== "DEVELOPER") return undefined;
  return CATEGORY_RULES.find(([, pattern]) => pattern.test(job.title))?.[0];
}

const optional = (field, value) => (value ? { [field]: value } : {});

// The public page renders **bold** and "- " lists, but shows # headings as literal text.
const tidy = (text) => text
  .replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*$/gm, "**$1**")
  .replace(/^[ \t]*[•●▪*][ \t]+/gm, "- ");

/**
 * The JD for the public page. Title, company, location and skills are shown by the page
 * itself, and requirements, nice-to-haves and benefits have their own sections.
 * @param {Record<string, any>} job record from data/jobs.json
 * @returns {string}
 */
export function toPublicMarkdown(job) {
  if (!job.description) throw new Error(`Job ${job.id} has no description to publish`);
  return [
    ...(job.levels?.length ? [`**Level:** ${job.levels.join(", ")}`] : []),
    tidy(job.description),
    ...(job.interviewProcess ? [`**Interview process**\n\n${tidy(job.interviewProcess)}`] : []),
  ].join("\n\n");
}

/**
 * Salary is left out because AniDay gives none, and the referral bonus because it is
 * headhunter commission. The deadline falls back to the AreTalents default of 30 days.
 * @param {Record<string, any>} job record from data/jobs.json
 * @param {string} workMode one of WORK_MODES
 * @returns {Record<string, unknown>} body for POST /api/v1/jobs/{id}/publish
 */
export function toPublication(job, workMode) {
  if (!WORK_MODES.includes(workMode)) {
    throw new Error(`Unknown work mode ${workMode}; use one of ${WORK_MODES.join(", ")}`);
  }
  if (!job.locations.length) throw new Error(`Job ${job.id} has no location to publish`);
  return {
    company: job.company.name,
    location: job.locations.join(", "),
    work_mode: workMode,
    ...optional("category_slug", inferCategory(job)),
    tags: job.skills.filter((skill) => skill.length <= MAX_TAG_LENGTH).slice(0, MAX_TAGS),
    ...optional("requirements", job.requirements && tidy(job.requirements)),
    ...optional("preferred", job.niceToHave && tidy(job.niceToHave)),
    ...optional("benefits", job.benefits && tidy(job.benefits)),
  };
}
