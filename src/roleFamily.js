// AreTalents only has three role families, so anything outside software is left
// unclassified rather than mislabelled: jobs cannot be deleted once pushed.
const NOT_SOFTWARE = /marine|hull|electrical|\brf\b|\bran\b|dwdm|\bip engineer|site quality|account executive|client success|presales/i;
const IT_MANAGER = /\b(project|product|program|engineering|it)\s+manager\b|product owner|business analyst|head of|\bleader\b|trưởng phòng/i;
const TESTER = /\b(qa|qc|tester|test)\b/i;
const DEVELOPER = /engineer|developer|scientist|architect|devops|consultant|\bsap\b|\blead\b/i;

/**
 * @param {{ title: string }} job
 * @returns {"DEVELOPER" | "TESTER" | "IT_MIDDLE_MANAGER" | null} null when no family fits
 */
export function classifyRoleFamily({ title }) {
  if (NOT_SOFTWARE.test(title)) return null;
  if (IT_MANAGER.test(title)) return "IT_MIDDLE_MANAGER";
  if (TESTER.test(title)) return "TESTER";
  if (DEVELOPER.test(title)) return "DEVELOPER";
  return null;
}
