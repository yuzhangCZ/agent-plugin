import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const scriptPath = resolve('scripts/setup-message-bridge.mjs');

async function withTempDirs(fn) {
  const home = await mkdtemp(join(tmpdir(), 'mb-cli-home-'));
  const project = await mkdtemp(join(tmpdir(), 'mb-cli-project-'));
  try {
    await fn({ home, project });
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
}

function runSetup({ cwd, home, input, scope = 'user' }) {
  const spawnEnv = createDefaultUserEnv(home);

  return spawnSync(process.execPath, [scriptPath, '--scope', scope], {
    cwd,
    env: spawnEnv,
    input,
    encoding: 'utf8',
  });
}

function createDefaultUserEnv(home) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
  };
}

function runSetupCommand({ cwd, home, input = '', args = [], extraEnv = {} }) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env: {
      ...createDefaultUserEnv(home),
      ...extraEnv,
    },
    input,
    encoding: 'utf8',
  });
}

function runSetupWithEnv({ cwd, env: extraEnv, input, scope = 'user' }) {
  return spawnSync(process.execPath, [scriptPath, '--scope', scope], {
    cwd,
    env: {
      ...process.env,
      ...extraEnv,
    },
    input,
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

describe('setup cli', () => {
  test('creates user-scope bridge and opencode config', async () => {
    await withTempDirs(async ({ home, project }) => {
      const result = runSetup({
        cwd: project,
        home,
        input: 'ak-test\nsk-test\ny\n',
      });

      assert.strictEqual(result.status, 0);

      const configRoot = join(home, '.config', 'opencode');
      const bridge = await readFile(join(configRoot, 'message-bridge.jsonc'), 'utf8');
      const opencode = await readFile(join(configRoot, 'opencode.jsonc'), 'utf8');
      const npmrc = await readFile(extractNpmrcPathFromOutput(result.stdout), 'utf8');

      assert.ok(bridge.includes('"ak": "ak-test"'));
      assert.ok(bridge.includes('"sk": "sk-test"'));
      assert.ok(opencode.includes('"plugin": ["@wecode/skill-opencode-plugin"]'));
      assert.ok(npmrc.includes('@wecode:registry=https://cmc.centralrepo.rnd.huawei.com/artifactory/api/npm/product_npm/'));
      assert.ok(result.stdout.includes('- AK: ak-test'));
      assert.ok(result.stdout.includes('- SK: sk-test'));
      assert.ok(result.stdout.includes('下次启动或重启 OpenCode 时会自动安装并加载 npm 插件。'));
      assert.ok(!result.stdout.includes('npx -y --registry='));
    });
  });

  test('preserves existing gateway url and avoids duplicate plugin entry', async () => {
    await withTempDirs(async ({ home, project }) => {
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

      const result = runSetup({
        cwd: project,
        home,
        input: 'old-ak\nnew-sk\ny\n',
      });

      assert.strictEqual(result.status, 0);

      const bridge = await readFile(join(configRoot, 'message-bridge.jsonc'), 'utf8');
      const opencode = await readFile(join(configRoot, 'opencode.jsonc'), 'utf8');

      assert.ok(bridge.includes('"url": "wss://gateway.example.com/ws/agent"'));
      assert.ok(bridge.includes('"ak": "old-ak"'));
      assert.ok(bridge.includes('"sk": "new-sk"'));
      assert.strictEqual(opencode.match(/@wecode\/skill-opencode-plugin/g)?.length, 1);
    });
  });

  test('adds missing sk into existing auth object without breaking json', async () => {
    await withTempDirs(async ({ home, project }) => {
      const configRoot = join(home, '.config', 'opencode');
      await mkdir(configRoot, { recursive: true });
      await writeFile(
        join(configRoot, 'message-bridge.jsonc'),
        '{\n  "auth": {\n    "ak": "only-ak"\n  }\n}\n',
        'utf8',
      );

      const result = runSetup({
        cwd: project,
        home,
        input: 'only-ak\nadded-sk\ny\n',
      });

      assert.strictEqual(result.status, 0);

      const bridge = await readFile(join(configRoot, 'message-bridge.jsonc'), 'utf8');
      assert.ok(bridge.includes('"ak": "only-ak",'));
      assert.ok(bridge.includes('"sk": "added-sk"'));
    });
  });

  test('fails fast on invalid existing bridge config', async () => {
    await withTempDirs(async ({ home, project }) => {
      const configRoot = join(home, '.config', 'opencode');
      await mkdir(configRoot, { recursive: true });
      await writeFile(join(configRoot, 'message-bridge.jsonc'), '{\n  "auth": {\n', 'utf8');

      const result = runSetup({
        cwd: project,
        home,
        input: 'ak-test\nsk-test\ny\n',
      });

      assert.notStrictEqual(result.status, 0);
      assert.ok(result.stderr.includes('无法安全解析现有 bridge 配置'));
    });
  });

  test('writes project-scope files when scope is project', async () => {
    await withTempDirs(async ({ home, project }) => {
      const result = runSetup({
        cwd: project,
        home,
        scope: 'project',
        input: 'ak-project\nsk-project\ny\n',
      });

      assert.strictEqual(result.status, 0);

      const bridge = await readFile(join(project, '.opencode', 'message-bridge.jsonc'), 'utf8');
      const opencode = await readFile(join(project, 'opencode.jsonc'), 'utf8');
      const npmrc = await readFile(join(project, '.npmrc'), 'utf8');

      assert.ok(bridge.includes('"ak": "ak-project"'));
      assert.ok(bridge.includes('"sk": "sk-project"'));
      assert.ok(opencode.includes('"plugin": ["@wecode/skill-opencode-plugin"]'));
      assert.ok(npmrc.includes('@wecode:registry=https://cmc.centralrepo.rnd.huawei.com/artifactory/api/npm/product_npm/'));
    });
  });

  test('does not write files when user cancels confirmation', async () => {
    await withTempDirs(async ({ home, project }) => {
      const result = runSetup({
        cwd: project,
        home,
        input: 'ak-cancel\nsk-cancel\nn\n',
      });

      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout.includes('已取消，未写入任何文件。'));

      const configRoot = join(home, '.config', 'opencode');
      assert.deepStrictEqual(
        await Promise.all([
          readFile(join(configRoot, 'message-bridge.jsonc'), 'utf8').then(() => true).catch(() => false),
          readFile(join(configRoot, 'opencode.jsonc'), 'utf8').then(() => true).catch(() => false),
          readFile(extractNpmrcPathFromOutput(result.stdout), 'utf8').then(() => true).catch(() => false),
        ]),
        [false, false, false],
      );
    });
  });

  test('supports stdin input without tty', async () => {
    await withTempDirs(async ({ home, project }) => {
      const result = runSetup({
        cwd: project,
        home,
        input: "ak-stdin\nsk-stdin\ny\n",
      });

      assert.strictEqual(result.status, 0);

      const configRoot = join(home, '.config', 'opencode');
      const bridge = await readFile(join(configRoot, 'message-bridge.jsonc'), 'utf8');
      const opencode = await readFile(join(configRoot, 'opencode.jsonc'), 'utf8');
      const npmrc = await readFile(extractNpmrcPathFromOutput(result.stdout), 'utf8');

      assert.ok(bridge.includes('"ak": "ak-stdin"'));
      assert.ok(bridge.includes('"sk": "sk-stdin"'));
      assert.ok(opencode.includes('"plugin": ["@wecode/skill-opencode-plugin"]'));
      assert.ok(npmrc.includes('@wecode:registry=https://cmc.centralrepo.rnd.huawei.com/artifactory/api/npm/product_npm/'));
      assert.ok(result.stdout.includes('请输入 AK（必填）'));
      assert.ok(result.stdout.includes('请输入 SK（必填）'));
      assert.ok(result.stdout.includes('确认写入以上配置 [Y/N]'));
    });
  });

  test('requires non-empty ak and sk before confirmation', async () => {
    await withTempDirs(async ({ home, project }) => {
      const result = runSetup({
        cwd: project,
        home,
        input: '\nak-required\n\nsk-required\ny\n',
      });

      assert.strictEqual(result.status, 0);
      assert.ok(result.stderr.includes('AK 不能为空，请重新输入'));
      assert.ok(result.stderr.includes('SK 不能为空，请重新输入'));

      const configRoot = join(home, '.config', 'opencode');
      const bridge = await readFile(join(configRoot, 'message-bridge.jsonc'), 'utf8');
      assert.ok(bridge.includes('"ak": "ak-required"'));
      assert.ok(bridge.includes('"sk": "sk-required"'));
    });
  });

  test('uses windows-style global config path when platform is win32', async () => {
    await withTempDirs(async ({ home, project }) => {
      const appData = join(home, 'AppData', 'Roaming');
      await mkdir(appData, { recursive: true });
      const result = runSetupWithEnv({
        cwd: project,
        env: {
          HOME: home,
          USERPROFILE: home,
          APPDATA: appData,
          XDG_CONFIG_HOME: '',
          MB_SETUP_PLATFORM: 'win32',
        },
        input: 'ak-win\nsk-win\ny\n',
      });

      assert.strictEqual(result.status, 0);

      const configRoot = join(home, '.config', 'opencode');
      const bridge = await readFile(join(configRoot, 'message-bridge.jsonc'), 'utf8');
      const opencode = await readFile(join(configRoot, 'opencode.jsonc'), 'utf8');
      const npmrc = await readFile(join(home, '.npmrc'), 'utf8');

      assert.ok(bridge.includes('"ak": "ak-win"'));
      assert.ok(opencode.includes('"plugin": ["@wecode/skill-opencode-plugin"]'));
      assert.ok(npmrc.includes('@wecode:registry=https://cmc.centralrepo.rnd.huawei.com/artifactory/api/npm/product_npm/'));
    });
  });

  test('prefers NPM_CONFIG_USERCONFIG for user-scope npmrc path', async () => {
    await withTempDirs(async ({ home, project }) => {
      const customNpmrc = join(home, 'custom', 'npmrc', '.npmrc');
      const result = runSetupWithEnv({
        cwd: project,
        env: {
          HOME: home,
          XDG_CONFIG_HOME: join(home, '.config'),
          NPM_CONFIG_USERCONFIG: customNpmrc,
        },
        input: 'ak-custom\nsk-custom\ny\n',
      });

      assert.strictEqual(result.status, 0);

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

  test('supports install subcommand and --yes argument mode', async () => {
    await withTempDirs(async ({ home, project }) => {
      const result = runSetupCommand({
        cwd: project,
        home,
        args: ['install', '--yes', '--ak', 'ak-arg', '--sk', 'sk-arg'],
      });

      assert.strictEqual(result.status, 0);

      const configRoot = join(home, '.config', 'opencode');
      const bridge = await readFile(join(configRoot, 'message-bridge.jsonc'), 'utf8');
      const opencode = await readFile(join(configRoot, 'opencode.jsonc'), 'utf8');
      const npmrc = await readFile(join(home, '.npmrc'), 'utf8');

      assert.ok(bridge.includes('"ak": "ak-arg"'));
      assert.ok(bridge.includes('"sk": "sk-arg"'));
      assert.ok(opencode.includes('"plugin": ["@wecode/skill-opencode-plugin"]'));
      assert.ok(npmrc.includes('@wecode:registry=https://cmc.centralrepo.rnd.huawei.com/artifactory/api/npm/product_npm/'));
    });
  });

  test('keeps compatibility for no-subcommand invocation', async () => {
    await withTempDirs(async ({ home, project }) => {
      const result = runSetupCommand({
        cwd: project,
        home,
        args: ['--yes', '--ak', 'ak-legacy', '--sk', 'sk-legacy'],
      });

      assert.strictEqual(result.status, 0);
      const configRoot = join(home, '.config', 'opencode');
      const bridge = await readFile(join(configRoot, 'message-bridge.jsonc'), 'utf8');
      assert.ok(bridge.includes('"ak": "ak-legacy"'));
      assert.ok(bridge.includes('"sk": "sk-legacy"'));
    });
  });

  test('supports registry override via --registry', async () => {
    await withTempDirs(async ({ home, project }) => {
      const result = runSetupCommand({
        cwd: project,
        home,
        args: [
          'install',
          '--yes',
          '--ak',
          'ak-reg',
          '--sk',
          'sk-reg',
          '--registry',
          'https://registry.override.example/npm',
        ],
      });

      assert.strictEqual(result.status, 0);
      const npmrc = await readFile(join(home, '.npmrc'), 'utf8');
      assert.ok(npmrc.includes('@wecode:registry=https://registry.override.example/npm/'));
    });
  });

  test('prints warning and keeps going when opencode command is not installed', async () => {
    await withTempDirs(async ({ home, project }) => {
      const result = runSetupCommand({
        cwd: project,
        home,
        args: ['install', '--yes', '--ak', 'ak-warn', '--sk', 'sk-warn'],
        extraEnv: { PATH: '/dev/null' },
      });

      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout.includes('OpenCode 环境检查提示：未检测到 opencode 命令，将继续写入配置。'));
      const configRoot = join(home, '.config', 'opencode');
      const bridge = await readFile(join(configRoot, 'message-bridge.jsonc'), 'utf8');
      assert.ok(bridge.includes('"ak": "ak-warn"'));
    });
  });

  test('uses existing scope registry as preview when --registry is not provided', async () => {
    await withTempDirs(async ({ home, project }) => {
      await writeFile(join(home, '.npmrc'), '@wecode:registry=https://existing.registry.example.com/npm\n', 'utf8');

      const result = runSetupCommand({
        cwd: project,
        home,
        args: ['install', '--yes', '--ak', 'ak-existing', '--sk', 'sk-existing'],
      });

      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout.includes('默认 npm scope registry: https://existing.registry.example.com/npm/'));
      assert.ok(result.stdout.includes('- npm scope: @wecode:registry=https://existing.registry.example.com/npm/'));

      const npmrc = await readFile(join(home, '.npmrc'), 'utf8');
      assert.ok(npmrc.includes('@wecode:registry=https://existing.registry.example.com/npm'));
      assert.ok(!npmrc.includes('cmc.centralrepo.rnd.huawei.com'));
    });
  });
});
