import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/install-openclaw-plugin.mjs");

async function createFakeQrCodeModule(dir) {
  const modulePath = path.join(dir, "fake-qrcode-auth.mjs");
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
      credentials: { ak: "openclaw-ak", sk: "openclaw-sk" }
    });
  }
};
`,
    "utf8",
  );
  return modulePath;
}

async function createFakeOpenclaw(dir, logPath) {
  const script = path.join(dir, "openclaw");
  await writeFile(
    script,
    `#!/bin/sh
echo "$@" >> ${JSON.stringify(logPath)}
if [ "$1" = "--version" ]; then
  printf '2026.3.24'
  exit 0
fi
if [ "$1" = "plugins" ] && [ "$2" = "install" ]; then
  exit 0
fi
if [ "$1" = "plugins" ] && [ "$2" = "info" ]; then
  printf '{"id":"skill-openclaw-plugin","channelIds":["message-bridge"]}'
  exit 0
fi
if [ "$1" = "channels" ] && [ "$2" = "add" ]; then
  exit 0
fi
if [ "$1" = "channels" ] && [ "$2" = "status" ]; then
  printf '{"state":"ready"}'
  exit 0
fi
if [ "$1" = "gateway" ] && [ "$2" = "restart" ]; then
  printf 'restart failed' >&2
  exit 9
fi
exit 0
`,
    "utf8",
  );
  await chmod(script, 0o755);
}

test("install-openclaw-plugin wrapper forwards to unified cli", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "openclaw-wrapper-"));
  try {
    const logPath = path.join(dir, "openclaw.log");
    const qrcodeModule = await createFakeQrCodeModule(dir);
    await createFakeOpenclaw(dir, logPath);

    const result = spawnSync(
      process.execPath,
      [scriptPath, "--environment", "uat", "--registry", "https://npm.example.com", "--url", "wss://gateway.example.com/ws/agent"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH || ""}`,
          OPENCLAW_INSTALL_QRCODE_AUTH_MODULE: qrcodeModule,
          NPM_CONFIG_USERCONFIG: path.join(dir, ".npmrc"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /restart 已降级为 warning|warning/);
    const log = await readFile(logPath, "utf8");
    assert.match(log, /plugins install @wecode\/skill-openclaw-plugin/);
    assert.match(log, /channels add --channel message-bridge --url wss:\/\/gateway\.example\.com\/ws\/agent --token openclaw-ak --password openclaw-sk/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("install-openclaw-plugin wrapper omits url when unified cli is not passed --url", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "openclaw-wrapper-no-url-"));
  try {
    const logPath = path.join(dir, "openclaw.log");
    const qrcodeModule = await createFakeQrCodeModule(dir);
    await createFakeOpenclaw(dir, logPath);

    const result = spawnSync(
      process.execPath,
      [scriptPath, "--environment", "uat", "--registry", "https://npm.example.com"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH || ""}`,
          OPENCLAW_INSTALL_QRCODE_AUTH_MODULE: qrcodeModule,
          NPM_CONFIG_USERCONFIG: path.join(dir, ".npmrc"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const log = await readFile(logPath, "utf8");
    assert.match(log, /channels add --channel message-bridge --token openclaw-ak --password openclaw-sk/);
    assert.doesNotMatch(log, /channels add .*--url/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
