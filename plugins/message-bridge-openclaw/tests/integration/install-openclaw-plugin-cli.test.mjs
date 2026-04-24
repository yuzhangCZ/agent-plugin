import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const scriptPath = path.resolve("scripts/install-openclaw-plugin.mjs");
const packageManifest = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
const defaultOpenclawVersion = packageManifest.peerDependencies.openclaw.replace(/^>=/, "");
const shadowPackageRoot = path.resolve("node_modules/@wecode/skill-qrcode-auth");
const shadowPackageParent = path.resolve("node_modules/@wecode");

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
const installOutputHex = process.env.FAKE_OPENCLAW_INSTALL_OUTPUT_HEX || "";
appendFileSync(logFile, JSON.stringify(args) + "\\n");

if (args[0] === "--version") {
  process.stdout.write(process.env.FAKE_OPENCLAW_VERSION || ${JSON.stringify(defaultOpenclawVersion)});
  process.exit(0);
}

const filtered = args[0] === "--dev" ? args.slice(1) : args;
const step = filtered.slice(0, 2).join(" ");

if (step === "plugins install") {
  if (installOutputHex) {
    process.stdout.write(Buffer.from(installOutputHex, "hex"));
  } else {
    process.stdout.write("Downloading package...\\n");
  }
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

async function createFakeQrCodeModule(dir) {
  const modulePath = path.join(dir, "fake-qrcode-auth.mjs");
  await writeFile(
    modulePath,
    `export const qrcodeAuth = {
  async run(input) {
      if (process.env.OPENCLAW_QRCODE_LOG) {
        await import('node:fs/promises').then(({ writeFile }) =>
          writeFile(process.env.OPENCLAW_QRCODE_LOG, JSON.stringify({
            baseUrl: input.baseUrl,
            channel: input.channel,
            mac: input.mac,
          }), 'utf8')
        );
      }
      const scenario = process.env.OPENCLAW_QRCODE_SCENARIO || 'success';
      input.onSnapshot({
        type: 'qrcode_generated',
        qrcode: 'qr-1',
        display: {
          qrcode: 'qr-1',
          weUrl: 'https://we.example/qr-1',
          pcUrl: 'https://pc.example/qr-1',
        },
        expiresAt: '2026-04-24T00:00:00.000Z',
      });
      if (scenario === 'failed') {
        input.onSnapshot({
          type: 'failed',
          qrcode: 'qr-1',
          reasonCode: 'auth_service_error',
        });
        return;
      }
      input.onSnapshot({
        type: 'confirmed',
        qrcode: 'qr-1',
        credentials: {
          ak: process.env.OPENCLAW_QRCODE_AK || 'openclaw-ak',
          sk: process.env.OPENCLAW_QRCODE_SK || 'openclaw-sk',
        },
      });
  },
};
`,
    "utf8",
  );
  return modulePath;
}

async function createDefaultRuntimeFetchPreload(dir) {
  const preloadPath = path.join(dir, "mock-qrcode-fetch.mjs");
  await writeFile(
    preloadPath,
    `globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.endsWith('/qrcode')) {
    return new Response(JSON.stringify({
      code: '200',
      data: {
        accessToken: 'token-1',
        qrcode: 'qr-1',
        weUrl: 'https://we.example/qr-1',
        pcUrl: 'https://pc.example/qr-1',
        expireTime: '2026-04-24T00:00:00.000Z',
      },
    }));
  }
  return new Response(JSON.stringify({
    code: '200',
    data: {
      qrcode: 'qr-1',
      status: 'confirmed',
      expired: 'false',
      ak: 'default-ak',
      sk: 'default-sk',
    },
  }));
};
`,
    "utf8",
  );
  return preloadPath;
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
  encoding: "buffer",
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

function runInstallerRaw({ cwd, home, openclawBin = "", extraArgs = [], extraEnv = {}, prependPath = "" }) {
  const cliArgs = [scriptPath];
  if (openclawBin) {
    cliArgs.push("--openclaw-bin", openclawBin);
  }
  cliArgs.push(...extraArgs);

  return spawnSync(process.execPath, cliArgs, {
    cwd,
    encoding: "buffer",
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

function baseArgs() {
  return ["--url", "wss://gateway.example.com/ws/agent", "--base-url", "https://auth.example.com"];
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function withShadowInstalledQrCodePackage(mode, fn) {
  const backupPath = path.join(shadowPackageParent, `.skill-qrcode-auth-backup-${randomUUID()}`);
  const hadOriginalPackage = await pathExists(shadowPackageRoot);

  if (hadOriginalPackage) {
    await rename(shadowPackageRoot, backupPath);
  }

  await mkdir(path.join(shadowPackageRoot, "dist"), { recursive: true });
  await writeFile(
    path.join(shadowPackageRoot, "package.json"),
    JSON.stringify(
      {
        name: "@wecode/skill-qrcode-auth",
        type: "module",
        exports: {
          ".": {
            default: "./dist/index.js",
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    path.join(shadowPackageRoot, "dist", "index.js"),
    mode === "valid"
      ? `export const qrcodeAuth = {
  async run(input) {
    input.onSnapshot({
      type: 'qrcode_generated',
      qrcode: 'pkg-qr',
      display: {
        qrcode: 'pkg-qr',
        weUrl: 'https://pkg.example/we',
        pcUrl: 'https://pkg.example/pc',
      },
      expiresAt: '2026-04-24T00:00:00.000Z',
    });
    input.onSnapshot({
      type: 'confirmed',
      qrcode: 'pkg-qr',
      credentials: {
        ak: 'package-ak',
        sk: 'package-sk',
      },
    });
  },
};
`
      : `export const broken = {};\n`,
    "utf8",
  );

  try {
    await fn();
  } finally {
    await rm(shadowPackageRoot, { recursive: true, force: true });
    if (hadOriginalPackage) {
      await rename(backupPath, shadowPackageRoot);
    }
  }
}

test("installer runs qrcode auth and configures channel with returned credentials", async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, "home");
    const logFile = path.join(dir, "openclaw.log");
    const qrcodeLog = path.join(dir, "qrcode.json");
    await mkdir(home, { recursive: true });
    const fakeOpenclaw = await createFakeOpenclaw(dir);
    const fakeQrCodeModule = await createFakeQrCodeModule(dir);

    const result = runInstaller({
      cwd: process.cwd(),
      home,
      openclawBin: fakeOpenclaw,
      extraArgs: [...baseArgs(), "--name", "Primary bridge"],
      extraEnv: {
        FAKE_OPENCLAW_LOG: logFile,
        OPENCLAW_INSTALL_QRCODE_AUTH_MODULE: fakeQrCodeModule,
        OPENCLAW_QRCODE_LOG: qrcodeLog,
      },
    });

    assert.strictEqual(result.status, 0, result.stderr);
    const commands = await readLoggedCommands(logFile);
    assert.deepStrictEqual(commands, [
      ["--version"],
      ["plugins", "install", "@wecode/skill-openclaw-plugin"],
      ["plugins", "info", "skill-openclaw-plugin", "--json"],
      [
        "channels",
        "add",
        "--channel",
        "message-bridge",
        "--url",
        "wss://gateway.example.com/ws/agent",
        "--token",
        "openclaw-ak",
        "--password",
        "openclaw-sk",
        "--name",
        "Primary bridge",
      ],
      ["gateway", "restart"],
    ]);
    const qrcodeInput = JSON.parse(await readFile(qrcodeLog, "utf8"));
    assert.equal(qrcodeInput.baseUrl, "https://auth.example.com");
    assert.equal(qrcodeInput.channel, "openclaw");
    assert.ok(result.stdout.includes("二维码授权成功"));
  });
});

test("monorepo source integration loads default qrcodeAuth runtime when no override is provided", async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, "home");
    const logFile = path.join(dir, "openclaw.log");
    await mkdir(home, { recursive: true });
    const fakeOpenclaw = await createFakeOpenclaw(dir);
    const preload = await createDefaultRuntimeFetchPreload(dir);

    const result = runInstaller({
      cwd: process.cwd(),
      home,
      openclawBin: fakeOpenclaw,
      extraArgs: baseArgs(),
      extraEnv: {
        FAKE_OPENCLAW_LOG: logFile,
        NODE_OPTIONS: `--import ${preload}`,
      },
    });

    assert.strictEqual(result.status, 0, result.stderr);
    const commands = await readLoggedCommands(logFile);
    assert.deepStrictEqual(commands[3].slice(0, 7), [
      "channels",
      "add",
      "--channel",
      "message-bridge",
      "--url",
      "wss://gateway.example.com/ws/agent",
      "--token",
    ]);
    assert.ok(commands[3].includes("default-ak"));
    assert.ok(commands[3].includes("default-sk"));
  });
});

test("installer prefers installed qrcode package before monorepo fallback", async () => {
  await withShadowInstalledQrCodePackage("valid", async () => {
    await withTempDir(async (dir) => {
      const home = path.join(dir, "home");
      const logFile = path.join(dir, "openclaw.log");
      await mkdir(home, { recursive: true });
      const fakeOpenclaw = await createFakeOpenclaw(dir);

      const result = runInstaller({
        cwd: process.cwd(),
        home,
        openclawBin: fakeOpenclaw,
        extraArgs: baseArgs(),
        extraEnv: {
          FAKE_OPENCLAW_LOG: logFile,
        },
      });

      assert.strictEqual(result.status, 0, result.stderr);
      const commands = await readLoggedCommands(logFile);
      assert.ok(commands[3].includes("package-ak"));
      assert.ok(commands[3].includes("package-sk"));
    });
  });
});

test("installer falls back to monorepo source when installed qrcode package export is invalid", async () => {
  await withShadowInstalledQrCodePackage("broken", async () => {
    await withTempDir(async (dir) => {
      const home = path.join(dir, "home");
      const logFile = path.join(dir, "openclaw.log");
      await mkdir(home, { recursive: true });
      const fakeOpenclaw = await createFakeOpenclaw(dir);
      const preload = await createDefaultRuntimeFetchPreload(dir);

      const result = runInstaller({
        cwd: process.cwd(),
        home,
        openclawBin: fakeOpenclaw,
        extraArgs: baseArgs(),
        extraEnv: {
          FAKE_OPENCLAW_LOG: logFile,
          NODE_OPTIONS: `--import ${preload}`,
        },
      });

      assert.strictEqual(result.status, 0, result.stderr);
      const commands = await readLoggedCommands(logFile);
      assert.ok(commands[3].includes("default-ak"));
      assert.ok(commands[3].includes("default-sk"));
    });
  });
});

test("installer preserves existing scoped registry when no override is provided", async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, "home");
    const logFile = path.join(dir, "openclaw.log");
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, ".npmrc"), "@wecode:registry=https://old.registry/\n", "utf8");
    const fakeOpenclaw = await createFakeOpenclaw(dir);
    const fakeQrCodeModule = await createFakeQrCodeModule(dir);
    const result = runInstaller({
      cwd: process.cwd(),
      home,
      openclawBin: fakeOpenclaw,
      extraArgs: baseArgs(),
      extraEnv: {
        FAKE_OPENCLAW_LOG: logFile,
        OPENCLAW_INSTALL_QRCODE_AUTH_MODULE: fakeQrCodeModule,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const npmrc = await readFile(path.join(home, ".npmrc"), "utf8");
    assert.ok(npmrc.includes("@wecode:registry=https://old.registry/"));
  });
});

test("installer skips restart only when --no-restart is passed", async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, "home");
    const logFile = path.join(dir, "openclaw.log");
    const fakeOpenclaw = await createFakeOpenclaw(dir);
    const fakeQrCodeModule = await createFakeQrCodeModule(dir);
    const result = runInstaller({
      cwd: process.cwd(),
      home,
      openclawBin: fakeOpenclaw,
      extraArgs: [...baseArgs(), "--no-restart"],
      extraEnv: {
        FAKE_OPENCLAW_LOG: logFile,
        OPENCLAW_INSTALL_QRCODE_AUTH_MODULE: fakeQrCodeModule,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const commands = await readLoggedCommands(logFile);
    assert.equal(commands.some((command) => command.join(" ") === "gateway restart"), false);
  });
});

test("installer exits non-zero and skips channel configuration when qrcode auth fails", async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, "home");
    const logFile = path.join(dir, "openclaw.log");
    await mkdir(home, { recursive: true });
    const fakeOpenclaw = await createFakeOpenclaw(dir);
    const fakeQrCodeModule = await createFakeQrCodeModule(dir);

    const result = runInstaller({
      cwd: process.cwd(),
      home,
      openclawBin: fakeOpenclaw,
      extraArgs: baseArgs(),
      extraEnv: {
        FAKE_OPENCLAW_LOG: logFile,
        OPENCLAW_INSTALL_QRCODE_AUTH_MODULE: fakeQrCodeModule,
        OPENCLAW_QRCODE_SCENARIO: "failed",
      },
    });

    assert.notStrictEqual(result.status, 0);
    assert.ok(result.stderr.includes("error_code=QRCODE_AUTH_FAILED"));
    const commands = await readLoggedCommands(logFile);
    assert.equal(commands.some((args) => args[0] === "channels" && args[1] === "add"), false);
  });
});

test("installer fails fast when baseUrl is missing", async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, "home");
    const logFile = path.join(dir, "openclaw.log");
    await mkdir(home, { recursive: true });
    const fakeOpenclaw = await createFakeOpenclaw(dir);

    const result = runInstaller({
      cwd: process.cwd(),
      home,
      openclawBin: fakeOpenclaw,
      extraArgs: ["--url", "wss://gateway.example.com/ws/agent"],
      extraEnv: {
        FAKE_OPENCLAW_LOG: logFile,
      },
    });

    assert.notStrictEqual(result.status, 0);
    assert.ok(result.stderr.includes("error_code=INSTALLER_USAGE_ERROR"));
    await assert.rejects(readFile(logFile, "utf8"));
  });
});

test("installer fails when qrcode auth override does not export runtime", async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, "home");
    const logFile = path.join(dir, "openclaw.log");
    const invalidQrCodeModule = path.join(dir, "invalid-qrcode-auth.mjs");
    await mkdir(home, { recursive: true });
    await writeFile(invalidQrCodeModule, "export const notQrCodeAuth = {};\n", "utf8");
    const fakeOpenclaw = await createFakeOpenclaw(dir);

    const result = runInstaller({
      cwd: process.cwd(),
      home,
      openclawBin: fakeOpenclaw,
      extraArgs: baseArgs(),
      extraEnv: {
        FAKE_OPENCLAW_LOG: logFile,
        OPENCLAW_INSTALL_QRCODE_AUTH_MODULE: invalidQrCodeModule,
      },
    });

    assert.notStrictEqual(result.status, 0);
    assert.ok(result.stderr.includes("error_code=QRCODE_AUTH_FAILED"));
    assert.ok(result.stderr.includes("qrcodeAuth.run"));
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
      extraArgs: baseArgs(),
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

test("installer on win32 preserves non-utf8 install output bytes without re-decoding", async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, "home");
    const logFile = path.join(dir, "openclaw.log");
    const tempDir = path.join(dir, "temp");
    await mkdir(tempDir, { recursive: true });
    const fakeOpenclaw = await createFakeOpenclaw(dir);
    const fakeQrCodeModule = await createFakeQrCodeModule(dir);
    const shimHarness = await createWin32ShimHarness(dir, fakeOpenclaw, {
      includeBareOpenclaw: false,
    });

    const result = runInstallerRaw({
      cwd: process.cwd(),
      home,
      extraArgs: baseArgs(),
      prependPath: shimHarness.prependPath,
      extraEnv: {
        FAKE_OPENCLAW_LOG: logFile,
        FAKE_OPENCLAW_INSTALL_OUTPUT_HEX: "b2e2cad40a",
        NODE_OPTIONS: shimHarness.nodeOptions,
        OPENCLAW_INSTALL_QRCODE_AUTH_MODULE: fakeQrCodeModule,
        TEMP: tempDir,
        TMP: tempDir,
      },
    });

    assert.equal(result.status, 0, result.stderr?.toString("utf8"));
    assert.ok(Buffer.isBuffer(result.stdout));
    assert.notEqual(result.stdout.indexOf(Buffer.from("b2e2cad40a", "hex")), -1);
  });
});

test("installer stops when plugin info command fails", async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, "home");
    const logFile = path.join(dir, "openclaw.log");
    const fakeOpenclaw = await createFakeOpenclaw(dir);
    const result = runInstaller({
      cwd: process.cwd(),
      home,
      openclawBin: fakeOpenclaw,
      extraArgs: baseArgs(),
      extraEnv: {
        FAKE_OPENCLAW_LOG: logFile,
        FAKE_OPENCLAW_FAIL_STEP: "plugins-info",
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

test("installer stops when plugin verification fails", async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, "home");
    const logFile = path.join(dir, "openclaw.log");
    const fakeOpenclaw = await createFakeOpenclaw(dir);
    const result = runInstaller({
      cwd: process.cwd(),
      home,
      openclawBin: fakeOpenclaw,
      extraArgs: baseArgs(),
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
    const fakeQrCodeModule = await createFakeQrCodeModule(dir);
    const result = runInstaller({
      cwd: process.cwd(),
      home,
      openclawBin: fakeOpenclaw,
      extraArgs: baseArgs(),
      extraEnv: {
        FAKE_OPENCLAW_LOG: logFile,
        FAKE_OPENCLAW_FAIL_STEP: "channels-add",
        OPENCLAW_INSTALL_QRCODE_AUTH_MODULE: fakeQrCodeModule,
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
    const fakeQrCodeModule = await createFakeQrCodeModule(dir);
    const result = runInstaller({
      cwd: process.cwd(),
      home,
      openclawBin: fakeOpenclaw,
      extraArgs: baseArgs(),
      extraEnv: {
        FAKE_OPENCLAW_LOG: logFile,
        FAKE_OPENCLAW_FAIL_STEP: "gateway-restart",
        OPENCLAW_INSTALL_QRCODE_AUTH_MODULE: fakeQrCodeModule,
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
    const fakeQrCodeModule = await createFakeQrCodeModule(dir);
    const shimHarness = await createWin32ShimHarness(dir, fakeOpenclaw, {
      includeBareOpenclaw: false,
    });
    const result = runInstaller({
      cwd: process.cwd(),
      home,
      extraArgs: baseArgs(),
      prependPath: shimHarness.prependPath,
      extraEnv: {
        FAKE_OPENCLAW_LOG: logFile,
        NODE_OPTIONS: shimHarness.nodeOptions,
        OPENCLAW_INSTALL_QRCODE_AUTH_MODULE: fakeQrCodeModule,
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
        "wss://gateway.example.com/ws/agent",
        "--token",
        "openclaw-ak",
        "--password",
        "openclaw-sk",
      ],
      ["gateway", "restart"],
    ]);
    assert.match(result.stdout, /已检测到 OpenClaw: .*openclaw\.cmd/);
    assert.match(result.stdout, /建议执行: .*openclaw\.cmd channels status --channel message-bridge --probe --json/);
  });
});
