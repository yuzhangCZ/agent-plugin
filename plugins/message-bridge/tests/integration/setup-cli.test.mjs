import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/setup-message-bridge.mjs");

async function createFakeQrCodeModule(dir) {
  const modulePath = join(dir, "fake-qrcode-auth.mjs");
  await writeFile(
    modulePath,
    `export const qrcodeAuth = {
  async run(input) {
    input.onSnapshot({
      type: "qrcode_generated",
      qrcode: "qr-1",
      display: { qrcode: "qr-1", weUrl: "https://we.example/qr-1", pcUrl: "https://pc.example/qr-1" },
      expiresAt: "2026-04-28T00:00:00.000Z"
    });
    input.onSnapshot({
      type: "confirmed",
      qrcode: "qr-1",
      credentials: { ak: "wrapper-ak", sk: "wrapper-sk" }
    });
  }
};
`,
    "utf8",
  );
  return modulePath;
}

async function createFakeOpencode(dir) {
  const script = join(dir, "opencode");
  await writeFile(
    script,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '1.0.0'
  exit 0
fi
if [ "$1" = "plugin" ]; then
  exit 0
fi
exit 0
`,
    "utf8",
  );
  await chmod(script, 0o755);
}

test("setup-message-bridge wrapper maps deprecated params and forwards to unified cli", async () => {
  const dir = await mkdtemp(join(tmpdir(), "setup-wrapper-"));
  try {
    const qrcodeModule = await createFakeQrCodeModule(dir);
    await createFakeOpencode(dir);
    const home = join(dir, "home");
    const result = spawnSync(
      process.execPath,
      [scriptPath, "--scope", "project", "--yes", "--environment", "uat", "--url", "wss://gateway.example.com/ws/agent"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH || ""}`,
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          NPM_CONFIG_USERCONFIG: join(home, ".npmrc"),
          MB_SETUP_QRCODE_AUTH_MODULE: qrcodeModule,
          SKILL_PLUGIN_CLI_OPENCODE_RUNNING: "1",
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--scope=project 已废弃/);
    assert.match(result.stdout, /--yes 已废弃/);
    const bridgeConfig = await readFile(join(home, ".config", "opencode", "message-bridge.jsonc"), "utf8");
    assert.match(bridgeConfig, /wrapper-ak/);
    assert.match(bridgeConfig, /wss:\/\/gateway\.example\.com\/ws\/agent/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
