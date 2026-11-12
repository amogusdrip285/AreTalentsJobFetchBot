import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("./render/jobCard.ps1", import.meta.url));
const RENDER_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Renders a PNG card per spec with Windows' built-in System.Drawing, so there is nothing
 * to install. Specs come from buildCardSpec.
 * @param {ReturnType<typeof import("./threadsPost.js").buildCardSpec>[]} specs
 * @param {string} outDir
 * @param {string} [handle] Threads username printed at the bottom of the card
 * @returns {Promise<Record<string, string>>} PNG path by job id
 */
export async function renderCards(specs, outDir, handle = "") {
  if (process.platform !== "win32") throw new Error("Image cards are rendered with Windows PowerShell; use --no-image on other systems");
  await mkdir(outDir, { recursive: true });
  const specPath = join(outDir, "cards.json");
  await writeFile(specPath, JSON.stringify(specs));
  const { stdout } = await run(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-SpecPath", specPath, "-OutDir", outDir, "-Handle", handle],
    { timeout: RENDER_TIMEOUT_MS, windowsHide: true },
  );
  const paths = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return Object.fromEntries(specs.map((spec) => {
    const path = paths.find((candidate) => candidate.endsWith(`job-${spec.id}.png`));
    if (!path) throw new Error(`The card for job ${spec.id} was not rendered`);
    return [String(spec.id), path];
  }));
}
