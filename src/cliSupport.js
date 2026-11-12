import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ENV_PATH = fileURLToPath(new URL("../.env", import.meta.url));

export const print = (text) => process.stdout.write(`${text}\n`);

export const loadEnv = () => {
  if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);
};

/**
 * Windows PowerShell removes the `--` from `npm run x -- --flag`, so npm keeps the flag and
 * the bot never sees it. A lost --dry-run would turn a preview into a real run, so this must
 * run before anything else. npm exposes each flag it kept as an npm_config_* variable.
 * @param {string[]} flags option names without the leading dashes
 * @param {string} script path to tell the user to run instead
 * @param {Record<string, string | undefined>} env
 */
export const assertFlagsArrived = (flags, script, env = process.env) => {
  const lost = flags.filter((flag) => env[`npm_config_${flag.replaceAll("-", "_")}`] !== undefined);
  if (!lost.length) return;
  const named = lost.map((flag) => `--${flag}`).join(", ");
  const example = lost.map((flag) => `--${flag}`).join(" ");
  throw new Error(
    `Stopped: npm kept ${named} instead of passing it on, so nothing was run. `
    + `PowerShell does this to "npm run ... -- --flag". Use this instead: node ${script} ${example}`,
  );
};

export const intAtLeast = (value, name, min) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min) throw new Error(`--${name} must be an integer of at least ${min}`);
  return number;
};

/** Writes through a temp file so an interrupted run never leaves half a file. */
export const writeJsonFile = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tempPath, path);
};

export const runMain = (main) => main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
