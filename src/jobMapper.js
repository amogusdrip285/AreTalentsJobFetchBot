const SITE_URL = "https://app.aniday.com/vi";

const NAMED_ENTITIES = { nbsp: " ", lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };
const MAX_CODE_POINT = 0x10ffff;

const decodeCodePoint = (codePoint, entity) =>
  codePoint <= MAX_CODE_POINT ? String.fromCodePoint(codePoint) : entity;

/**
 * Decodes in a single pass so "&amp;lt;" becomes "&lt;", not "<".
 * @param {string} text
 * @returns {string}
 */
const decodeEntities = (text) =>
  text.replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi, (entity, decimal, hex, name) => {
    if (decimal) return decodeCodePoint(Number(decimal), entity);
    if (hex) return decodeCodePoint(Number.parseInt(hex, 16), entity);
    return NAMED_ENTITIES[name.toLowerCase()] ?? entity;
  });

/**
 * AniDay stores descriptions as either plain text or HTML.
 * @param {string | null | undefined} value
 * @returns {string}
 */
export function htmlToText(value) {
  if (!value) return "";
  const withBreaks = value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/(?:p|div|h[1-6]|ul|ol)>/gi, "\n\n");
  return decodeEntities(withBreaks.replace(/<[^>]+>/g, ""))
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * @param {string | null | undefined} value comma separated list
 * @returns {string[]}
 */
const splitList = (value) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);

const jobUrl = (job) => `${SITE_URL}/jobs/${job.id}`;

const toSummary = (job, fetchedAt) => ({
  id: job.id,
  code: job.code ?? null,
  title: job.name ?? null,
  url: jobUrl(job),
  locations: splitList(job.workLocations),
  fetchedAt,
});

const joinBenefits = (job) =>
  [job.whyWokingHere, job.benefit1, job.benefit2, job.benefit3].map(htmlToText).filter(Boolean).join("\n");

/**
 * Builds from an allow-list so contact details and private notes in the API
 * response never reach the output file.
 * @param {Record<string, any>} job response of /api/v3/job/detail/{id}
 * @param {string} fetchedAt ISO timestamp
 * @returns {Record<string, unknown>}
 */
export function toJobRecord(job, fetchedAt) {
  return {
    ...toSummary(job, fetchedAt),
    status: "ok",
    company: {
      name: job.shopName ?? null,
      website: job.shopWebsite || null,
      size: job.shopSize || null,
      about: htmlToText(job.shopAbout),
    },
    jobType: job.jobTypeName ?? null,
    employmentType: job.employmentTypeName ?? null,
    levels: splitList(job.levels),
    roles: splitList(job.roles),
    skills: splitList(job.skills),
    industries: splitList(job.industries),
    languages: splitList(job.languages),
    address: job.address || null,
    openings: job.numberRecruitment ?? null,
    salary: job.isShowSalary ? { from: job.salaryFrom, to: job.salaryTo } : null,
    referralBonusVnd: job.bonusAmount ?? null,
    description: htmlToText(job.jobDescription),
    requirements: htmlToText(job.jobRequirement),
    niceToHave: htmlToText(job.priority),
    benefits: joinBenefits(job),
    reportTo: job.reportTo || null,
    interviewProcess: htmlToText(job.interviewingProcess),
    jdFile: job.jdUpload || null,
    updatedAt: job.updatedDate ?? null,
  };
}

/**
 * For jobs this account may not open: only what the list already showed.
 * @param {Record<string, any>} job item of the job list
 * @param {string} fetchedAt ISO timestamp
 * @returns {Record<string, unknown>}
 */
export function toRestrictedRecord(job, fetchedAt) {
  return { ...toSummary(job, fetchedAt), status: "restricted" };
}
