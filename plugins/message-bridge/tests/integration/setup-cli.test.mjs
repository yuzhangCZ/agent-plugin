import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const scriptPath = resolve('scripts/setup-message-bridge.mjs');
const shadowPackageRoot = resolve('node_modules/@wecode/skill-qrcode-auth');
const shadowPackageParent = resolve('node_modules/@wecode');

async function withTempDirs(fn) {
  const home = await mkdtemp(join(tmpdir(), 'mb-cli-home-'));
  const project = await mkdtemp(join(tmpdir(), 'mb-cli-project-'));
  const qrcodeModule = await createFakeQrCodeModule(home);
  try {
    await fn({ home, project, qrcodeModule });
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
}

async function createFakeQrCodeModule(dir) {
  const modulePath = join(dir, 'fake-qrcode-auth.mjs');
  await writeFile(
    modulePath,
    `export const qrcodeAuth = {
  async run(input) {
      if (process.env.MB_QRCODE_LOG) {
        await import('node:fs/promises').then(({ writeFile }) =>
          writeFile(process.env.MB_QRCODE_LOG, JSON.stringify({
            baseUrl: input.baseUrl,
            channel: input.channel,
            mac: input.mac,
          }), 'utf8')
        );
      }
      const scenario = process.env.MB_QRCODE_SCENARIO || 'success';
      if (scenario === 'refresh') {
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
        input.onSnapshot({ type: 'expired', qrcode: 'qr-1' });
        input.onSnapshot({
          type: 'qrcode_generated',
          qrcode: 'qr-2',
          display: {
            qrcode: 'qr-2',
            weUrl: 'https://we.example/qr-2',
            pcUrl: 'https://pc.example/qr-2',
          },
          expiresAt: '2026-04-24T00:05:00.000Z',
        });
        input.onSnapshot({
          type: 'confirmed',
          qrcode: 'qr-2',
          credentials: { ak: 'refresh-ak', sk: 'refresh-sk' },
        });
        return;
      }
      if (scenario === 'failed') {
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
        input.onSnapshot({
          type: 'failed',
          qrcode: 'qr-1',
          reasonCode: 'network_error',
        });
        return;
      }
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
      input.onSnapshot({ type: 'scanned', qrcode: 'qr-1' });
      input.onSnapshot({
        type: 'confirmed',
        qrcode: 'qr-1',
        credentials: {
          ak: process.env.MB_QRCODE_AK || 'success-ak',
          sk: process.env.MB_QRCODE_SK || 'success-sk',
        },
      });
  },
};
`,
    'utf8',
  );
  return modulePath;
}

async function createDefaultRuntimeFetchPreload(dir) {
  const preloadPath = join(dir, 'mock-qrcode-fetch.mjs');
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
    'utf8',
  );
  return preloadPath;
}

async function createWin32PlatformPreload(dir) {
  const preloadPath = join(dir, 'mock-win32-platform.mjs');
  await writeFile(preloadPath, `Object.defineProperty(process, 'platform', { value: 'win32' });\n`, 'utf8');
  return preloadPath;
}

function createDefaultUserEnv(home, qrcodeModule, extraEnv = {}) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    MB_SETUP_QRCODE_AUTH_MODULE: qrcodeModule,
    ...extraEnv,
  };
}

function runSetupCommand({ cwd, home, qrcodeModule, args = [], extraEnv = {} }) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env: createDefaultUserEnv(home, qrcodeModule, extraEnv),
    encoding: 'utf8',
  });
}

function extractNpmrcPathFromOutput(stdout) {
  const line = stdout
    .split(/\r?\n/)
    .find((entry) => entry.includes('npm scope') && entry.includes(':'));

  assert.notStrictEqual(line, undefined, 'setup output should include the resolved npmrc path');
  return line.slice(line.indexOf(':') + 1).trim();
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
  const backupPath = join(shadowPackageParent, `.skill-qrcode-auth-backup-${randomUUID()}`);
  const hadOriginalPackage = await pathExists(shadowPackageRoot);

  if (hadOriginalPackage) {
    await rename(shadowPackageRoot, backupPath);
  }

  await mkdir(join(shadowPackageRoot, 'dist'), { recursive: true });
  await writeFile(
    join(shadowPackageRoot, 'package.json'),
    JSON.stringify(
      {
        name: '@wecode/skill-qrcode-auth',
        type: 'module',
        exports: {
          '.': {
            default: './dist/index.js',
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  await writeFile(
    join(shadowPackageRoot, 'dist', 'index.js'),
    mode === 'valid'
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
    'utf8',
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

describe('setup cli', () => {
  test('writes opencode config after successful qrcode auth', async () => {
    await withTempDirs(async ({ home, project, qrcodeModule }) => {
      const logPath = join(home, 'qrcode-log.json');
      const result = runSetupCommand({
        cwd: project,
        home,
        qrcodeModule,
        args: ['--scope', 'user', '--base-url', 'https://auth.example.com'],
        extraEnv: {
          MB_QRCODE_LOG: logPath,
        },
      });

      assert.strictEqual(result.status, 0, result.stderr);

      const configRoot = join(home, '.config', 'opencode');
      const bridge = await readFile(join(configRoot, 'message-bridge.jsonc'), 'utf8');
      const opencode = await readFile(join(configRoot, 'opencode.jsonc'), 'utf8');
      const npmrc = await readFile(join(home, '.npmrc'), 'utf8');
      const qrcodeInput = JSON.parse(await readFile(logPath, 'utf8'));

      assert.ok(bridge.includes('"ak": "success-ak"'));
      assert.ok(bridge.includes('"sk": "success-sk"'));
      assert.ok(opencode.includes('"plugin": ["@wecode/skill-opencode-plugin"]'));
      assert.ok(npmrc.includes('@wecode:registry=https://cmc.centralrepo.rnd.huawei.com/artifactory/api/npm/product_npm/'));
      assert.equal(qrcodeInput.baseUrl, 'https://auth.example.com');
      assert.equal(qrcodeInput.channel, 'opencode');
      assert.ok(result.stdout.includes('二维码授权成功'));
    });
  });

  test('monorepo source integration loads default qrcodeAuth runtime when no override is provided', async () => {
    await withTempDirs(async ({ home, project }) => {
      const preload = await createDefaultRuntimeFetchPreload(home);
      const result = spawnSync(process.execPath, [scriptPath, '--scope', 'user', '--base-url', 'https://auth.example.com'], {
        cwd: project,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: join(home, '.config'),
          NODE_OPTIONS: `--import ${preload}`,
        },
        encoding: 'utf8',
      });

      assert.strictEqual(result.status, 0, result.stderr);
      const bridge = await readFile(join(home, '.config', 'opencode', 'message-bridge.jsonc'), 'utf8');
      assert.ok(bridge.includes('"ak": "default-ak"'));
      assert.ok(bridge.includes('"sk": "default-sk"'));
    });
  });

  test('prefers installed qrcode package before monorepo fallback', async () => {
    await withShadowInstalledQrCodePackage('valid', async () => {
      await withTempDirs(async ({ home, project }) => {
        const result = spawnSync(process.execPath, [scriptPath, '--scope', 'user', '--base-url', 'https://auth.example.com'], {
          cwd: project,
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            XDG_CONFIG_HOME: join(home, '.config'),
          },
          encoding: 'utf8',
        });

        assert.strictEqual(result.status, 0, result.stderr);
        const bridge = await readFile(join(home, '.config', 'opencode', 'message-bridge.jsonc'), 'utf8');
        assert.ok(bridge.includes('"ak": "package-ak"'));
        assert.ok(bridge.includes('"sk": "package-sk"'));
      });
    });
  });

  test('falls back to monorepo source when installed qrcode package export is invalid', async () => {
    await withShadowInstalledQrCodePackage('broken', async () => {
      await withTempDirs(async ({ home, project }) => {
        const preload = await createDefaultRuntimeFetchPreload(home);
        const result = spawnSync(process.execPath, [scriptPath, '--scope', 'user', '--base-url', 'https://auth.example.com'], {
          cwd: project,
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            XDG_CONFIG_HOME: join(home, '.config'),
            NODE_OPTIONS: `--import ${preload}`,
          },
          encoding: 'utf8',
        });

        assert.strictEqual(result.status, 0, result.stderr);
        const bridge = await readFile(join(home, '.config', 'opencode', 'message-bridge.jsonc'), 'utf8');
        assert.ok(bridge.includes('"ak": "default-ak"'));
        assert.ok(bridge.includes('"sk": "default-sk"'));
      });
    });
  });

  test('prints refreshed qrcode when previous qrcode expires', async () => {
    await withTempDirs(async ({ home, project, qrcodeModule }) => {
      const result = runSetupCommand({
        cwd: project,
        home,
        qrcodeModule,
        args: ['--scope', 'user', '--base-url', 'https://auth.example.com'],
        extraEnv: {
          MB_QRCODE_SCENARIO: 'refresh',
        },
      });

      assert.strictEqual(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes('二维码已过期'));
      assert.ok(result.stdout.includes('qrcode: qr-2'));

      const bridge = await readFile(join(home, '.config', 'opencode', 'message-bridge.jsonc'), 'utf8');
      assert.ok(bridge.includes('"ak": "refresh-ak"'));
      assert.ok(bridge.includes('"sk": "refresh-sk"'));
    });
  });

  test('does not write config when qrcode auth fails', async () => {
    await withTempDirs(async ({ home, project, qrcodeModule }) => {
      const result = runSetupCommand({
        cwd: project,
        home,
        qrcodeModule,
        args: ['--scope', 'user', '--base-url', 'https://auth.example.com'],
        extraEnv: {
          MB_QRCODE_SCENARIO: 'failed',
        },
      });

      assert.notStrictEqual(result.status, 0);
      assert.ok(result.stderr.includes('二维码授权失败'));

      const configRoot = join(home, '.config', 'opencode');
      await assert.rejects(readFile(join(configRoot, 'message-bridge.jsonc'), 'utf8'));
    });
  });

  test('fails fast when baseUrl is missing', async () => {
    await withTempDirs(async ({ home, project, qrcodeModule }) => {
      const result = runSetupCommand({
        cwd: project,
        home,
        qrcodeModule,
        args: ['--scope', 'user'],
      });

      assert.notStrictEqual(result.status, 0);
      assert.ok(result.stderr.includes('base URL'));
    });
  });

  test('fails when qrcode auth override does not export runtime', async () => {
    await withTempDirs(async ({ home, project }) => {
      const invalidModule = join(home, 'invalid-qrcode-auth.mjs');
      await writeFile(invalidModule, 'export const notQrCodeAuth = {};\n', 'utf8');
      const result = runSetupCommand({
        cwd: project,
        home,
        qrcodeModule: invalidModule,
        args: ['--scope', 'user', '--base-url', 'https://auth.example.com'],
      });

      assert.notStrictEqual(result.status, 0);
      assert.ok(result.stderr.includes('qrcodeAuth.run'));
    });
  });

  test('preserves existing gateway url and avoids duplicate plugin entry', async () => {
    await withTempDirs(async ({ home, project, qrcodeModule }) => {
      const configRoot = join(home, '.config', 'opencode');
      await mkdir(configRoot, { recursive: true });
      await writeFile(
        join(configRoot, 'message-bridge.jsonc'),
        '{\n  "gateway": {\n    "url": "wss://gateway.example.com/ws/agent"\n  },\n  "auth": {\n    "ak": "old-ak",\n    "sk": "old-sk"\n  }\n}\n',
        'utf8',
      );
      await writeFile(
        join(configRoot, 'opencode.jsonc'),
        '{\n  "$schema": "https://opencode.ai/config.json",\n  "plugin": ["@wecode/skill-opencode-plugin"]\n}\n',
        'utf8',
      );

      const result = runSetupCommand({
        cwd: project,
        home,
        qrcodeModule,
        args: ['--scope', 'user', '--base-url', 'https://auth.example.com'],
      });

      assert.strictEqual(result.status, 0, result.stderr);

      const bridge = await readFile(join(configRoot, 'message-bridge.jsonc'), 'utf8');
      const opencode = await readFile(join(configRoot, 'opencode.jsonc'), 'utf8');

      assert.ok(bridge.includes('"url": "wss://gateway.example.com/ws/agent"'));
      assert.ok(bridge.includes('"ak": "success-ak"'));
      assert.ok(bridge.includes('"sk": "success-sk"'));
      assert.strictEqual(opencode.match(/@wecode\/skill-opencode-plugin/g)?.length, 1);
    });
  });

  test('adds missing sk into existing auth object without breaking json', async () => {
    await withTempDirs(async ({ home, project, qrcodeModule }) => {
      const configRoot = join(home, '.config', 'opencode');
      await mkdir(configRoot, { recursive: true });
      await writeFile(
        join(configRoot, 'message-bridge.jsonc'),
        '{\n  "auth": {\n    "ak": "only-ak"\n  }\n}\n',
        'utf8',
      );

      const result = runSetupCommand({
        cwd: project,
        home,
        qrcodeModule,
        args: ['--scope', 'user', '--base-url', 'https://auth.example.com'],
        extraEnv: {
          MB_QRCODE_AK: 'updated-ak',
          MB_QRCODE_SK: 'added-sk',
        },
      });

      assert.strictEqual(result.status, 0, result.stderr);

      const bridge = await readFile(join(configRoot, 'message-bridge.jsonc'), 'utf8');
      assert.ok(bridge.includes('"ak": "updated-ak",'));
      assert.ok(bridge.includes('"sk": "added-sk"'));
    });
  });

  test('fails fast on invalid existing bridge config', async () => {
    await withTempDirs(async ({ home, project, qrcodeModule }) => {
      const configRoot = join(home, '.config', 'opencode');
      await mkdir(configRoot, { recursive: true });
      await writeFile(join(configRoot, 'message-bridge.jsonc'), '{\n  "auth": {\n', 'utf8');

      const result = runSetupCommand({
        cwd: project,
        home,
        qrcodeModule,
        args: ['--scope', 'user', '--base-url', 'https://auth.example.com'],
      });

      assert.notStrictEqual(result.status, 0);
      assert.ok(result.stderr.includes('无法安全解析现有 bridge 配置'));
    });
  });

  test('fails fast on invalid existing opencode config', async () => {
    await withTempDirs(async ({ home, project, qrcodeModule }) => {
      const configRoot = join(home, '.config', 'opencode');
      await mkdir(configRoot, { recursive: true });
      await writeFile(join(configRoot, 'opencode.jsonc'), '[\n', 'utf8');

      const result = runSetupCommand({
        cwd: project,
        home,
        qrcodeModule,
        args: ['--scope', 'user', '--base-url', 'https://auth.example.com'],
      });

      assert.notStrictEqual(result.status, 0);
      assert.ok(result.stderr.includes('无法安全解析现有 OpenCode 配置'));
    });
  });

  test('writes project-scope files when scope is project', async () => {
    await withTempDirs(async ({ home, project, qrcodeModule }) => {
      await mkdir(join(project, '.opencode'), { recursive: true });
      const result = runSetupCommand({
        cwd: project,
        home,
        qrcodeModule,
        args: ['--scope', 'project', '--base-url', 'https://auth.example.com'],
      });

      assert.strictEqual(result.status, 0, result.stderr);

      const bridge = await readFile(join(project, '.opencode', 'message-bridge.jsonc'), 'utf8');
      const opencode = await readFile(join(project, 'opencode.jsonc'), 'utf8');
      const npmrc = await readFile(join(project, '.npmrc'), 'utf8');
      assert.ok(bridge.includes('"ak": "success-ak"'));
      assert.ok(bridge.includes('"sk": "success-sk"'));
      assert.ok(opencode.includes('"plugin": ["@wecode/skill-opencode-plugin"]'));
      assert.ok(npmrc.includes('@wecode:registry=https://cmc.centralrepo.rnd.huawei.com/artifactory/api/npm/product_npm/'));
    });
  });

  test('uses windows-style global config path when platform is win32', async () => {
    await withTempDirs(async ({ home, project, qrcodeModule }) => {
      const tempDir = join(home, 'Temp');
      await mkdir(tempDir, { recursive: true });
      const platformPreload = await createWin32PlatformPreload(home);
      const result = runSetupCommand({
        cwd: project,
        home,
        qrcodeModule,
        args: ['--scope', 'user', '--base-url', 'https://auth.example.com'],
        extraEnv: {
          XDG_CONFIG_HOME: '',
          NODE_OPTIONS: `--import ${platformPreload}`,
          TEMP: tempDir,
          TMP: tempDir,
        },
      });

      assert.strictEqual(result.status, 0, result.stderr);

      const configRoot = join(home, '.config', 'opencode');
      const bridge = await readFile(join(configRoot, 'message-bridge.jsonc'), 'utf8');
      const opencode = await readFile(join(configRoot, 'opencode.jsonc'), 'utf8');
      const npmrc = await readFile(join(home, '.npmrc'), 'utf8');

      assert.ok(bridge.includes('"ak": "success-ak"'));
      assert.ok(opencode.includes('"plugin": ["@wecode/skill-opencode-plugin"]'));
      assert.ok(npmrc.includes('@wecode:registry=https://cmc.centralrepo.rnd.huawei.com/artifactory/api/npm/product_npm/'));
    });
  });

  test('prefers NPM_CONFIG_USERCONFIG for user-scope npmrc path', async () => {
    await withTempDirs(async ({ home, project, qrcodeModule }) => {
      const customNpmrc = join(home, 'custom', 'npmrc', '.npmrc');
      const result = runSetupCommand({
        cwd: project,
        home,
        qrcodeModule,
        args: ['--scope', 'user', '--base-url', 'https://auth.example.com'],
        extraEnv: {
          NPM_CONFIG_USERCONFIG: customNpmrc,
        },
      });

      assert.strictEqual(result.status, 0, result.stderr);

      const resolvedNpmrcPath = extractNpmrcPathFromOutput(result.stdout);
      const npmrc = await readFile(customNpmrc, 'utf8');
      assert.strictEqual(resolvedNpmrcPath, customNpmrc);
      assert.ok(npmrc.includes('@wecode:registry=https://cmc.centralrepo.rnd.huawei.com/artifactory/api/npm/product_npm/'));
      assert.strictEqual(
        await readFile(join(home, '.npmrc'), 'utf8').then(() => true).catch(() => false),
        false,
      );
    });
  });

  test('supports install subcommand and --yes compatibility flag', async () => {
    await withTempDirs(async ({ home, project, qrcodeModule }) => {
      const result = runSetupCommand({
        cwd: project,
        home,
        qrcodeModule,
        args: ['install', '--yes', '--base-url', 'https://auth.example.com'],
      });

      assert.strictEqual(result.status, 0, result.stderr);

      const configRoot = join(home, '.config', 'opencode');
      const bridge = await readFile(join(configRoot, 'message-bridge.jsonc'), 'utf8');
      const opencode = await readFile(join(configRoot, 'opencode.jsonc'), 'utf8');
      const npmrc = await readFile(join(home, '.npmrc'), 'utf8');

      assert.ok(bridge.includes('"ak": "success-ak"'));
      assert.ok(bridge.includes('"sk": "success-sk"'));
      assert.ok(opencode.includes('"plugin": ["@wecode/skill-opencode-plugin"]'));
      assert.ok(npmrc.includes('@wecode:registry=https://cmc.centralrepo.rnd.huawei.com/artifactory/api/npm/product_npm/'));
    });
  });

  test('keeps compatibility for no-subcommand invocation', async () => {
    await withTempDirs(async ({ home, project, qrcodeModule }) => {
      const result = runSetupCommand({
        cwd: project,
        home,
        qrcodeModule,
        args: ['--yes', '--base-url', 'https://auth.example.com'],
      });

      assert.strictEqual(result.status, 0, result.stderr);
      const configRoot = join(home, '.config', 'opencode');
      const bridge = await readFile(join(configRoot, 'message-bridge.jsonc'), 'utf8');
      assert.ok(bridge.includes('"ak": "success-ak"'));
      assert.ok(bridge.includes('"sk": "success-sk"'));
    });
  });

  test('supports registry override via --registry', async () => {
    await withTempDirs(async ({ home, project, qrcodeModule }) => {
      const result = runSetupCommand({
        cwd: project,
        home,
        qrcodeModule,
        args: [
          'install',
          '--yes',
          '--base-url',
          'https://auth.example.com',
          '--registry',
          'https://registry.override.example/npm',
        ],
      });

      assert.strictEqual(result.status, 0, result.stderr);
      const npmrc = await readFile(join(home, '.npmrc'), 'utf8');
      assert.ok(npmrc.includes('@wecode:registry=https://registry.override.example/npm/'));
    });
  });

  test('prints warning and keeps going when opencode command is not installed', async () => {
    await withTempDirs(async ({ home, project, qrcodeModule }) => {
      await chmod(qrcodeModule, 0o644);
      const result = runSetupCommand({
        cwd: project,
        home,
        qrcodeModule,
        args: ['install', '--yes', '--base-url', 'https://auth.example.com'],
        extraEnv: {
          PATH: '/dev/null',
        },
      });

      assert.strictEqual(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes('OpenCode 环境检查提示：未检测到 opencode 命令，将继续写入配置。'));
      const configRoot = join(home, '.config', 'opencode');
      const bridge = await readFile(join(configRoot, 'message-bridge.jsonc'), 'utf8');
      assert.ok(bridge.includes('"ak": "success-ak"'));
    });
  });

  test('uses existing scope registry as preview when --registry is not provided', async () => {
    await withTempDirs(async ({ home, project, qrcodeModule }) => {
      await writeFile(join(home, '.npmrc'), '@wecode:registry=https://existing.registry.example.com/npm\n', 'utf8');

      const result = runSetupCommand({
        cwd: project,
        home,
        qrcodeModule,
        args: ['install', '--yes', '--base-url', 'https://auth.example.com'],
      });

      assert.strictEqual(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes('默认 npm scope registry: https://existing.registry.example.com/npm/'));

      const npmrc = await readFile(join(home, '.npmrc'), 'utf8');
      assert.ok(npmrc.includes('@wecode:registry=https://existing.registry.example.com/npm'));
      assert.ok(!npmrc.includes('cmc.centralrepo.rnd.huawei.com'));
    });
  });
});
