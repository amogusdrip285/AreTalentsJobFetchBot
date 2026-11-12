import assert from "node:assert/strict";
import { test } from "node:test";
import { center, localSubnets, parseUiNodes } from "../src/adbDevice.js";
import { buildShareCommand, lineBreakMoves, shellQuote } from "../src/threadsBot.js";

test("quotes single quotes for sh", () => {
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test("the share command targets Threads and carries the text", () => {
  const command = buildShareCommand("Xin chào\nit's me");
  assert.match(command, /^am start -a android\.intent\.action\.SEND -t text\/plain/);
  assert.match(command, /-n com\.instagram\.barcelona\/\.handleractivity\.BarcelonaShareHandlerActivity/);
  assert.ok(command.endsWith(`--es android.intent.extra.TEXT 'Xin chào\nit'\\''s me'`));
  assert.doesNotMatch(command, / -W /);
});

test("line breaks are restored last first, counting graphemes", () => {
  // "ab\ncd\n\n👉e" is 9 graphemes with breaks at 2, 5 and 6; the emoji counts as one press.
  // Each swap leaves the cursor just after the new line break.
  assert.deepEqual(lineBreakMoves("ab\ncd\n\n👉e"), [2, 1, 3]);
});

test("text without line breaks needs no moves", () => {
  assert.deepEqual(lineBreakMoves("one line"), []);
});

const DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="&#128640; A &amp; B&#10;C" resource-id="new_thread_screen_composer" class="android.widget.EditText" content-desc="" clickable="true" bounds="[158,301][1038,406]" />
<node index="1" text="" resource-id="com.instagram.barcelona:id/action_bar_root" class="android.widget.LinearLayout" content-desc="Don&apos;t save" clickable="false" bounds="[0,0][1080,2094]">
</node></hierarchy>`;

test("parses uiautomator nodes and decodes entities", () => {
  const [composer, root] = parseUiNodes(DUMP);
  assert.deepEqual(composer, {
    text: "🚀 A & B\nC",
    id: "new_thread_screen_composer",
    desc: "",
    className: "android.widget.EditText",
    clickable: true,
    bounds: { left: 158, top: 301, right: 1038, bottom: 406 },
  });
  assert.equal(root.id, "action_bar_root");
  assert.equal(root.desc, "Don't save");
});

test("finds the centre of a node", () => {
  assert.deepEqual(center({ bounds: { left: 0, top: 10, right: 101, bottom: 20 } }), { x: 51, y: 15 });
});

test("lists private /24 subnets, skipping loopback, VPN and public addresses", () => {
  const subnets = localSubnets({
    Ethernet: [{ family: "IPv4", address: "192.168.1.86", internal: false }],
    "Wi-Fi": [{ family: "IPv4", address: "10.0.5.3", internal: false }, { family: "IPv6", address: "fe80::1", internal: false }],
    Loopback: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
    VPN: [{ family: "IPv4", address: "26.48.157.252", internal: false }],
    Dup: [{ family: "IPv4", address: "192.168.1.99", internal: false }],
  });
  assert.deepEqual(subnets, ["192.168.1", "10.0.5"]);
});
