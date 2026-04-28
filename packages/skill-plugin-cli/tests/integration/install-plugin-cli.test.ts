import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createInstallCliUseCase, parseInstallArgv } from "../../src/index.ts";

async function createFakeQrCodeModule(dir: string, scenario: "confirmed" | "cancelled") {
  const filePath = join(dir, "fake-qrcode-auth.mjs");
  const terminalEvent = scenario === "confirmed"
    ? `input.onSnapshot({ type: "confirmed", qrcode: "qr-1", credentials: { ak: "ak-1", sk: "sk-1" } });`
    : `input.onSnapshot({ type: "cancelled", qrcode: "qr-1" });`;
  await writeFile(
    filePath,
    `export const qrcodeAuth = {
  async run(input) {
    input.onSnapshot({
      type: "qrcode_generated",
      qrcode: "qr-1",
      display: {
        qrcode: "qr-1",
        weUrl: "https://we.example/qr-1",
        pcUrl: "https://pc.example/qr-1"
      },
      expiresAt: "2026-04-28T00:00:00.000Z"
    });
    ${terminalEvent}
  }
};
`,
    "utf8",
  );
  return filePath;
}

async function createFakeCommand(dir: string, name: "openclaw" | "opencode", body: string) {
  const filePath = join(dir, name);
  await writeFile(filePath, `#!/bin/sh\n${body}\n`, "utf8");
  await chmod(filePath, 0o755);
  return filePath;
}

test("direct use case completes openclaw install and tolerates restart warning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-openclaw-"));
  const originalEnv = { ...process.env };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  try {
    const logPath = join(dir, "openclaw.log");
    const qrcodePath = await createFakeQrCodeModule(dir, "confirmed");
    await createFakeCommand(
      dir,
      "openclaw",
      `echo "$@" >> ${JSON.stringify(logPath)}
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
  exit 7
fi
exit 0`,
    );

    process.env.PATH = `${dir}:${originalEnv.PATH || ""}`;
    process.env.SKILL_PLUGIN_CLI_QRCODE_AUTH_MODULE = qrcodePath;
    process.env.NPM_CONFIG_USERCONFIG = join(dir, ".npmrc");
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    const parsed = parseInstallArgv(["install", "--host", "openclaw", "--url", "wss://gateway.example.com/ws/agent"]);
    assert.ok(!("help" in parsed));
    const result = await createInstallCliUseCase().execute(parsed);
    assert.equal(result.status, "success");
    assert.equal(result.warningMessages.length, 1);
    const output = stdout.join("");
    const warningMatches = output.match(/\[skill-plugin-cli\]\[warning\] restart failed/g) ?? [];
    assert.equal(warningMatches.length, 1);
    assert.match(output, /开始：插件安装/);
    assert.match(output, /正在执行宿主安装命令，以下输出来自宿主原生命令。/);
    assert.match(output, /宿主安装命令执行结束。/);
    assert.doesNotMatch(output, /完成：仓源配置/);
    assert.doesNotMatch(output, /完成：插件安装 ·/);
    assert.match(output, /(pcUrl: \u001B\]8;;https:\/\/pc\.example\/qr-1\u0007打开浏览器授权\u001B\]8;;\u0007[\s\S]*pcUrl: https:\/\/pc\.example\/qr-1)|(pcUrl（可复制打开）: https:\/\/pc\.example\/qr-1)/);
    assert.equal(stderr.length, 0);
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    process.env = originalEnv;
    await rm(dir, { recursive: true, force: true });
  }
});

test("direct use case omits openclaw --url when user does not pass url", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-openclaw-no-url-"));
  const originalEnv = { ...process.env };
  try {
    const logPath = join(dir, "openclaw.log");
    const qrcodePath = await createFakeQrCodeModule(dir, "confirmed");
    await createFakeCommand(
      dir,
      "openclaw",
      `echo "$@" >> ${JSON.stringify(logPath)}
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
  exit 0
fi
exit 0`,
    );

    process.env.PATH = `${dir}:${originalEnv.PATH || ""}`;
    process.env.SKILL_PLUGIN_CLI_QRCODE_AUTH_MODULE = qrcodePath;
    process.env.NPM_CONFIG_USERCONFIG = join(dir, ".npmrc");

    const parsed = parseInstallArgv(["install", "--host", "openclaw"]);
    assert.ok(!("help" in parsed));
    const result = await createInstallCliUseCase().execute(parsed);
    assert.equal(result.status, "success");
    const log = await import("node:fs/promises").then(({ readFile }) => readFile(logPath, "utf8"));
    assert.match(log, /channels add --channel message-bridge --token ak-1 --password sk-1/);
    assert.doesNotMatch(log, /channels add .*--url/);
  } finally {
    process.env = originalEnv;
    await rm(dir, { recursive: true, force: true });
  }
});

test("direct use case returns cancelled when opencode qrcode flow is cancelled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-opencode-"));
  const originalEnv = { ...process.env };
  const stdout: string[] = [];
  const originalStdout = process.stdout.write.bind(process.stdout);
  try {
    const qrcodePath = await createFakeQrCodeModule(dir, "cancelled");
    const configDir = join(dir, ".config", "opencode");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "opencode.json"),
      JSON.stringify({ plugin: ["@wecode/skill-opencode-plugin"] }, null, 2),
      "utf8",
    );
    await createFakeCommand(
      dir,
      "opencode",
      `if [ "$1" = "--version" ]; then
  printf '1.0.0'
  exit 0
fi
if [ "$1" = "plugin" ]; then
  exit 0
fi
exit 0`,
    );

    process.env.PATH = `${dir}:${originalEnv.PATH || ""}`;
    process.env.SKILL_PLUGIN_CLI_QRCODE_AUTH_MODULE = qrcodePath;
    process.env.NPM_CONFIG_USERCONFIG = join(dir, ".npmrc");
    process.env.XDG_CONFIG_HOME = join(dir, ".config");
    process.env.SKILL_PLUGIN_CLI_OPENCODE_RUNNING = "1";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    const parsed = parseInstallArgv(["install", "--host", "opencode"]);
    assert.ok(!("help" in parsed));
    const result = await createInstallCliUseCase().execute(parsed);
    assert.equal(result.status, "cancelled");
    const output = stdout.join("");
    assert.doesNotMatch(output, /url=ws:\/\/localhost:8081\/ws\/agent/);
  } finally {
    process.stdout.write = originalStdout;
    process.env = originalEnv;
    await rm(dir, { recursive: true, force: true });
  }
});
