import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { delimiter, join } from "node:path";
import process from "node:process";
import test from "node:test";
import { parseInstallArgv } from "../../src/cli/parse-argv.ts";
import { createInstallCliUseCase } from "../../src/cli/runtime.ts";
import type { QrCodeAuthRuntime } from "../../src/domain/qrcode-types.ts";

function createFakeQrCodeRuntime(
  scenario: "confirmed" | "cancelled" | "network_error" | "refresh",
): QrCodeAuthRuntime {
  return {
    async run(input) {
      if (scenario === "network_error") {
        input.onSnapshot({
          type: "failed",
          reasonCode: "network_error",
          serviceError: {
            code: "ECONNREFUSED",
            message: "connect ECONNREFUSED 127.0.0.1:443",
          },
        });
        return;
      }

      input.onSnapshot({
        type: "qrcode_generated",
        qrcode: "qr-1",
        display: {
          qrcode: "qr-1",
          weUrl: "https://we.example/qr-1",
          pcUrl: "https://pc.example/qr-1",
        },
        expiresAt: "2026-04-28T08:00:00.000Z",
      });

      if (scenario === "refresh") {
        input.onSnapshot({ type: "expired", qrcode: "qr-1" });
        input.onSnapshot({
          type: "qrcode_generated",
          qrcode: "qr-2",
          display: {
            qrcode: "qr-2",
            weUrl: "https://we.example/qr-2",
            pcUrl: "https://pc.example/qr-2",
          },
          expiresAt: "2026-04-28T08:05:00.000Z",
        });
      }

      if (scenario === "cancelled") {
        input.onSnapshot({ type: "cancelled", qrcode: "qr-1" });
        return;
      }

      input.onSnapshot({ type: "confirmed", qrcode: "qr-1", credentials: { ak: "ak-1", sk: "sk-1" } });
    },
  };
}

async function createFakeCommand(dir: string, name: "openclaw" | "opencode", body: string) {
  const filePath = process.platform === "win32" ? join(dir, `${name}.cmd`) : join(dir, name);
  if (process.platform === "win32") {
    throw new Error("Windows is not supported in this test suite.");
  }
  await writeFile(filePath, `#!/bin/sh\n${body}\n`, "utf8");
  await chmod(filePath, 0o755);
  return filePath;
}

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    stdout,
    stderr,
    restore() {
      process.stdout.write = originalStdout;
      process.stderr.write = originalStderr;
    },
  };
}

function normalizeQrBlock(output: string) {
  return output.replace(/(?:[ \u2580-\u259f]+\n)+/gu, "<二维码渲染块>\n");
}

const mainEntry = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));

test("cli --help transcript matches output spec", () => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", mainEntry, "--help"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^skill-plugin-cli\n\n用于安装插件、创建 WeLink 助理，并完成与 gateway 的连接配置。\n/m);
  assert.match(result.stdout, /skill-plugin-cli install --host opencode .* \[--verbose\]/);
});

test("cli usage error transcript appends help hint", () => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", mainEntry, "install", "--host", "bad-host"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "[skill-plugin-cli] 参数错误：--host 必须为 opencode 或 openclaw\n"
      + "[skill-plugin-cli] 可执行 skill-plugin-cli --help 查看用法\n",
  );
});

test("default openclaw success flow matches output spec", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-openclaw-success-"));
  const originalEnv = { ...process.env };
  const io = captureIo();
  try {
    const logPath = join(dir, "openclaw.log");
    await createFakeCommand(
      dir,
      "openclaw",
      `echo "$@" >> ${JSON.stringify(logPath)}
if [ "$1" = "--version" ]; then
  printf '2026.4.10'
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
    process.env.HOME = dir;
    process.env.NPM_CONFIG_USERCONFIG = join(dir, ".npmrc");

    const parsed = parseInstallArgv(["install", "--host", "openclaw", "--url", "wss://gateway.example.com/ws/agent"]);
    assert.ok(!("help" in parsed));
    const result = await createInstallCliUseCase({ qrcodeAuthRuntime: createFakeQrCodeRuntime("confirmed") }).execute(parsed);

    assert.equal(result.status, "success");
    assert.equal(io.stderr.join(""), "");
    assert.equal(
      normalizeQrBlock(io.stdout.join("")),
      `[skill-plugin-cli] 正在为 openclaw 安装 @wecode/skill-openclaw-plugin，请稍候
[skill-plugin-cli] openclaw 版本：2026.4.10
[skill-plugin-cli] openclaw 配置路径: ${join(dir, ".openclaw", "openclaw.json")}
[skill-plugin-cli] 插件安装完成
[skill-plugin-cli] 请使用 WeLink 扫码创建助理
<二维码渲染块>
[skill-plugin-cli] pc WeLink 创建助理地址: https://pc.example/qr-1
[skill-plugin-cli] 二维码有效期至: 2026-04-28 08:00:00 UTC
[skill-plugin-cli] 请在 WeLink 中创建助理
[skill-plugin-cli] 助理创建完成，正在写入 openclaw 连接配置
[skill-plugin-cli] 已完成连接可用性检查
[skill-plugin-cli] 接入完成：openclaw 已完成插件安装、助理创建与 gateway 配置
[skill-plugin-cli] 下一步：请手动重启 openclaw gateway 以使新配置生效
[skill-plugin-cli] 可执行命令：openclaw gateway restart
`,
    );
    const log = await readFile(logPath, "utf8");
    assert.match(log, /channels add --channel message-bridge --url wss:\/\/gateway\.example\.com\/ws\/agent --token ak-1 --password sk-1/);
  } finally {
    io.restore();
    process.env = originalEnv;
    await rm(dir, { recursive: true, force: true });
  }
});

test("default opencode success flow matches output spec", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-opencode-success-"));
  const originalEnv = { ...process.env };
  const io = captureIo();
  try {
    const configDir = join(dir, ".config", "opencode");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "opencode.json"), JSON.stringify({ plugin: ["@wecode/skill-opencode-plugin"] }, null, 2), "utf8");
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
    process.env.XDG_CONFIG_HOME = join(dir, ".config");
    process.env.NPM_CONFIG_USERCONFIG = join(dir, ".npmrc");

    const parsed = parseInstallArgv(["install", "--host", "opencode"]);
    assert.ok(!("help" in parsed));
    const result = await createInstallCliUseCase({ qrcodeAuthRuntime: createFakeQrCodeRuntime("confirmed") }).execute(parsed);

    assert.equal(result.status, "success");
    assert.equal(io.stderr.join(""), "");
    assert.equal(
      normalizeQrBlock(io.stdout.join("")),
      `[skill-plugin-cli] 正在为 opencode 安装 @wecode/skill-opencode-plugin，请稍候
[skill-plugin-cli] opencode 配置路径: ${join(configDir, "opencode.json")}
[skill-plugin-cli] 插件安装完成
[skill-plugin-cli] 请使用 WeLink 扫码创建助理
<二维码渲染块>
[skill-plugin-cli] pc WeLink 创建助理地址: https://pc.example/qr-1
[skill-plugin-cli] 二维码有效期至: 2026-04-28 08:00:00 UTC
[skill-plugin-cli] 请在 WeLink 中创建助理
[skill-plugin-cli] 助理创建完成，正在写入 opencode 连接配置
[skill-plugin-cli] 已完成连接可用性检查
[skill-plugin-cli] 接入完成：opencode 已完成插件安装、助理创建与 gateway 配置
[skill-plugin-cli] 下一步：请重启 opencode 以使插件与配置生效
`,
    );
    assert.doesNotMatch(io.stdout.join(""), /附加配置路径|message-bridge\.jsonc?/);
  } finally {
    io.restore();
    process.env = originalEnv;
    await rm(dir, { recursive: true, force: true });
  }
});

test("verbose mode adds stage logs and command boundaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-openclaw-verbose-"));
  const originalEnv = { ...process.env };
  const io = captureIo();
  try {
    await createFakeCommand(
      dir,
      "openclaw",
      `if [ "$1" = "--version" ]; then
  printf '2026.4.10'
  exit 0
fi
if [ "$1" = "plugins" ] && [ "$2" = "install" ]; then
  printf 'Installing plugin @wecode/skill-openclaw-plugin...\\nDone.\\n'
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
    process.env.HOME = dir;
    process.env.NPM_CONFIG_USERCONFIG = join(dir, ".npmrc");

    const parsed = parseInstallArgv(["install", "--host", "openclaw", "--verbose"]);
    assert.ok(!("help" in parsed));
    const result = await createInstallCliUseCase({ qrcodeAuthRuntime: createFakeQrCodeRuntime("confirmed") }).execute(parsed);

    assert.equal(result.status, "success");
    const output = io.stdout.join("");
    assert.match(output, /\[skill-plugin-cli\]\[openclaw\] 开始：解析安装参数/);
    assert.match(output, /完成：解析安装参数 · environment=prod, registry=/);
    assert.match(output, /\[skill-plugin-cli\]\[openclaw\] 开始：检查 openclaw 环境/);
    assert.match(output, /\[skill-plugin-cli\]\[openclaw\] 开始：安装插件 @wecode\/skill-openclaw-plugin/);
    assert.match(output, /\[skill-plugin-cli\] 正在执行命令：openclaw plugins install @wecode\/skill-openclaw-plugin/);
    assert.match(output, /Installing plugin @wecode\/skill-openclaw-plugin\.\.\.\nDone\./);
    assert.match(output, /\[skill-plugin-cli\] 命令执行结束：openclaw plugins install @wecode\/skill-openclaw-plugin/);
    assert.match(output, /\[skill-plugin-cli\]\[openclaw\] 开始：检查连接可用性/);
  } finally {
    io.restore();
    process.env = originalEnv;
    await rm(dir, { recursive: true, force: true });
  }
});

test("verbose opencode flow preserves additionalConfigPaths without changing default transcript", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-opencode-verbose-"));
  const originalEnv = { ...process.env };
  const io = captureIo();
  try {
    const configDir = join(dir, ".config", "opencode");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "opencode.json"), JSON.stringify({ plugin: ["@wecode/skill-opencode-plugin"] }, null, 2), "utf8");
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
    process.env.XDG_CONFIG_HOME = join(dir, ".config");
    process.env.NPM_CONFIG_USERCONFIG = join(dir, ".npmrc");

    const parsed = parseInstallArgv(["install", "--host", "opencode", "--verbose"]);
    assert.ok(!("help" in parsed));
    const result = await createInstallCliUseCase({ qrcodeAuthRuntime: createFakeQrCodeRuntime("confirmed") }).execute(parsed);

    assert.equal(result.status, "success");
    const output = io.stdout.join("");
    assert.match(output, /\[skill-plugin-cli\]\[opencode\] 开始：安装插件 @wecode\/skill-opencode-plugin/);
    assert.match(output, /\[skill-plugin-cli\]\[opencode\] 开始：检查 opencode 环境/);
    assert.match(output, /\[skill-plugin-cli\]\[opencode\] 开始：写入 opencode 连接配置/);
    assert.match(output, new RegExp(`完成：写入 opencode 连接配置 · additionalConfigPaths=${join(configDir, "message-bridge.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    io.restore();
    process.env = originalEnv;
    await rm(dir, { recursive: true, force: true });
  }
});

test("verbose install_plugin failure keeps packageName in failed stage label", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-openclaw-install-failed-"));
  const originalEnv = { ...process.env };
  const io = captureIo();
  try {
    await createFakeCommand(
      dir,
      "openclaw",
      `if [ "$1" = "--version" ]; then
  printf '2026.4.10'
  exit 0
fi
if [ "$1" = "plugins" ] && [ "$2" = "install" ]; then
  printf 'install failed' >&2
  exit 9
fi
exit 0`,
    );

    process.env.PATH = `${dir}${delimiter}${originalEnv.PATH || ""}`;
    process.env.HOME = dir;
    process.env.NPM_CONFIG_USERCONFIG = join(dir, ".npmrc");

    const parsed = parseInstallArgv(["install", "--host", "openclaw", "--verbose"]);
    assert.ok(!("help" in parsed));
    const result = await createInstallCliUseCase({ qrcodeAuthRuntime: createFakeQrCodeRuntime("confirmed") }).execute(parsed);

    assert.equal(result.status, "failed");
    assert.match(io.stderr.join(""), /\[skill-plugin-cli\] 失败：安装插件 @wecode\/skill-openclaw-plugin · openclaw plugins install @wecode\/skill-openclaw-plugin 失败，退出码 9/);
  } finally {
    io.restore();
    process.env = originalEnv;
    await rm(dir, { recursive: true, force: true });
  }
});

test("qrcode cancellation prints cancelled transcript", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-opencode-cancelled-"));
  const originalEnv = { ...process.env };
  const io = captureIo();
  try {
    const configDir = join(dir, ".config", "opencode");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "opencode.json"), JSON.stringify({ plugin: ["@wecode/skill-opencode-plugin"] }, null, 2), "utf8");
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
    process.env.XDG_CONFIG_HOME = join(dir, ".config");
    process.env.NPM_CONFIG_USERCONFIG = join(dir, ".npmrc");

    const parsed = parseInstallArgv(["install", "--host", "opencode"]);
    assert.ok(!("help" in parsed));
    const result = await createInstallCliUseCase({ qrcodeAuthRuntime: createFakeQrCodeRuntime("cancelled") }).execute(parsed);

    assert.equal(result.status, "cancelled");
    assert.match(io.stderr.join(""), /\[skill-plugin-cli\] 接入已取消：WeLink 创建助理已取消/);
  } finally {
    io.restore();
    process.env = originalEnv;
    await rm(dir, { recursive: true, force: true });
  }
});

test("qrcode network failure prints structured summary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-opencode-network-error-"));
  const originalEnv = { ...process.env };
  const io = captureIo();
  try {
    const configDir = join(dir, ".config", "opencode");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "opencode.json"), JSON.stringify({ plugin: ["@wecode/skill-opencode-plugin"] }, null, 2), "utf8");
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
    process.env.XDG_CONFIG_HOME = join(dir, ".config");
    process.env.NPM_CONFIG_USERCONFIG = join(dir, ".npmrc");

    const parsed = parseInstallArgv(["install", "--host", "opencode"]);
    assert.ok(!("help" in parsed));
    const result = await createInstallCliUseCase({ qrcodeAuthRuntime: createFakeQrCodeRuntime("network_error") }).execute(parsed);

    assert.equal(result.status, "failed");
    assert.equal(
      io.stderr.join(""),
      "[skill-plugin-cli] 接入失败：无法连接 WeLink 创建助理服务\n"
        + "[skill-plugin-cli] 错误摘要：network_error, code=ECONNREFUSED, message=connect ECONNREFUSED 127.0.0.1:443\n",
    );
  } finally {
    io.restore();
    process.env = originalEnv;
    await rm(dir, { recursive: true, force: true });
  }
});

test("qrcode refresh prints refreshed qrcode transcript", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-openclaw-refresh-"));
  const originalEnv = { ...process.env };
  const io = captureIo();
  try {
    await createFakeCommand(
      dir,
      "openclaw",
      `if [ "$1" = "--version" ]; then
  printf '2026.4.10'
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
    process.env.HOME = dir;
    process.env.NPM_CONFIG_USERCONFIG = join(dir, ".npmrc");

    const parsed = parseInstallArgv(["install", "--host", "openclaw"]);
    assert.ok(!("help" in parsed));
    const result = await createInstallCliUseCase({ qrcodeAuthRuntime: createFakeQrCodeRuntime("refresh") }).execute(parsed);

    assert.equal(result.status, "success");
    const output = io.stdout.join("");
    assert.match(output, /\[skill-plugin-cli\] 二维码已过期，正在刷新/);
    assert.match(output, /\[skill-plugin-cli\] ========= 已刷新二维码（第 1\/3 次） =========/);
    assert.match(output, /\[skill-plugin-cli\] pc WeLink 创建助理地址: https:\/\/pc\.example\/qr-2/);
    assert.match(output, /\[skill-plugin-cli\] 二维码有效期至: 2026-04-28 08:05:00 UTC/);
  } finally {
    io.restore();
    process.env = originalEnv;
    await rm(dir, { recursive: true, force: true });
  }
});

test("openclaw version unsupported prints version before failure without config path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-openclaw-version-unsupported-"));
  const originalEnv = { ...process.env };
  const io = captureIo();
  try {
    await createFakeCommand(
      dir,
      "openclaw",
      `if [ "$1" = "--version" ]; then
  printf '2026.3.01'
  exit 0
fi
exit 0`,
    );

    process.env.PATH = `${dir}${delimiter}${originalEnv.PATH || ""}`;
    process.env.HOME = dir;
    process.env.NPM_CONFIG_USERCONFIG = join(dir, ".npmrc");

    const parsed = parseInstallArgv(["install", "--host", "openclaw"]);
    assert.ok(!("help" in parsed));
    const result = await createInstallCliUseCase({ qrcodeAuthRuntime: createFakeQrCodeRuntime("confirmed") }).execute(parsed);

    assert.equal(result.status, "failed");
    assert.equal(
      io.stdout.join(""),
      "[skill-plugin-cli] 正在为 openclaw 安装 @wecode/skill-openclaw-plugin，请稍候\n"
        + "[skill-plugin-cli] openclaw 版本：2026.3.01\n",
    );
    assert.equal(
      io.stderr.join(""),
      "[skill-plugin-cli] 接入失败：当前 openclaw 版本 2026.3.01 不满足 >= 2026.3.24\n",
    );
    assert.doesNotMatch(io.stdout.join(""), /openclaw 配置路径/);
  } finally {
    io.restore();
    process.env = originalEnv;
    await rm(dir, { recursive: true, force: true });
  }
});

test("verbose openclaw version unsupported does not emit succeeded environment stage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-openclaw-version-unsupported-verbose-"));
  const originalEnv = { ...process.env };
  const io = captureIo();
  try {
    await createFakeCommand(
      dir,
      "openclaw",
      `if [ "$1" = "--version" ]; then
  printf '2026.3.01'
  exit 0
fi
exit 0`,
    );

    process.env.PATH = `${dir}${delimiter}${originalEnv.PATH || ""}`;
    process.env.HOME = dir;
    process.env.NPM_CONFIG_USERCONFIG = join(dir, ".npmrc");

    const parsed = parseInstallArgv(["install", "--host", "openclaw", "--verbose"]);
    assert.ok(!("help" in parsed));
    const result = await createInstallCliUseCase({ qrcodeAuthRuntime: createFakeQrCodeRuntime("confirmed") }).execute(parsed);

    assert.equal(result.status, "failed");
    const stdout = io.stdout.join("");
    const stderr = io.stderr.join("");
    assert.match(stdout, /\[skill-plugin-cli\]\[openclaw\] 开始：检查 openclaw 环境/);
    assert.doesNotMatch(stdout, /完成：检查 openclaw 环境/);
    assert.match(stderr, /\[skill-plugin-cli\] 失败：检查 openclaw 环境 · 当前 openclaw 版本 2026\.3\.01 不满足 >= 2026\.3\.24/);
  } finally {
    io.restore();
    process.env = originalEnv;
    await rm(dir, { recursive: true, force: true });
  }
});
