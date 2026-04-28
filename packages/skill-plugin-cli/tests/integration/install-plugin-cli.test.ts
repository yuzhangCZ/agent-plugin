import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";
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
  const filePath = process.platform === "win32" ? join(dir, `${name}.cmd`) : join(dir, name);
  if (process.platform === "win32") {
    const windowsBody = body
      .replaceAll('echo "$@" >> ', "echo %* >> ")
      .replaceAll('if [ "$1" = "--version" ]; then', 'if "%~1"=="--version" (')
      .replaceAll('if [ "$1" = "plugins" ] && [ "$2" = "install" ]; then', 'if "%~1"=="plugins" if "%~2"=="install" (')
      .replaceAll('if [ "$1" = "plugins" ] && [ "$2" = "info" ]; then', 'if "%~1"=="plugins" if "%~2"=="info" (')
      .replaceAll('if [ "$1" = "channels" ] && [ "$2" = "add" ]; then', 'if "%~1"=="channels" if "%~2"=="add" (')
      .replaceAll('if [ "$1" = "channels" ] && [ "$2" = "status" ]; then', 'if "%~1"=="channels" if "%~2"=="status" (')
      .replaceAll("  printf '2026.3.24'", "<nul set /p =2026.3.24")
      .replaceAll("  printf '1.0.0'", "<nul set /p =1.0.0")
      .replaceAll(`  printf '{"id":"skill-openclaw-plugin","channelIds":["message-bridge"]}'`, `<nul set /p ={"id":"skill-openclaw-plugin","channelIds":["message-bridge"]}`)
      .replaceAll(`  printf '{"state":"ready"}'`, `<nul set /p ={"state":"ready"}`)
      .replaceAll(`  printf 'probe failed' >&2`, `echo probe failed 1>&2`)
      .replaceAll("  exit 0", "  exit /b 0")
      .replaceAll("  exit 9", "  exit /b 9")
      .replaceAll("fi", ")")
      .replaceAll("exit 0", "exit /b 0");
    await writeFile(filePath, `@echo off\r\n${windowsBody}\r\n`, "utf8");
    return filePath;
  }
  await writeFile(filePath, `#!/bin/sh\n${body}\n`, "utf8");
  await chmod(filePath, 0o755);
  return filePath;
}

test("direct use case completes openclaw install and prints manual restart next steps", async () => {
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
exit 0`,
    );

    process.env.PATH = `${dir}${delimiter}${originalEnv.PATH || ""}`;
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
    assert.deepEqual(result.warningMessages, []);
    assert.deepEqual(result.nextSteps, [
      "下一步：请手动重启 OpenClaw gateway 以确认 channel 生效。",
      "可执行命令：openclaw gateway restart",
    ]);
    const output = stdout.join("");
    assert.match(output, /开始：插件安装/);
    assert.match(output, /正在执行宿主安装命令，以下输出来自宿主原生命令。/);
    assert.match(output, /宿主安装命令执行结束。/);
    assert.match(output, /安装成功：OpenClaw 安装完成/);
    assert.match(output, /下一步：请手动重启 OpenClaw gateway 以确认 channel 生效。/);
    assert.match(output, /可执行命令：openclaw gateway restart/);
    assert.doesNotMatch(output, /完成：仓源配置/);
    assert.doesNotMatch(output, /完成：插件安装 ·/);
    assert.doesNotMatch(output, /gateway restart 已执行|restart failed/);
    assert.match(output, /(pcUrl: \u001B\]8;;https:\/\/pc\.example\/qr-1\u0007打开浏览器授权\u001B\]8;;\u0007[\s\S]*pcUrl: https:\/\/pc\.example\/qr-1)|(pcUrl（可复制打开）: https:\/\/pc\.example\/qr-1)/);
    assert.equal(stderr.length, 0);
    const log = await import("node:fs/promises").then(({ readFile }) => readFile(logPath, "utf8"));
    assert.doesNotMatch(log, /gateway restart/);
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

    process.env.PATH = `${dir}${delimiter}${originalEnv.PATH || ""}`;
    process.env.SKILL_PLUGIN_CLI_QRCODE_AUTH_MODULE = qrcodePath;
    process.env.NPM_CONFIG_USERCONFIG = join(dir, ".npmrc");

    const parsed = parseInstallArgv(["install", "--host", "openclaw"]);
    assert.ok(!("help" in parsed));
    const result = await createInstallCliUseCase().execute(parsed);
    assert.equal(result.status, "success");
    assert.deepEqual(result.nextSteps, [
      "下一步：请手动重启 OpenClaw gateway 以确认 channel 生效。",
      "可执行命令：openclaw gateway restart",
    ]);
    const log = await import("node:fs/promises").then(({ readFile }) => readFile(logPath, "utf8"));
    assert.match(log, /channels add --channel message-bridge --token ak-1 --password sk-1/);
    assert.doesNotMatch(log, /channels add .*--url/);
    assert.doesNotMatch(log, /gateway restart/);
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

    process.env.PATH = `${dir}${delimiter}${originalEnv.PATH || ""}`;
    process.env.SKILL_PLUGIN_CLI_QRCODE_AUTH_MODULE = qrcodePath;
    process.env.NPM_CONFIG_USERCONFIG = join(dir, ".npmrc");
    process.env.XDG_CONFIG_HOME = join(dir, ".config");
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

test("direct use case completes opencode install and writes explicit gateway url", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-opencode-success-"));
  const originalEnv = { ...process.env };
  const stdout: string[] = [];
  const originalStdout = process.stdout.write.bind(process.stdout);
  try {
    const qrcodePath = await createFakeQrCodeModule(dir, "confirmed");
    const configDir = join(dir, ".config", "opencode");
    const logPath = join(dir, "opencode.log");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "opencode.json"),
      JSON.stringify({ plugin: ["@wecode/skill-opencode-plugin"] }, null, 2),
      "utf8",
    );
    await createFakeCommand(
      dir,
      "opencode",
      `echo "$@" >> ${JSON.stringify(logPath)}
if [ "$1" = "--version" ]; then
  printf '1.0.0'
  exit 0
fi
if [ "$1" = "plugin" ]; then
  exit 0
fi
exit 0`,
    );

    process.env.PATH = `${dir}${delimiter}${originalEnv.PATH || ""}`;
    process.env.SKILL_PLUGIN_CLI_QRCODE_AUTH_MODULE = qrcodePath;
    process.env.NPM_CONFIG_USERCONFIG = join(dir, ".npmrc");
    process.env.XDG_CONFIG_HOME = join(dir, ".config");
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    const parsed = parseInstallArgv(["install", "--host", "opencode", "--url", "wss://gateway.example.com/ws/agent"]);
    assert.ok(!("help" in parsed));
    const result = await createInstallCliUseCase().execute(parsed);
    assert.equal(result.status, "success");
    assert.deepEqual(result.warningMessages, []);
    assert.deepEqual(result.nextSteps, [
      "下一步：请手动重启 OpenCode 以确认插件与配置生效。",
      "可执行命令：opencode",
    ]);
    const bridgeConfig = await import("node:fs/promises").then(({ readFile }) =>
      readFile(join(configDir, "message-bridge.json"), "utf8"));
    const opencodeConfig = await import("node:fs/promises").then(({ readFile }) =>
      readFile(join(configDir, "opencode.json"), "utf8"));
    const output = stdout.join("");
    assert.match(output, /开始：插件安装/);
    assert.match(output, /正在执行宿主安装命令，以下输出来自宿主原生命令。/);
    assert.match(output, /宿主安装命令执行结束。/);
    assert.match(output, /安装成功：OpenCode 安装完成/);
    assert.match(output, /下一步：请手动重启 OpenCode 以确认插件与配置生效。/);
    assert.match(output, /可执行命令：opencode/);
    assert.match(bridgeConfig, /wss:\/\/gateway\.example\.com\/ws\/agent/);
    assert.match(bridgeConfig, /"ak": "ak-1"/);
    assert.match(bridgeConfig, /"sk": "sk-1"/);
    assert.match(opencodeConfig, /@wecode\/skill-opencode-plugin/);
  } finally {
    process.stdout.write = originalStdout;
    process.env = originalEnv;
    await rm(dir, { recursive: true, force: true });
  }
});

test("direct use case omits opencode gateway url write when user does not pass url", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-opencode-no-url-"));
  const originalEnv = { ...process.env };
  try {
    const qrcodePath = await createFakeQrCodeModule(dir, "confirmed");
    const configDir = join(dir, ".config", "opencode");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "opencode.json"),
      JSON.stringify({ plugin: ["@wecode/skill-opencode-plugin"] }, null, 2),
      "utf8",
    );
    await writeFile(
      join(configDir, "message-bridge.json"),
      JSON.stringify({
        gateway: {
          url: "wss://existing.example.com/ws/agent",
        },
      }, null, 2),
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

    process.env.PATH = `${dir}${delimiter}${originalEnv.PATH || ""}`;
    process.env.SKILL_PLUGIN_CLI_QRCODE_AUTH_MODULE = qrcodePath;
    process.env.NPM_CONFIG_USERCONFIG = join(dir, ".npmrc");
    process.env.XDG_CONFIG_HOME = join(dir, ".config");

    const parsed = parseInstallArgv(["install", "--host", "opencode"]);
    assert.ok(!("help" in parsed));
    const result = await createInstallCliUseCase().execute(parsed);
    assert.equal(result.status, "success");
    assert.deepEqual(result.nextSteps, [
      "下一步：请手动重启 OpenCode 以确认插件与配置生效。",
      "可执行命令：opencode",
    ]);
    const bridgeConfig = await import("node:fs/promises").then(({ readFile }) =>
      readFile(join(configDir, "message-bridge.json"), "utf8"));
    assert.match(bridgeConfig, /wss:\/\/existing\.example\.com\/ws\/agent/);
    assert.doesNotMatch(bridgeConfig, /localhost:8081/);
  } finally {
    process.env = originalEnv;
    await rm(dir, { recursive: true, force: true });
  }
});

test("direct use case fails openclaw install when probe fails without restart guidance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-openclaw-probe-failed-"));
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
  printf 'probe failed' >&2
  exit 9
fi
exit 0`,
    );

    process.env.PATH = `${dir}${delimiter}${originalEnv.PATH || ""}`;
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

    const parsed = parseInstallArgv(["install", "--host", "openclaw"]);
    assert.ok(!("help" in parsed));
    const result = await createInstallCliUseCase().execute(parsed);
    assert.equal(result.status, "failed");
    assert.deepEqual(result.nextSteps, []);
    assert.match(result.message, /probe failed/);
    assert.doesNotMatch(stdout.join(""), /可执行命令：openclaw gateway restart/);
    assert.doesNotMatch(stderr.join(""), /可执行命令：openclaw gateway restart/);
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    process.env = originalEnv;
    await rm(dir, { recursive: true, force: true });
  }
});
