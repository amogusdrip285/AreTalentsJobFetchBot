import assert from "node:assert/strict";
import { test } from "node:test";
import { assertFlagsArrived } from "../src/cliSupport.js";

const flags = ["dry-run", "publish", "id"];

test("passes when npm kept none of the flags", () => {
  assert.doesNotThrow(() => assertFlagsArrived(flags, "src/pushCli.js", { npm_config_cache: "x" }));
});

test("stops when npm kept a flag for itself", () => {
  assert.throws(() => assertFlagsArrived(flags, "src/pushCli.js", { npm_config_publish: "true" }), /--publish/);
});

test("matches flags with a dash in the name", () => {
  assert.throws(() => assertFlagsArrived(flags, "src/pushCli.js", { npm_config_dry_run: "true" }), /--dry-run/);
});

test("the error names every lost flag and the command that works", () => {
  const env = { npm_config_dry_run: "true", npm_config_publish: "true" };

  assert.throws(() => assertFlagsArrived(flags, "src/pushCli.js", env), (error) => {
    assert.match(error.message, /--dry-run, --publish/);
    assert.match(error.message, /node src\/pushCli\.js --dry-run --publish/);
    return true;
  });
});
