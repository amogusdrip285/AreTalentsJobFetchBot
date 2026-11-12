#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { issueApiKey, setEnvValues } from "./areTalentsSetup.js";
import { assertFlagsArrived, loadEnv, print, runMain } from "./cliSupport.js";

const ENV_PATH = fileURLToPath(new URL("../.env", import.meta.url));
const DEFAULT_BASE_URL = "https://www.aretalents.com";

const main = async () => {
  assertFlagsArrived(["register"], "src/setupCli.js");
  const { values } = parseArgs({ options: { register: { type: "boolean", default: false } } });
  if (!existsSync(ENV_PATH)) throw new Error("Copy .env.example to .env and fill it in first");
  loadEnv();

  const { ARETALENTS_EMAIL: email, ARETALENTS_PASSWORD: password, ARETALENTS_API_KEY: existingKey } = process.env;
  const baseUrl = process.env.ARETALENTS_BASE_URL || DEFAULT_BASE_URL;
  if (existingKey) throw new Error("ARETALENTS_API_KEY is already set; clear it in .env to issue a new one");
  if (!email || !password) throw new Error("ARETALENTS_EMAIL and ARETALENTS_PASSWORD must be set in .env");

  const { token, prefix, expiresAt } = await issueApiKey({ baseUrl, email, password, shouldRegister: values.register });
  writeFileSync(ENV_PATH, setEnvValues(readFileSync(ENV_PATH, "utf8"), {
    ARETALENTS_BASE_URL: baseUrl,
    ARETALENTS_API_KEY: token,
    ARETALENTS_API_KEY_EXPIRES_AT: expiresAt,
  }));
  print(`Saved key ${prefix} to .env, expires ${expiresAt}`);
};

runMain(main);
