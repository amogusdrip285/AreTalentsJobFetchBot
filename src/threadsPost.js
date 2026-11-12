import { inferWorkMode } from "./publication.js";

// Threads rejects posts over 500 characters, links included.
export const MAX_POST_LENGTH = 500;
const MAX_SKILLS = 4;
const MAX_PERKS = 3;
const TOPIC_TAG = "#TuyenDungIT";
// Too broad to tell a reader anything about the job.
const GENERIC_SKILLS = new Set(["software development", "software engineering", "management", "consultant", "it"]);

const usefulSkills = (job) => (job.skills ?? []).filter((skill) => !GENERIC_SKILLS.has(skill.trim().toLowerCase()));

// Checked in order, so the most persuasive perks come first. Only short, concrete perks
// are worth a line in a post: the job page lists the rest.
const PERK_RULES = [
  [/full (salary|lương).{0,20}probation|100% (salary|lương).{0,20}(probation|thử việc)/i, "Full lương thử việc"],
  [/13(th)?[- ]?month|lương tháng 13|tháng lương 13/i, "Lương tháng 13"],
  [/macbook|laptop/i, "Cấp laptop/MacBook"],
  [/performance bonus|kpi bonus|thưởng hiệu suất|annual bonus|thưởng (cuối năm|kpi)/i, "Thưởng hiệu suất"],
  [/(premium|private|pti|bảo việt|aon).{0,30}(health|insurance)|bảo hiểm (sức khỏe|cao cấp)/i, "Bảo hiểm sức khỏe cao cấp"],
  [/hybrid[ -](work|working|schedule)|work from home|wfh/i, "Hybrid / WFH"],
  [/(\d{2})\s*(days?|ngày)[^.\n]{0,15}(annual leave|paid leave|phép)/i, (match) => `${match[1]} ngày phép/năm`],
  [/training|course|certificat|đào tạo/i, "Đào tạo & chứng chỉ"],
  [/(company|annual) trip|du lịch|team ?building/i, "Du lịch & teambuilding"],
  [/monday to friday|mon[- ]fri|thứ 2 (đến|-) thứ 6/i, "Làm T2–T6"],
  [/lunch|ăn trưa/i, "Hỗ trợ ăn trưa"],
];

const WORK_MODE_LABELS = { Remote: "Remote 100%", Hybrid: "Hybrid", Onsite: "Onsite" };

/** Rotated by job id so a run of posts doesn't read like one copied template. */
const HOOKS = [
  ({ company, title }) => `🚀 ${company} đang tuyển ${title}!`,
  ({ company, title, skill }) => `🔥 Job xịn cho dân ${skill}: ${title} tại ${company}`,
  ({ company, title }) => `👀 Đang tìm bến mới? ${company} đang cần ${title}`,
  ({ company, title }) => `💼 Cơ hội mới: ${title} — ${company}`,
  ({ company, title }) => `✨ ${title} @ ${company} — mở đơn rồi nè!`,
];

const isAllCaps = (text) => /\p{Lu}/u.test(text) && text === text.toLocaleUpperCase("vi");

/** AniDay has a few titles in capitals, which read as shouting in a feed. */
export const displayTitle = (title) => {
  const trimmed = title.trim().replace(/\s+/g, " ");
  if (!isAllCaps(trimmed)) return trimmed;
  return trimmed
    .toLocaleLowerCase("vi")
    .replace(/(^|[\s(&/-])(\p{L})/gu, (_, before, letter) => `${before}${letter.toLocaleUpperCase("vi")}`);
};

/** "Senior (5-10 YOE)" becomes "Senior (5–10 năm)". */
export const displayLevel = (level) => level
  .replace(/\((\d+)\s*-\s*(\d+)\s*YOE\)/i, "($1–$2 năm)")
  .replace(/\((\d+)\+\s*YOE\)/i, "($1+ năm)");


/**
 * @param {Record<string, any>} job record from data/jobs.json
 * @returns {string[]} short Vietnamese perk labels, best first
 */
export function pickPerks(job) {
  const text = [job.benefits, job.description].filter(Boolean).join("\n");
  return PERK_RULES.flatMap(([pattern, label]) => {
    const match = text.match(pattern);
    if (!match) return [];
    return [typeof label === "function" ? label(match) : label];
  }).slice(0, MAX_PERKS);
}

const locationLine = (job, workMode) => {
  const places = job.locations.filter((place) => place.toLowerCase() !== "remote");
  const where = places.length ? places.join(", ") : "Việt Nam";
  return `📍 ${where} · ${WORK_MODE_LABELS[workMode]}`;
};

const buildLines = (job, url, { skillCount, perkCount }) => {
  const workMode = inferWorkMode(job);
  const title = displayTitle(job.title);
  const company = job.company?.name?.trim() || "Công ty đối tác";
  const skills = usefulSkills(job).slice(0, skillCount);
  const perks = pickPerks(job).slice(0, perkCount);
  const levels = (job.levels ?? []).map(displayLevel);
  const hook = HOOKS[job.id % HOOKS.length]({
    company,
    title,
    skill: skills[0] ?? "IT",
  }).replace(/\s{2,}/g, " ");
  return [
    hook,
    "",
    locationLine(job, workMode),
    ...(levels.length ? [`🎯 ${levels.join(" / ")}`] : []),
    ...(skills.length ? [`🛠 ${skills.join(" · ")}`] : []),
    ...(perks.length ? [`🎁 ${perks.join(" · ")}`] : []),
    "💰 Lương: Thỏa thuận, cạnh tranh",
    "",
    `👉 Ứng tuyển ngay: ${url}`,
    TOPIC_TAG,
  ];
};

/**
 * One Threads post for one job. It never includes the referral bonus or anything else
 * AniDay shows only to headhunters. Skills and perks are dropped until it fits.
 * @param {Record<string, any>} job record from data/jobs.json
 * @param {string} url the job's public AreTalents page
 * @returns {string}
 */
export function buildPostText(job, url) {
  for (let skillCount = MAX_SKILLS, perkCount = MAX_PERKS; skillCount >= 0;) {
    const text = buildLines(job, url, { skillCount, perkCount }).join("\n");
    if ([...text].length <= MAX_POST_LENGTH) return text;
    if (perkCount > 1) perkCount -= 1;
    else skillCount -= 1;
  }
  throw new Error(`Job ${job.id}: the post is over ${MAX_POST_LENGTH} characters even without skills and perks`);
}

/**
 * What the image card shows. Kept apart from rendering so it can be tested.
 * @param {Record<string, any>} job record from data/jobs.json
 */
export function buildCardSpec(job) {
  return {
    id: job.id,
    title: displayTitle(job.title),
    company: job.company?.name?.trim() || "Công ty đối tác",
    location: locationLine(job, inferWorkMode(job)).replace("📍 ", ""),
    level: (job.levels ?? []).map(displayLevel).join(" / "),
    skills: usefulSkills(job).slice(0, 6),
    perks: pickPerks(job),
    accent: accentFor(job.title),
  };
}

// A colour per kind of role, so a feed of these doesn't look like one repeated image.
const ACCENTS = [
  [/\b(ai|ml|llm|machine learning)\b/i, "#A78BFA"],
  [/\bsap\b/i, "#38BDF8"],
  [/\b(qa|qc|test)/i, "#2DD4BF"],
  [/manager|lead|head|owner|analyst|trưởng|leader/i, "#FB923C"],
  [/devops|devsecops|cloud|data/i, "#F472B6"],
];
const DEFAULT_ACCENT = "#C6F432";

export const accentFor = (title) => ACCENTS.find(([pattern]) => pattern.test(title))?.[1] ?? DEFAULT_ACCENT;
