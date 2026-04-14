import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const scriptPath = path.resolve("scripts/install-openclaw-plugin.mjs");
const packageManifest = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
const defaultOpenclawVersion = packageManifest.peerDependencies.openclaw.replace(/^>=/, "");

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "openclaw-install-cli-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function createFakeOpenclaw(dir) {
  const script = path.join(dir, "fake-openclaw.mjs");
  await writeFile(
    script,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const logFile = process.env.FAKE_OPENCLAW_LOG;
const failStep = process.env.FAKE_OPENCLAW_FAIL_STEP || "";
const pluginInfo = process.env.FAKE_OPENCLAW_PLUGIN_INFO || JSON.stringify({ id: "skill-openclaw-plugin", channelIds: ["message-bridge"] });
appendFileSync(logFile, JSON.stringify(args) + "\\n");

if (args[0] === "--version") {
  process.stdout.write(process.env.FAKE_OPENCLAW_VERSION || ${JSON.stringify(defaultOpenclawVersion)});
  process.exit(0);
}

const filtered = args[0] === "--dev" ? args.slice(1) : args;
const step = filtered.slice(0, 2).join(" ");

if (step === "plugins install") {
  process.stdout.write("Downloading package...\\n");
  if (failStep === "plugins-install") {
    process.stderr.write("install failed\\n");
    process.exit(11);
  }
  process.stdout.write("Install done\\n");
  process.exit(0);
}

if (step === "plugins info") {
  if (failStep === "plugins-info") {
    process.stderr.write("info failed\\n");
    process.exit(12);
  }
  process.stdout.write(pluginInfo);
  process.exit(0);
}

if (step === "channels add") {
  if (failStep === "channels-add") {
    process.stderr.write("channel add failed\\n");
    process.exit(13);
  }
  process.stdout.write("channel added\\n");
  process.exit(0);
}

if (step === "gateway restart") {
  if (failStep === "gateway-restart") {
    process.stderr.write("restart failed\\n");
    process.exit(14);
  }
  process.stdout.write("gateway restarted\\n");
  process.exit(0);
}

process.stderr.write("unexpected args:" + JSON.stringify(args) + "\\n");
process.exit(99);
`,
    "utf8",
  );
  await chmod(script, 0o755);
  return script;
}

async function createWin32ShimHarness(dir, openclawPath, { includeBareOpenclaw = true } = {}) {
  const pathBinDir = path.join(dir, "path-bin");
  const targetDir = path.join(dir, "resolved-openclaw");
  await mkdir(pathBinDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });

  const wherePath = path.join(pathBinDir, "where.exe");
  const cmdPath = path.join(pathBinDir, "cmd.exe");
  const cmdProxyPath = path.join(dir, "cmd-proxy.mjs");
  const platformShimPath = path.join(dir, "mock-win32-platform.mjs");
  const openclawPathWithoutExt = path.join(targetDir, "openclaw");
  const openclawCmdPath = path.join(targetDir, "openclaw.cmd");

  await writeFile(
    platformShimPath,
    `Object.defineProperty(process, "platform", { value: "win32" });\n`,
    "utf8",
  );
  await writeFile(
    wherePath,
    `#!/bin/sh
printf '%s\\n' "${openclawPathWithoutExt}" "${openclawCmdPath}"
`,
    "utf8",
  );
  await writeFile(
    cmdProxyPath,
    `#!/usr/bin/env node
import { spawnSync } from "node:child_process";

function parseCommandString(command) {
  const parts = [];
  const pattern = /"((?:[^"]|"")*)"|([^\\s]+)/g;
  let match;
  while ((match = pattern.exec(command)) !== null) {
    if (match[1] !== undefined) {
      parts.push(match[1].replace(/""/g, '"'));
    } else if (match[2] !== undefined) {
      parts.push(match[2]);
    }
  }
  return parts
    .map((part) => part.replace(/^"+|"+$/g, ""))
    .filter(Boolean);
}

const args = process.argv.slice(2);
const markerIndex = args.findIndex((value) => value.toLowerCase() === "/c");
if (markerIndex < 0 || markerIndex === args.length - 1) {
  process.exit(1);
}

const parsed = parseCommandString(args.slice(markerIndex + 1).join(" "));
if (parsed.length === 0) {
  process.exit(1);
}

const result = spawnSync(parsed[0], parsed.slice(1), {
  env: process.env,
  encoding: "utf8",
  stdio: "pipe",
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 0);
`,
    "utf8",
  );
  await writeFile(
    cmdPath,
    `#!/bin/sh
exec ${JSON.stringify(process.execPath)} "${cmdProxyPath}" "$@"
`,
    "utf8",
  );
  await writeFile(
    openclawCmdPath,
    `#!/bin/sh
exec ${JSON.stringify(process.execPath)} "${openclawPath}" "$@"
`,
    "utf8",
  );
  await chmod(wherePath, 0o755);
  await chmod(cmdProxyPath, 0o755);
  await chmod(cmdPath, 0o755);
  await chmod(openclawCmdPath, 0o755);

  if (includeBareOpenclaw) {
    await writeFile(
      openclawPathWithoutExt,
      `#!/bin/sh
exec ${JSON.stringify(process.execPath)} "${openclawPath}" "$@"
`,
      "utf8",
    );
    await chmod(openclawPathWithoutExt, 0o755);
  }

  return {
    nodeOptions: `--import ${platformShimPath}`,
    prependPath: `${targetDir}${path.delimiter}${pathBinDir}${path.delimiter}/usr/bin${path.delimiter}/bin`,
  };
}

function runInstaller({ cwd, home, openclawBin = "", extraArgs = [], extraEnv = {}, prependPath = "" }) {
  const cliArgs = [scriptPath];
  if (openclawBin) {
    cliArgs.push("--openclaw-bin", openclawBin);
  }
  cliArgs.push(...extraArgs);

  return spawnSync(process.execPath, cliArgs, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      PATH: prependPath || process.env.PATH,
      ...extraEnv,
    },
  });
}

async function readLoggedCommands(logFile) {
  const content = await readFile(logFile, "utf8");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("installer runs preflight, install, verify, configure, and restart with non-interactive args", async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, "home");
    const logFile = path.join(dir, "openclaw.log");
    const fakeOpenclaw = await createFakeOpenclaw(dir);
    const result = runInstaller({
      cwd: process.cwd(),
      home,
      openclawBin: fakeOpenclaw,
      extraArgs: [
        "--dev",
        "--url",
        "ws://127.0.0.1:8081/ws/agent",
        "--token",
        "ak-test",
        "--password",
        "sk-test",
        "--name",
        "Primary bridge",
      ],
      extraEnv: {
        FAKE_OPENCLAW_LOG: logFile,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const commands = await readLoggedCommands(logFile);
    assert.deepEqual(commands, [
      ["--version"],
      ["--dev", "plugins", "install", "@wecode/skill-openclaw-plugin"],
      ["--dev", "plugins", "info", "skill-openclaw-plugin", "--json"],
      [
        "--dev",
        "channels",
        "add",
        "--channel",
        "message-bridge",
        "--url",
        "ws://127.0.0.1:8081/ws/agent",
        "--token",
        "ak-test",
        "--password",
        "sk-test",
        "--name",
        "Primary bridge",
      ],
      ["--dev", "gateway", "restart"],
    ]);

    const npmrc = await readFile(path.join(home, ".npmrc"), "utf8");
    assert.ok(npmrc.includes("@wecode:registry=https://cmc.centralrepo.rnd.huawei.com/artifactory/api/npm/product_npm/"));
    assert.ok(result.stdout.includes("[skill-openclaw-plugin] 正在检查 OpenClaw 环境"));
    assert.ok(result.stdout.includes("正在通过 OpenClaw 安装 skill-openclaw-plugin 插件"));
    assert.ok(result.stdout.includes("Downloading package..."));
    assert.ok(result.stdout.includes("skill-openclaw-plugin 插件安装校验通过"));
    assert.ok(result.stdout.includes("正在重启 OpenClaw gateway"));
  });
});

test("installer rewrites existing scoped registry to the fixed default registry", async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, "home");
    const logFile = path.join(dir, "openclaw.log");
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, ".npmrc"), "@wecode:registry=https://old.registry/\n", "utf8");
    const fakeOpenclaw = await createFakeOpenclaw(dir);
    const result = runInstaller({
      cwd: process.cwd(),
      home,
      openclawBin: fakeOpenclaw,
      extraArgs: [
        "--url",
        "ws://127.0.0.1:8081/ws/agent",
        "--token",
        "ak-test",
        "--password",
        "sk-test",
      ],
      extraEnv: {
        FAKE_OPENCLAW_LOG: logFile,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const npmrc = await readFile(path.join(home, ".npmrc"), "utf8");
    assert.ok(npmrc.includes("@wecode:registry=https://cmc.centralrepo.rnd.huawei.com/artifactory/api/npm/product_npm/"));
    assert.ok(!npmrc.includes("@wecode:registry=https://old.registry/"));
  });
});

test("installer falls back to interactive channels add when non-interactive args are incomplete", async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, "home");
    const logFile = path.join(dir, "openclaw.log");
    const fakeOpenclaw = await createFakeOpenclaw(dir);
    const result = runInstaller({
      cwd: process.cwd(),
      home,
      openclawBin: fakeOpenclaw,
      extraArgs: ["--url", "ws://127.0.0.1:8081/ws/agent"],
      extraEnv: {
        FAKE_OPENCLAW_LOG: logFile,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const commands = await readLoggedCommands(logFile);
    assert.deepEqual(commands[3], ["channels", "add", "--channel", "message-bridge"]);
  });
});

test("installer skips restart only when --no-restart is passed", async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, "home");
    const logFile = path.join(dir, "openclaw.log");
    const fakeOpenclaw = await createFakeOpenclaw(dir);
    const result = runInstaller({
      cwd: process.cwd(),
      home,
      openclawBin: fakeOpenclaw,
      extraArgs: [
        "--url",
        "ws://127.0.0.1:8081/ws/agent",
        "--token",
        "ak-test",
        "--password",
        "sk-test",
        "--no-restart",
      ],
      extraEnv: {
        FAKE_OPENCLAW_LOG: logFile,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const commands = await readLoggedCommands(logFile);
    assert.equal(commands.some((command) => command.join(" ") === "gateway restart"), false);
  });
});

test("installer stops immediately when plugin install fails", async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, "home");
    const logFile = path.join(dir, "openclaw.log");
    const fakeOpenclaw = await createFakeOpenclaw(dir);
    const result = runInstaller({
      cwd: process.cwd(),
      home,
      openclawBin: fakeOpenclaw,
      extraArgs: [],
      extraEnv: {
        FAKE_OPENCLAW_LOG: logFile,
        FAKE_OPENCLAW_FAIL_STEP: "plugins-install",
      },
    });

    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes("error_code=PLUGIN_INSTALL_FAILED"));
    assert.match(
      result.stderr,
      /plugins install @wecode\/skill-openclaw-plugin failed with code 11/,
    );
    assert.equal(result.stderr.includes("Downloading package..."), false);
    assert.equal((result.stderr.match(/install failed/g) ?? []).length, 1);
    const commands = await readLoggedCommands(logFile);
    assert.deepEqual(commands, [
      ["--version"],
      ["plugins", "install", "@wecode/skill-openclaw-plugin"],
    ]);
  });
});

test("installer stops when plugin verification fails", async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, "home");
    const logFile = path.join(dir, "openclaw.log");
    const fakeOpenclaw = await createFakeOpenclaw(dir);
    const result = runInstaller({
      cwd: process.cwd(),
      home,
      openclawBin: fakeOpenclaw,
      extraArgs: [],
      extraEnv: {
        FAKE_OPENCLAW_LOG: logFile,
        FAKE_OPENCLAW_PLUGIN_INFO: JSON.stringify({ id: "wrong", channelIds: [] }),
      },
    });

    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes("error_code=PLUGIN_INSTALL_VERIFICATION_FAILED"));
    const commands = await readLoggedCommands(logFile);
    assert.deepEqual(commands, [
      ["--version"],
      ["plugins", "install", "@wecode/skill-openclaw-plugin"],
      ["plugins", "info", "skill-openclaw-plugin", "--json"],
    ]);
  });
});

test("installer stops when channels add fails", async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, "home");
    const logFile = path.join(dir, "openclaw.log");
    const fakeOpenclaw = await createFakeOpenclaw(dir);
    const result = runInstaller({
      cwd: process.cwd(),
      home,
      openclawBin: fakeOpenclaw,
      extraArgs: [
        "--url",
        "ws://127.0.0.1:8081/ws/agent",
        "--token",
        "ak-test",
        "--password",
        "sk-test",
      ],
      extraEnv: {
        FAKE_OPENCLAW_LOG: logFile,
        FAKE_OPENCLAW_FAIL_STEP: "channels-add",
      },
    });

    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes("error_code=CHANNEL_ADD_FAILED"));
    const commands = await readLoggedCommands(logFile);
    assert.equal(commands.at(-1)[0], "channels");
  });
});

test("installer stops when gateway restart fails", async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, "home");
    const logFile = path.join(dir, "openclaw.log");
    const fakeOpenclaw = await createFakeOpenclaw(dir);
    const result = runInstaller({
      cwd: process.cwd(),
      home,
      openclawBin: fakeOpenclaw,
      extraArgs: [
        "--url",
        "ws://127.0.0.1:8081/ws/agent",
        "--token",
        "ak-test",
        "--password",
        "sk-test",
      ],
      extraEnv: {
        FAKE_OPENCLAW_LOG: logFile,
        FAKE_OPENCLAW_FAIL_STEP: "gateway-restart",
      },
    });

    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes("error_code=GATEWAY_RESTART_FAILED"));
    const commands = await readLoggedCommands(logFile);
    assert.equal(commands.at(-1).join(" "), "gateway restart");
  });
});

test("installer on simulated win32 detects openclaw via where.exe and reuses openclaw.cmd", async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, "home");
    const tempDir = path.join(dir, "temp");
    const logFile = path.join(dir, "openclaw.log");
    await mkdir(tempDir, { recursive: true });
    const fakeOpenclaw = await createFakeOpenclaw(dir);
    const shimHarness = await createWin32ShimHarness(dir, fakeOpenclaw, {
      includeBareOpenclaw: false,
    });
    const result = runInstaller({
      cwd: process.cwd(),
      home,
      extraArgs: [
        "--url",
        "ws://127.0.0.1:8081/ws/agent",
        "--token",
        "ak-test",
        "--password",
        "sk-test",
      ],
      prependPath: shimHarness.prependPath,
      extraEnv: {
        FAKE_OPENCLAW_LOG: logFile,
        NODE_OPTIONS: shimHarness.nodeOptions,
        TEMP: tempDir,
        TMP: tempDir,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes("Windows 环境通过 where.exe 检测到 openclaw shim"));
    assert.ok(result.stdout.includes("openclaw.cmd"));

    const commands = await readLoggedCommands(logFile);
    assert.deepEqual(commands, [
      ["--version"],
      ["plugins", "install", "@wecode/skill-openclaw-plugin"],
      ["plugins", "info", "skill-openclaw-plugin", "--json"],
      [
        "channels",
        "add",
        "--channel",
        "message-bridge",
        "--url",
        "ws://127.0.0.1:8081/ws/agent",
        "--token",
        "ak-test",
        "--password",
        "sk-test",
      ],
      ["gateway", "restart"],
    ]);
    assert.match(result.stdout, /已检测到 OpenClaw: .*openclaw\.cmd/);
    assert.match(result.stdout, /建议执行: .*openclaw\.cmd channels status --channel message-bridge --probe --json/);
  });
});
