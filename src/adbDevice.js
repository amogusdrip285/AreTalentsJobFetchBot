import { execFile } from "node:child_process";
import { Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);
const ADB_TIMEOUT_MS = 60_000;
const ADB_PORT = 5555;
const PROBE_TIMEOUT_MS = 1_500;
const UI_DUMP_PATH = "/data/local/tmp/threads_bot_ui.xml";
const POLL_INTERVAL_MS = 700;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
const decode = (text) => text.replace(/&(#x?[0-9a-f]+|\w+);/gi, (whole, code) => {
  if (code[0] !== "#") return ENTITIES[code] ?? whole;
  const point = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
  return String.fromCodePoint(point);
});

const attribute = (tag, name) => {
  const match = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return match ? decode(match[1]) : "";
};

/**
 * @typedef {{ text: string, id: string, desc: string, className: string, clickable: boolean,
 *   bounds: { left: number, top: number, right: number, bottom: number } }} UiNode
 */

/**
 * Reads a `uiautomator dump`. Resource ids lose their package prefix, so Threads' Compose
 * test tags and its classic view ids can be matched the same way.
 * @param {string} xml
 * @returns {UiNode[]}
 */
export function parseUiNodes(xml) {
  return [...xml.matchAll(/<node\s[^>]*>/g)].map(([tag]) => {
    const [left, top, right, bottom] = (attribute(tag, "bounds").match(/\d+/g) ?? [0, 0, 0, 0]).map(Number);
    return {
      text: attribute(tag, "text"),
      id: attribute(tag, "resource-id").replace(/^[\w.]+:id\//, ""),
      desc: attribute(tag, "content-desc"),
      className: attribute(tag, "class"),
      clickable: attribute(tag, "clickable") === "true",
      bounds: { left, top, right, bottom },
    };
  });
}

/** @param {UiNode} node */
export const center = ({ bounds }) => ({
  x: Math.round((bounds.left + bounds.right) / 2),
  y: Math.round((bounds.top + bounds.bottom) / 2),
});

/**
 * @param {{ serial: string, adbPath?: string }} options
 */
export function createAdb({ serial, adbPath = "adb" }) {
  const exec = async (args) => {
    const { stdout } = await run(adbPath, ["-s", serial, ...args], {
      timeout: ADB_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  };
  const shell = (command) => exec(["shell", command]);

  const dumpUi = async () => {
    const xml = await shell(`uiautomator dump ${UI_DUMP_PATH} >/dev/null 2>&1; cat ${UI_DUMP_PATH}`);
    if (!xml.includes("<hierarchy")) throw new Error(`Could not read the screen of ${serial}. Is it unlocked?`);
    return parseUiNodes(xml);
  };

  /**
   * Polls the screen until `predicate` matches a node.
   * @param {(node: UiNode) => boolean} predicate
   * @param {{ timeoutMs?: number, what: string }} options
   */
  const waitFor = async (predicate, { timeoutMs = 20_000, what }) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const nodes = await dumpUi().catch(() => []);
      const found = nodes.find(predicate);
      if (found) return { node: found, nodes };
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${what}`);
  };

  const waitUntilGone = async (predicate, { timeoutMs = 30_000, what }) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const nodes = await dumpUi().catch(() => null);
      if (nodes && !nodes.some(predicate)) return;
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${what} to close`);
  };

  const tap = async (node) => {
    const { x, y } = center(node);
    await shell(`input tap ${x} ${y}`);
  };

  return {
    serial,
    exec,
    shell,
    push: (local, remote) => exec(["push", local, remote]),
    dumpUi,
    waitFor,
    waitUntilGone,
    tap,
    keyevent: (key) => shell(`input keyevent ${key}`),
  };
}

const probe = (host) => new Promise((resolve) => {
  const socket = new Socket();
  const done = (isOpen) => { socket.destroy(); resolve(isOpen ? host : null); };
  socket.setTimeout(PROBE_TIMEOUT_MS);
  socket.once("connect", () => done(true));
  socket.once("timeout", () => done(false));
  socket.once("error", () => done(false));
  socket.connect(ADB_PORT, host);
});

/** The /24 networks of this computer's private IPv4 addresses. */
export function localSubnets(interfaces = networkInterfaces()) {
  const prefixes = Object.values(interfaces).flat()
    .filter((entry) => entry && entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address)
    .filter((address) => /^(192\.168|10)\./.test(address))
    .map((address) => address.split(".").slice(0, 3).join("."));
  return [...new Set(prefixes)];
}

/**
 * Finds devices with ADB over Wi-Fi switched on, by trying port 5555 across each subnet.
 * @param {string[]} subnets such as ["192.168.1"]
 * @returns {Promise<string[]>} serials such as "192.168.1.251:5555"
 */
export async function discoverDevices(subnets = localSubnets()) {
  const hosts = subnets.flatMap((subnet) => Array.from({ length: 254 }, (_, index) => `${subnet}.${index + 1}`));
  const open = await Promise.all(hosts.map(probe));
  return open.filter(Boolean).map((host) => `${host}:${ADB_PORT}`);
}

/**
 * Runs `adb connect` and checks the device is ready, not unauthorized or offline.
 * @param {string} serial
 * @param {string} [adbPath]
 */
export async function connectDevice(serial, adbPath = "adb") {
  const { stdout } = await run(adbPath, ["connect", serial], { timeout: ADB_TIMEOUT_MS, windowsHide: true });
  if (!/connected to|already connected/.test(stdout)) throw new Error(`adb connect ${serial} failed: ${stdout.trim()}`);
  const { stdout: state } = await run(adbPath, ["-s", serial, "get-state"], { timeout: ADB_TIMEOUT_MS, windowsHide: true })
    .catch((error) => ({ stdout: error.stderr ?? error.message }));
  if (state.trim() !== "device") throw new Error(`${serial} is not ready (${state.trim()}). Accept the USB debugging prompt on the phone.`);
}
