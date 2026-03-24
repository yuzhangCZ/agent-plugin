import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";

import { createIsolatedHomeEnv, isCliEntry } from "../../scripts/runtime-smoke.mjs";

test("createIsolatedHomeEnv pins home and config variables for child processes", () => {
  const homeDir = "/tmp/openclaw-home";
  const env = createIsolatedHomeEnv(homeDir, {
    MB_RUNTIME_GATEWAY_PORT: "18081",
  });

  assert.equal(env.HOME, homeDir);
  assert.equal(env.USERPROFILE, homeDir);
  assert.equal(env.XDG_CONFIG_HOME, path.join(homeDir, ".config"));
  assert.equal(env.MB_RUNTIME_GATEWAY_PORT, "18081");
});

test("isCliEntry normalizes Windows-style argv paths", () => {
  assert.equal(
    isCliEntry("file:///C:/repo/plugins/message-bridge-openclaw/scripts/runtime-smoke.mjs", "C:\\repo\\plugins\\message-bridge-openclaw\\scripts\\runtime-smoke.mjs"),
    true,
  );
  assert.equal(
    isCliEntry(
      "file:///C:/repo/plugins/message-bridge-openclaw/scripts/runtime-smoke.mjs",
      ".\\plugins\\message-bridge-openclaw\\scripts\\runtime-smoke.mjs",
      "C:\\repo",
    ),
    true,
  );
  assert.equal(
    isCliEntry("file:///C:/repo/plugins/message-bridge-openclaw/scripts/runtime-smoke.mjs", "D:\\repo\\plugins\\message-bridge-openclaw\\scripts\\runtime-smoke.mjs"),
    false,
  );
});
