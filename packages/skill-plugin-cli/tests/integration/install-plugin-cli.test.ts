import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";
import test from "node:test";
import { parseInstallArgv } from "../../src/cli/parse-argv.ts";
import { createInstallCliUseCase } from "../../src/cli/runtime.ts";
import type { QrCodeAuthRuntime } from "../../src/domain/qrcode-types.ts";

const requireFromHere = createRequire(import.meta.url);
const tarModulePath = requireFromHere.resolve("tar");

function createFakeQrCodeRuntime(scenario: "confirmed" | "cancelled"): QrCodeAuthRuntime {
  return {
    async run(input) {
      input.onSnapshot({
        type: "qrcode_generated",
        qrcode: "qr-1",
        display: {
          qrcode: "qr-1",
          weUrl: "https://we.example/qr-1",
          pcUrl: "https://pc.example/qr-1",
        },
        expiresAt: "2026-04-28T00:00:00.000Z",
      });
      if (scenario === "confirmed") {
        input.onSnapshot({ type: "confirmed", qrcode: "qr-1", credentials: { ak: "ak-1", sk: "sk-1" } });
        return;
      }
      input.onSnapshot({ type: "cancelled", qrcode: "qr-1" });
    },
  };
}

async function createExecutable(dir: string, name: string, source: string) {
  const scriptPath = join(dir, name);
  await writeFile(scriptPath, `#!/usr/bin/env node\n${source}\n`, "utf8");
  await chmod(scriptPath, 0o755);
  if (process.platform === "win32") {
    await writeFile(
      join(dir, `${name}.cmd`),
      `@echo off\r\nnode "%~dp0${name}" %*\r\n`,
      "utf8",
    );
  }
  return process.platform === "win32" ? join(dir, `${name}.cmd`) : scriptPath;
}

async function createFakePackageSource(root: string, packageName: string, options: { openclaw?: boolean } = {}) {
  const packageDir = join(root, packageName, "package");
  await mkdir(join(packageDir, "dist"), { recursive: true });
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({ name: packageName, version: "1.2.3", main: "dist/index.js" }, null, 2),
    "utf8",
  );
  await writeFile(join(packageDir, "dist/index.js"), "export default 1;\n", "utf8");
  if (options.openclaw) {
    await writeFile(join(packageDir, "openclaw.plugin.json"), JSON.stringify({ id: "skill-openclaw-plugin" }), "utf8");
  }
}

function toJs(value: unknown) {
  return JSON.stringify(value);
}

async function createFakeNpm(dir: string, sourceRoot: string, logPath: string) {
  await createExecutable(
    dir,
    "npm",
    `
const fs = require("node:fs");
const path = require("node:path");
const tar = require(${toJs(tarModulePath)});
const args = process.argv.slice(2);
fs.appendFileSync(${toJs(logPath)}, \`\${args.join(" ")}\\n\`);
if (args[0] === "view") {
  process.stdout.write("1.2.3\\n");
  process.exit(0);
}
if (args[0] === "pack") {
  const spec = args[1];
  const destination = args[args.indexOf("--pack-destination") + 1];
  const separatorIndex = spec.lastIndexOf("@");
  const pkg = spec.slice(0, separatorIndex);
  const version = spec.slice(separatorIndex + 1);
  fs.mkdirSync(destination, { recursive: true });
  const packageRoot = path.join(${toJs(sourceRoot)}, pkg);
  const safeName = pkg.replaceAll("@", "").replaceAll("/", "-");
  const tarball = \`\${safeName}-\${version}.tgz\`;
  tar.create({ cwd: packageRoot, file: path.join(destination, tarball), gzip: true }, ["package"])
    .then(() => {
      process.stdout.write(\`\${tarball}\\n\`);
      process.exit(0);
    })
    .catch((error) => {
      process.stderr.write(error instanceof Error ? error.message : String(error));
      process.exit(8);
    });
  return;
}
process.stderr.write("unsupported npm command");
process.exit(9);
`,
  );
}

async function createFakeOpenClaw(dir: string, logPath: string, options: { installExitCode?: number; installStderr?: string } = {}) {
  await createExecutable(
    dir,
    "openclaw",
    `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${toJs(logPath)}, \`\${args.join(" ")}\\n\`);
if (args[0] === "--version") {
  process.stdout.write("2026.3.24");
  process.exit(0);
}
if (args[0] === "plugins" && args[1] === "install") {
  if (${toJs(options.installStderr || "")}) {
    process.stderr.write(${toJs(options.installStderr || "")});
  }
  process.exit(${options.installExitCode ?? 0});
}
if (args[0] === "plugins" && args[1] === "info") {
  process.stdout.write('{"id":"skill-openclaw-plugin","channelIds":["message-bridge"]}');
  process.exit(0);
}
if (args[0] === "channels" && args[1] === "add") {
  process.exit(0);
}
if (args[0] === "channels" && args[1] === "status") {
  process.stdout.write('{"state":"ready"}');
  process.exit(0);
}
process.exit(0);
`,
  );
}

async function createFakeOpencode(dir: string) {
  await createExecutable(
    dir,
    "opencode",
    `
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("1.0.0");
  process.exit(0);
}
if (args[0] === "plugin") {
  process.exit(0);
}
process.exit(0);
`,
  );
}

async function withCapturedOutput<T>(fn: (stdout: string[], stderr: string[]) => Promise<T>) {
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
  try {
    return await fn(stdout, stderr);
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

test("integration fake commands remain runnable on current platform", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-exec-"));
  try {
    const createdPath = await createExecutable(dir, "echo-platform", "process.stdout.write(process.argv[2] || '');");
    if (process.platform === "win32") {
      assert.match(createdPath, /\.cmd$/);
    } else {
      assert.doesNotMatch(createdPath, /\.cmd$/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("direct use case completes openclaw host-native install", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-openclaw-host-native-"));
  const originalEnv = { ...process.env };
  try {
    const logPath = join(dir, "openclaw.log");
    await createFakeOpenClaw(dir, logPath);

    process.env.PATH = `${dir}${delimiter}${originalEnv.PATH || ""}`;
    process.env.NPM_CONFIG_USERCONFIG = join(dir, ".npmrc");

    await withCapturedOutput(async (stdout, stderr) => {
      const parsed = parseInstallArgv(["install", "--host", "openclaw", "--url", "wss://gateway.example.com/ws/agent"]);
      assert.ok(!("help" in parsed));
      const result = await createInstallCliUseCase({ qrcodeAuthRuntime: createFakeQrCodeRuntime("confirmed") }).execute(parsed);
      assert.equal(result.status, "success");
      assert.deepEqual(result.warningMessages, []);
      assert.match(stdout.join(""), /当前安装策略：host-native/);
      assert.doesNotMatch(stdout.join(""), /fallback 产物已解析/);
      assert.equal(stderr.length, 0);
    });

    const log = await readFile(logPath, "utf8");
    assert.match(log, /plugins install @wecode\/skill-openclaw-plugin/);
    assert.match(log, /channels add --channel message-bridge --url wss:\/\/gateway\.example\.com\/ws\/agent --token ak-1 --password sk-1/);
  } finally {
    process.env = originalEnv;
    await rm(dir, { recursive: true, force: true });
  }
});

test("direct use case completes openclaw fallback install via npm pack and local tgz", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-openclaw-fallback-"));
  const originalEnv = { ...process.env };
  try {
    const openclawLogPath = join(dir, "openclaw.log");
    const npmLogPath = join(dir, "npm.log");
    await createFakePackageSource(join(dir, "packages"), "@wecode/skill-openclaw-plugin", { openclaw: true });
    await createFakeNpm(dir, join(dir, "packages"), npmLogPath);
    await createFakeOpenClaw(dir, openclawLogPath);

    process.env.PATH = `${dir}${delimiter}${originalEnv.PATH || ""}`;
    process.env.NPM_CONFIG_USERCONFIG = join(dir, ".npmrc");
    process.env.HOME = dir;

    await withCapturedOutput(async (stdout) => {
      const parsed = parseInstallArgv(["install", "--host", "openclaw", "--install-strategy", "fallback"]);
      assert.ok(!("help" in parsed));
      const result = await createInstallCliUseCase({ qrcodeAuthRuntime: createFakeQrCodeRuntime("confirmed") }).execute(parsed);
      assert.equal(result.status, "success");
      assert.match(stdout.join(""), /fallback 产物已解析：package=@wecode\/skill-openclaw-plugin version=1.2.3/);
    });

    const npmLog = await readFile(npmLogPath, "utf8");
    const openclawLog = await readFile(openclawLogPath, "utf8");
    assert.match(npmLog, /view @wecode\/skill-openclaw-plugin version --registry https?:\/\/\S+/);
    assert.match(npmLog, /pack @wecode\/skill-openclaw-plugin@1.2.3 --pack-destination/);
    assert.match(openclawLog, /plugins install .*\.tgz/);
    assert.match(openclawLog, /plugins info skill-openclaw-plugin --json/);
  } finally {
    process.env = originalEnv;
    await rm(dir, { recursive: true, force: true });
  }
});

test("direct use case completes opencode fallback install and writes local plugin spec", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-opencode-fallback-"));
  const originalEnv = { ...process.env };
  try {
    const npmLogPath = join(dir, "npm.log");
    const configDir = join(dir, ".config", "opencode");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "opencode.json"),
      JSON.stringify({ plugin: ["other-plugin", "@wecode/skill-opencode-plugin"] }, null, 2),
      "utf8",
    );
    await createFakePackageSource(join(dir, "packages"), "@wecode/skill-opencode-plugin");
    await createFakeNpm(dir, join(dir, "packages"), npmLogPath);
    await createFakeOpencode(dir);

    process.env.PATH = `${dir}${delimiter}${originalEnv.PATH || ""}`;
    process.env.NPM_CONFIG_USERCONFIG = join(dir, ".npmrc");
    process.env.XDG_CONFIG_HOME = join(dir, ".config");
    process.env.HOME = dir;

    await withCapturedOutput(async (stdout) => {
      const parsed = parseInstallArgv(["install", "--host", "opencode", "--install-strategy", "fallback"]);
      assert.ok(!("help" in parsed));
      const result = await createInstallCliUseCase({ qrcodeAuthRuntime: createFakeQrCodeRuntime("confirmed") }).execute(parsed);
      assert.equal(result.status, "success");
      assert.match(stdout.join(""), /fallback 已写入宿主目标：pluginSpec=/);
    });

    const opencodeConfig = await readFile(join(configDir, "opencode.json"), "utf8");
    const npmLog = await readFile(npmLogPath, "utf8");
    assert.match(npmLog, /view @wecode\/skill-opencode-plugin version --registry https?:\/\/\S+/);
    assert.match(opencodeConfig, /other-plugin/);
    assert.match(opencodeConfig, /skill-plugin-cli\/opencode\/extracted/);
    assert.doesNotMatch(opencodeConfig, /"@wecode\/skill-opencode-plugin"/);
  } finally {
    process.env = originalEnv;
    await rm(dir, { recursive: true, force: true });
  }
});

test("direct use case succeeds with opencode cleanup warning when legacy path cannot be removed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-opencode-cleanup-warning-"));
  const originalEnv = { ...process.env };
  try {
    const configDir = join(dir, ".config", "opencode");
    await mkdir(join(configDir, "plugins", "message-bridge.js"), { recursive: true });
    await writeFile(
      join(configDir, "opencode.json"),
      JSON.stringify({ plugin: ["@wecode/skill-opencode-plugin"] }, null, 2),
      "utf8",
    );
    await createFakeOpencode(dir);

    process.env.PATH = `${dir}${delimiter}${originalEnv.PATH || ""}`;
    process.env.NPM_CONFIG_USERCONFIG = join(dir, ".npmrc");
    process.env.XDG_CONFIG_HOME = join(dir, ".config");

    await withCapturedOutput(async (stdout) => {
      const parsed = parseInstallArgv(["install", "--host", "opencode"]);
      assert.ok(!("help" in parsed));
      const result = await createInstallCliUseCase({ qrcodeAuthRuntime: createFakeQrCodeRuntime("confirmed") }).execute(parsed);
      assert.equal(result.status, "success");
      assert.equal(result.warningMessages.length, 1);
      assert.match(result.warningMessages[0], /请手动删除/);
      assert.match(stdout.join(""), /\[warning\]/);
    });
  } finally {
    process.env = originalEnv;
    await rm(dir, { recursive: true, force: true });
  }
});

test("direct use case fails host-native install without auto-switching to fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-openclaw-install-failed-"));
  const originalEnv = { ...process.env };
  try {
    const openclawLogPath = join(dir, "openclaw.log");
    await createFakeOpenClaw(dir, openclawLogPath, {
      installExitCode: 9,
      installStderr: "native install failed",
    });

    process.env.PATH = `${dir}${delimiter}${originalEnv.PATH || ""}`;
    process.env.NPM_CONFIG_USERCONFIG = join(dir, ".npmrc");

    await withCapturedOutput(async (stdout, stderr) => {
      const parsed = parseInstallArgv(["install", "--host", "openclaw"]);
      assert.ok(!("help" in parsed));
      const result = await createInstallCliUseCase({ qrcodeAuthRuntime: createFakeQrCodeRuntime("confirmed") }).execute(parsed);
      assert.equal(result.status, "failed");
      assert.doesNotMatch(stdout.join(""), /--install-strategy fallback/);
      assert.match(stderr.join(""), /安装失败/);
    });

    const openclawLog = await readFile(openclawLogPath, "utf8");
    assert.match(openclawLog, /plugins install @wecode\/skill-openclaw-plugin/);
    assert.doesNotMatch(openclawLog, /\.tgz/);
  } finally {
    process.env = originalEnv;
    await rm(dir, { recursive: true, force: true });
  }
});

test("direct use case returns cancelled when opencode qrcode flow is cancelled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-opencode-cancelled-"));
  const originalEnv = { ...process.env };
  try {
    const configDir = join(dir, ".config", "opencode");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "opencode.json"),
      JSON.stringify({ plugin: ["@wecode/skill-opencode-plugin"] }, null, 2),
      "utf8",
    );
    await createFakeOpencode(dir);

    process.env.PATH = `${dir}${delimiter}${originalEnv.PATH || ""}`;
    process.env.NPM_CONFIG_USERCONFIG = join(dir, ".npmrc");
    process.env.XDG_CONFIG_HOME = join(dir, ".config");

    const parsed = parseInstallArgv(["install", "--host", "opencode"]);
    assert.ok(!("help" in parsed));
    const result = await createInstallCliUseCase({ qrcodeAuthRuntime: createFakeQrCodeRuntime("cancelled") }).execute(parsed);
    assert.equal(result.status, "cancelled");
  } finally {
    process.env = originalEnv;
    await rm(dir, { recursive: true, force: true });
  }
});
