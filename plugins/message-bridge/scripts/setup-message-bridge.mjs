#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { stdin, stdout, stderr, argv, env, cwd, exit } from 'node:process';
import { dirname, join } from 'node:path';
import { homedir, networkInterfaces, platform } from 'node:os';
import { mkdtemp, readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const PLUGIN_NAME = '@wecode/skill-opencode-plugin';
const NPM_SCOPE_REGISTRY_LINE = '@wecode:registry=';
const DEFAULT_SCOPE_REGISTRY = 'https://cmc.centralrepo.rnd.huawei.com/artifactory/api/npm/product_npm/';
const DEFAULT_CHANNEL = 'opencode';
const HELP_TEXT = `Message Bridge 安装 CLI

用法:
  node ./scripts/setup-message-bridge.mjs install [options]
  node ./scripts/setup-message-bridge.mjs [options]  # 兼容旧入口，等价于 install

选项:
  --base-url <url>    指定二维码授权服务 base URL
  --registry <url>    指定 @wecode scope registry
  --scope <value>     user | project，默认 user
  --yes               兼容保留，无额外确认步骤
  --help              显示帮助
`;

function writeLine(message) {
  stdout.write(`${message}\n`);
}

function writeError(message) {
  stderr.write(`错误: ${message}\n`);
}

function jsonEscape(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function resolvePreferredExistingPath(jsoncPath, jsonPath) {
  return Promise.any([
    readFile(jsoncPath, 'utf8').then(() => jsoncPath),
    readFile(jsonPath, 'utf8').then(() => jsonPath),
  ]).catch(() => jsoncPath);
}

async function readOptionalTextFile(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function looksLikeJsonObject(content) {
  const trimmed = content.trim();
  return trimmed.startsWith('{') && trimmed.endsWith('}');
}

async function writeFileAtomically(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const tempDir = await mkdtemp(join(tmpdir(), 'mb-setup-'));
  const tempPath = join(tempDir, 'config.tmp');
  try {
    await writeFile(tempPath, content, 'utf8');
    await rename(tempPath, path);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function resolveGlobalConfigDir() {
  if (env.XDG_CONFIG_HOME) {
    return join(env.XDG_CONFIG_HOME, 'opencode');
  }
  if (platform() === 'win32') {
    return join(resolveWindowsHomeDir(), '.config', 'opencode');
  }
  return join(homedir(), '.config', 'opencode');
}

function resolveWindowsHomeDir() {
  if (env.USERPROFILE) {
    return env.USERPROFILE;
  }
  if (env.HOMEDRIVE && env.HOMEPATH) {
    return `${env.HOMEDRIVE}${env.HOMEPATH}`;
  }
  return homedir();
}

function resolveUserNpmrcPath() {
  if (env.NPM_CONFIG_USERCONFIG) {
    return env.NPM_CONFIG_USERCONFIG;
  }

  if (platform() === 'win32') {
    return join(resolveWindowsHomeDir(), '.npmrc');
  }
  return join(env.HOME || homedir(), '.npmrc');
}

function normalizeRegistryUrl(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

function upsertScopeRegistryLine(content, registry) {
  const normalized = normalizeRegistryUrl(registry);
  const scopeLine = `${NPM_SCOPE_REGISTRY_LINE}${normalized}`;
  const lines = content.split(/\r?\n/);
  let updated = false;

  const nextLines = lines.map((line) => {
    if (!line.trim().startsWith(NPM_SCOPE_REGISTRY_LINE)) {
      return line;
    }
    updated = true;
    return scopeLine;
  });

  if (!updated) {
    const joined = content.trim().length > 0 ? content.replace(/\s*$/, '') : '';
    return `${joined}${joined ? '\n' : ''}${scopeLine}\n`;
  }

  return `${nextLines.join('\n').replace(/\s*$/, '')}\n`;
}

function readScopeRegistry(content) {
  const match = content.match(new RegExp(`^\\s*${NPM_SCOPE_REGISTRY_LINE.replace(':', '\\:')}(\\S+)\\s*$`, 'm'));
  return match?.[1] ?? null;
}

async function buildNextNpmrcContent(path, desiredRegistry) {
  const existing = await readOptionalTextFile(path);
  if (existing === null) {
    const registry = normalizeRegistryUrl(desiredRegistry ?? DEFAULT_SCOPE_REGISTRY);
    return `${NPM_SCOPE_REGISTRY_LINE}${registry}\n`;
  }

  if (desiredRegistry) {
    return upsertScopeRegistryLine(existing, desiredRegistry);
  }

  const existingRegistry = readScopeRegistry(existing);
  if (existingRegistry) {
    return existing;
  }

  return upsertScopeRegistryLine(existing, DEFAULT_SCOPE_REGISTRY);
}

function upsertJsonObjectField(objectBody, key, escapedValue) {
  const existingFieldPattern = new RegExp(`("${key}"\\s*:\\s*")[^"]*(")`, 's');
  if (existingFieldPattern.test(objectBody)) {
    return objectBody.replace(existingFieldPattern, `$1${escapedValue}$2`);
  }

  const trimmedBody = objectBody.replace(/\s*$/s, '');
  const trailingWhitespace = objectBody.slice(trimmedBody.length);
  if (!trimmedBody) {
    return `\n    "${key}": "${escapedValue}"${trailingWhitespace}`;
  }

  const separator = /,\s*$/.test(trimmedBody) ? '' : ',';
  return `${trimmedBody}${separator}\n    "${key}": "${escapedValue}"${trailingWhitespace}`;
}

function buildNextBridgeConfig(content, ak, sk) {
  const escapedAk = jsonEscape(ak);
  const escapedSk = jsonEscape(sk);

  if (content === null) {
    return `{
  "auth": {
    "ak": "${escapedAk}",
    "sk": "${escapedSk}"
  }
}
`;
  }

  if (!looksLikeJsonObject(content)) {
    throw new Error('bridge config invalid');
  }

  if (/"auth"\s*:/s.test(content)) {
    const authBlockPattern = /("auth"\s*:\s*\{)([\s\S]*?)(\n\s*\})/s;
    if (!authBlockPattern.test(content)) {
      throw new Error('bridge config invalid');
    }

    return content.replace(authBlockPattern, (_match, start, objectBody, end) => {
      let nextBody = upsertJsonObjectField(objectBody, 'ak', escapedAk);
      nextBody = upsertJsonObjectField(nextBody, 'sk', escapedSk);
      return `${start}${nextBody}${end}`;
    });
  }

  return content.replace(/\n\}\s*$/s, `,\n  "auth": {\n    "ak": "${escapedAk}",\n    "sk": "${escapedSk}"\n  }\n}\n`);
}

function buildNextOpencodeConfig(content) {
  if (content === null) {
    return `{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["${PLUGIN_NAME}"]
}
`;
  }

  if (!looksLikeJsonObject(content)) {
    throw new Error('opencode config invalid');
  }

  if (content.includes(`"${PLUGIN_NAME}"`)) {
    return content;
  }

  if (/"plugin"\s*:\s*\[/s.test(content)) {
    if (/"plugin"\s*:\s*\[\s*\]/s.test(content)) {
      return content.replace(/"plugin"\s*:\s*\[\s*\]/s, `"plugin": ["${PLUGIN_NAME}"]`);
    }
    return content.replace(/("plugin"\s*:\s*\[)([\s\S]*?)(\])/s, (_match, start, items, end) => {
      const trimmedItems = items.trimEnd();
      const separator = /\S/.test(trimmedItems) ? ', ' : '';
      return `${start}${trimmedItems}${separator}"${PLUGIN_NAME}"${end}`;
    });
  }

  return content.replace(/\n\}\s*$/s, `,\n  "plugin": ["${PLUGIN_NAME}"]\n}\n`);
}

function parseArgs(rawArgs) {
  const parsed = {
    command: 'install',
    scope: 'user',
    baseUrl: null,
    registry: null,
    yes: false,
    help: false,
  };

  const args = [...rawArgs];
  const readOptionValue = (option, currentIndex) => {
    const value = args[currentIndex + 1];
    if (!value || value.startsWith('-')) {
      throw new Error(`${option} 需要一个值`);
    }
    return value;
  };

  if (args.length > 0 && !args[0].startsWith('-')) {
    if (args[0] !== 'install') {
      throw new Error(`不支持的子命令: ${args[0]}`);
    }
    args.shift();
  }

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--help' || token === '-h') {
      parsed.help = true;
      continue;
    }
    if (token === '--yes') {
      parsed.yes = true;
      continue;
    }
    if (token === '--scope') {
      const value = readOptionValue('--scope', index);
      if (value !== 'user' && value !== 'project') {
        throw new Error('--scope 仅支持 user 或 project');
      }
      parsed.scope = value;
      index += 1;
      continue;
    }
    if (token === '--base-url') {
      parsed.baseUrl = readOptionValue('--base-url', index);
      index += 1;
      continue;
    }
    if (token === '--registry') {
      parsed.registry = readOptionValue('--registry', index);
      index += 1;
      continue;
    }
    throw new Error(`不支持的参数: ${token}`);
  }

  if (parsed.baseUrl === '') {
    parsed.baseUrl = null;
  }
  if (parsed.registry === '') {
    parsed.registry = null;
  }

  return parsed;
}

function buildTargetPaths(scope) {
  const configDir = scope === 'user'
    ? resolveGlobalConfigDir()
    : join(cwd(), '.opencode');

  return {
    bridgeConfigCandidates: [
      join(configDir, 'message-bridge.jsonc'),
      join(configDir, 'message-bridge.json'),
    ],
    opencodeConfigCandidates: scope === 'user'
      ? [join(configDir, 'opencode.jsonc'), join(configDir, 'opencode.json')]
      : [join(cwd(), 'opencode.jsonc'), join(cwd(), 'opencode.json')],
    npmrcPath: scope === 'user' ? resolveUserNpmrcPath() : join(cwd(), '.npmrc'),
  };
}

async function resolveTargetFilePaths(scope) {
  const targetPaths = buildTargetPaths(scope);
  return {
    bridgeConfig: await resolvePreferredExistingPath(...targetPaths.bridgeConfigCandidates),
    opencodeConfig: await resolvePreferredExistingPath(...targetPaths.opencodeConfigCandidates),
    npmrcPath: targetPaths.npmrcPath,
  };
}

function printSetupOverview(scope, bridgeConfig, opencodeConfig, npmrcPath, registryValue, baseUrl) {
  writeLine('Message Bridge 配置向导');
  writeLine(`配置作用域: ${scope}`);
  writeLine(`二维码授权服务: ${baseUrl}`);
  writeLine(`Message Bridge 配置文件: ${bridgeConfig}`);
  writeLine(`OpenCode 配置文件: ${opencodeConfig}`);
  writeLine(`npm scope 配置文件: ${npmrcPath}`);
  writeLine(`默认 npm scope registry: ${registryValue}`);
  writeLine('');
}

function checkOpencodeInstalled() {
  const result = spawnSync('opencode', ['--version'], {
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: 3000,
  });
  if (result.error) {
    return false;
  }
  return result.status === 0;
}

function resolveBaseUrl(cliBaseUrl) {
  const resolved = String(cliBaseUrl ?? env.WECODE_AUTH_BASE_URL ?? '').trim();
  if (!resolved) {
    throw new Error('缺少二维码授权服务 base URL，请通过 --base-url 或 WECODE_AUTH_BASE_URL 提供。');
  }
  return resolved;
}

function resolveMacAddress() {
  const entries = Object.values(networkInterfaces())
    .flat()
    .filter(Boolean);

  const candidate = entries.find((item) => {
    const mac = String(item.mac ?? '').trim();
    return !item.internal && mac && mac !== '00:00:00:00:00:00';
  });

  return candidate?.mac ?? '';
}

async function loadQrCodeAuthRuntime() {
  const override = env.MB_SETUP_QRCODE_AUTH_MODULE;
  if (override) {
    const module = await import(pathToFileURL(override).href);
    if (typeof module.qrcodeAuth?.run !== 'function') {
      throw new Error('二维码授权模块必须导出 qrcodeAuth.run(input)。');
    }
    return module.qrcodeAuth;
  }

  const sourceHref = new URL('../../../packages/skill-qrcode-auth/src/index.ts', import.meta.url).href;
  const packageSpecifier = ['@wecode', 'skill-qrcode-auth'].join('/');
  const attempts = [
    async () => import(packageSpecifier),
    async () => import(sourceHref),
  ];
  const failures = [];

  for (const load of attempts) {
    try {
      const module = await load();
      if (typeof module.qrcodeAuth?.run === 'function') {
        return module.qrcodeAuth;
      }
      failures.push('二维码授权模块必须导出 qrcodeAuth.run(input)。');
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  throw new Error(`无法加载二维码授权模块：${failures.join(' | ')}`);
}

function renderSnapshot(snapshot) {
  switch (snapshot.type) {
    case 'qrcode_generated':
      writeLine('二维码已生成，请使用企业侧应用扫码授权。');
      writeLine(`- qrcode: ${snapshot.qrcode}`);
      writeLine(`- weUrl: ${snapshot.display.weUrl}`);
      writeLine(`- pcUrl: ${snapshot.display.pcUrl}`);
      writeLine(`- expiresAt: ${snapshot.expiresAt}`);
      break;
    case 'scanned':
      writeLine(`二维码已扫码，等待确认：${snapshot.qrcode}`);
      break;
    case 'expired':
      writeLine(`二维码已过期，正在准备刷新：${snapshot.qrcode}`);
      break;
    case 'cancelled':
      writeLine(`二维码授权已取消：${snapshot.qrcode}`);
      break;
    case 'confirmed':
      writeLine(`二维码授权成功：${snapshot.qrcode}`);
      break;
    case 'failed':
      writeLine(`二维码授权失败：${snapshot.reasonCode}${snapshot.qrcode ? ` (${snapshot.qrcode})` : ''}`);
      if (snapshot.serviceError?.message) {
        writeLine(`- service message: ${snapshot.serviceError.message}`);
      }
      break;
  }
}

async function runQrCodeAuth(baseUrl) {
  const qrcodeAuth = await loadQrCodeAuthRuntime();
  let terminalSnapshot = null;
  let credentials = null;

  await qrcodeAuth.run({
    baseUrl,
    channel: DEFAULT_CHANNEL,
    mac: resolveMacAddress(),
    onSnapshot(snapshot) {
      renderSnapshot(snapshot);
      if (snapshot.type === 'confirmed') {
        credentials = snapshot.credentials;
      }
      if (snapshot.type === 'confirmed' || snapshot.type === 'cancelled' || snapshot.type === 'failed') {
        terminalSnapshot = snapshot;
      }
    },
  });

  if (credentials) {
    return credentials;
  }

  if (terminalSnapshot?.type === 'cancelled') {
    throw new Error('二维码授权已取消，未写入任何配置。');
  }
  if (terminalSnapshot?.type === 'failed') {
    throw new Error(`二维码授权失败：${terminalSnapshot.reasonCode}`);
  }

  throw new Error('二维码授权流程异常结束，未获取到 AK/SK。');
}

async function main() {
  const parsed = parseArgs(argv.slice(2));
  if (parsed.help) {
    writeLine(HELP_TEXT);
    return;
  }

  if (parsed.command !== 'install') {
    throw new Error(`不支持的子命令: ${parsed.command}`);
  }

  if (checkOpencodeInstalled()) {
    writeLine('OpenCode 环境检查通过（opencode 可用）。');
  } else {
    writeLine('OpenCode 环境检查提示：未检测到 opencode 命令，将继续写入配置。');
  }

  const scope = parsed.scope;
  const baseUrl = resolveBaseUrl(parsed.baseUrl);
  const { bridgeConfig, opencodeConfig, npmrcPath } = await resolveTargetFilePaths(scope);
  const existingNpmrc = await readOptionalTextFile(npmrcPath);
  const existingScopeRegistry = existingNpmrc ? readScopeRegistry(existingNpmrc) : null;
  const effectiveRegistry = normalizeRegistryUrl(parsed.registry ?? existingScopeRegistry ?? DEFAULT_SCOPE_REGISTRY);
  const existingBridge = await readOptionalTextFile(bridgeConfig);

  printSetupOverview(scope, bridgeConfig, opencodeConfig, npmrcPath, effectiveRegistry, baseUrl);
  writeLine('正在启动二维码授权流程...');
  const credentials = await runQrCodeAuth(baseUrl);

  const existingOpencode = await readOptionalTextFile(opencodeConfig);
  const nextNpmrc = await buildNextNpmrcContent(npmrcPath, parsed.registry);
  let nextBridge;
  let nextOpencode;

  try {
    nextBridge = buildNextBridgeConfig(existingBridge, credentials.ak, credentials.sk);
  } catch {
    throw new Error(`无法安全解析现有 bridge 配置：${bridgeConfig}`);
  }

  try {
    nextOpencode = buildNextOpencodeConfig(existingOpencode);
  } catch {
    throw new Error(`无法安全解析现有 OpenCode 配置：${opencodeConfig}`);
  }

  await writeFileAtomically(bridgeConfig, nextBridge);
  await writeFileAtomically(opencodeConfig, nextOpencode);
  await writeFileAtomically(npmrcPath, nextNpmrc);

  writeLine('配置已完成。');
  writeLine(`1. Message Bridge 配置已写入 ${bridgeConfig}`);
  writeLine(`2. OpenCode 配置已更新 ${opencodeConfig}`);
  writeLine(`3. npm scope 配置已更新 ${npmrcPath}`);
  writeLine('4. 下次启动或重启 OpenCode 时会自动安装并加载 npm 插件。');
}

main().catch((error) => {
  writeError(error instanceof Error ? error.message : String(error));
  exit(1);
});
