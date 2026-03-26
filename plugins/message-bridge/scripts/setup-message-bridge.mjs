#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, stderr, argv, env, cwd, exit } from 'node:process';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { mkdtemp, readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { platform } from 'node:process';

const PLUGIN_NAME = '@wecode/skill-opencode-plugin';
const NPM_SCOPE_REGISTRY_LINE = '@wecode:registry=';
const DEFAULT_SCOPE_REGISTRY = 'https://cmc.centralrepo.rnd.huawei.com/artifactory/api/npm/product_npm/';
const HELP_TEXT = `Message Bridge 安装 CLI

用法:
  node ./scripts/setup-message-bridge.mjs install [options]
  node ./scripts/setup-message-bridge.mjs [options]  # 兼容旧入口，等价于 install

选项:
  --ak <value>        指定 AK
  --sk <value>        指定 SK
  --registry <url>    指定 @wecode scope registry
  --scope <value>     user | project，默认 user
  --yes               跳过确认；缺少必填字段时直接失败
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
  const currentPlatform = env.MB_SETUP_PLATFORM || platform;
  if (env.XDG_CONFIG_HOME) {
    return join(env.XDG_CONFIG_HOME, 'opencode');
  }
  if (currentPlatform === 'win32') {
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

  const currentPlatform = env.MB_SETUP_PLATFORM || platform;
  if (currentPlatform === 'win32') {
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

function readConfiguredCredential(content, key) {
  const match = content.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`, 'm'));
  return match?.[1] ?? '';
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
      // 保持文本级改写，尽量只更新 auth 下的目标字段。
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

class PromptSession {
  constructor() {
    this.queue = [];
    this.useBufferedInput = false;
    this.readline = null;
  }

  async init() {
    if (stdin.isTTY && stdout.isTTY) {
      this.readline = createInterface({ input: stdin, output: stdout });
      return;
    }

    this.useBufferedInput = true;

    // 非 TTY/半 TTY 场景统一读取整段 stdin，便于 bat、测试和脚本管道调用。
    const piped = await new Promise((resolve, reject) => {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (chunk) => {
        data += chunk;
      });
      stdin.on('end', () => resolve(data));
      stdin.on('error', reject);
    });
    this.queue = piped.split(/\r?\n/);
  }

  async ask(promptLabel, currentValue = '') {
    if (this.useBufferedInput) {
      writeLine(currentValue ? `${promptLabel} [${currentValue}]` : promptLabel);
      const value = this.queue.shift() ?? '';
      return value.trim() ? value.trim() : currentValue;
    }

    const prompt = currentValue ? `${promptLabel} [${currentValue}]: ` : `${promptLabel}: `;
    const value = await this.readline.question(prompt);
    return value.trim() ? value.trim() : currentValue;
  }

  async confirmAction(promptLabel) {
    if (this.useBufferedInput) {
      writeLine(`${promptLabel} [y/N]`);
      const value = (this.queue.shift() ?? '').trim().toLowerCase();
      return value === 'y' || value === 'yes';
    }

    const answer = await this.readline.question(`${promptLabel} [y/N]: `);
    const normalized = answer.trim().toLowerCase();
    return normalized === 'y' || normalized === 'yes';
  }

  async close() {
    await this.readline?.close();
  }
}

async function promptRequiredField(prompts, fieldName, promptLabel, currentValue = '') {
  while (true) {
    const value = await prompts.ask(promptLabel, currentValue);
    if (value) {
      return value;
    }
    writeError(`${fieldName} 不能为空，请重新输入`);
  }
}

function parseArgs(rawArgs) {
  const parsed = {
    command: 'install',
    scope: 'user',
    ak: null,
    sk: null,
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
    if (token === '--ak') {
      parsed.ak = readOptionValue('--ak', index);
      index += 1;
      continue;
    }
    if (token === '--sk') {
      parsed.sk = readOptionValue('--sk', index);
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

  if (parsed.ak === '') {
    parsed.ak = null;
  }
  if (parsed.sk === '') {
    parsed.sk = null;
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
    configDir,
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

function printSetupOverview(scope, bridgeConfig, opencodeConfig, npmrcPath, registryValue) {
  writeLine('Message Bridge 配置向导');
  writeLine(`配置作用域: ${scope}`);
  writeLine(`Message Bridge 配置文件: ${bridgeConfig}`);
  writeLine(`OpenCode 配置文件: ${opencodeConfig}`);
  writeLine(`npm scope 配置文件: ${npmrcPath}`);
  writeLine(`默认 npm scope registry: ${registryValue}`);
  writeLine('');
}

function printChangePreview(ak, sk, registry) {
  writeLine('');
  writeLine('即将写入以下配置：');
  writeLine(`- AK: ${ak}`);
  writeLine(`- SK: ${sk}`);
  writeLine(`- OpenCode plugin: ${PLUGIN_NAME}`);
  writeLine(`- npm scope: ${NPM_SCOPE_REGISTRY_LINE}${registry}`);
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

async function resolveCredential(parsedValue, existingValue, prompts, fieldName, promptLabel, nonInteractive) {
  if (parsedValue) {
    return parsedValue;
  }
  if (nonInteractive) {
    if (existingValue) {
      return existingValue;
    }
    throw new Error(`--yes 模式下必须提供 ${fieldName} 或确保现有配置包含该字段`);
  }
  return promptRequiredField(prompts, fieldName, promptLabel, existingValue);
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
    writeLine('OpenCode 预检通过：已检测到 opencode 命令。');
  } else {
    writeError('OpenCode 预检未通过：未检测到 opencode 命令，将继续写入配置。');
  }

  const scope = parsed.scope;
  const { bridgeConfig, opencodeConfig, npmrcPath } = await resolveTargetFilePaths(scope);
  const existingNpmrc = await readOptionalTextFile(npmrcPath);
  const existingScopeRegistry = existingNpmrc ? readScopeRegistry(existingNpmrc) : null;
  const effectiveRegistry = normalizeRegistryUrl(parsed.registry ?? existingScopeRegistry ?? DEFAULT_SCOPE_REGISTRY);

  const existingBridge = await readOptionalTextFile(bridgeConfig);
  const currentAk = existingBridge ? readConfiguredCredential(existingBridge, 'ak') : '';
  const currentSk = existingBridge ? readConfiguredCredential(existingBridge, 'sk') : '';

  const prompts = new PromptSession();
  await prompts.init();

  try {
    printSetupOverview(scope, bridgeConfig, opencodeConfig, npmrcPath, effectiveRegistry);

    const ak = await resolveCredential(
      parsed.ak,
      currentAk,
      prompts,
      'AK',
      '请输入 AK（必填）',
      parsed.yes,
    );
    const sk = await resolveCredential(
      parsed.sk,
      currentSk,
      prompts,
      'SK',
      '请输入 SK（必填）',
      parsed.yes,
    );

    printChangePreview(ak, sk, effectiveRegistry);

    const confirmed = parsed.yes ? true : await prompts.confirmAction('确认写入以上配置');
    if (!confirmed) {
      writeLine('已取消，未写入任何文件。');
      return;
    }

    const existingOpencode = await readOptionalTextFile(opencodeConfig);
    const nextNpmrc = await buildNextNpmrcContent(npmrcPath, parsed.registry);
    let nextBridge;
    let nextOpencode;

    try {
      nextBridge = buildNextBridgeConfig(existingBridge, ak, sk);
    } catch {
      throw new Error(`无法安全解析现有 bridge 配置：${bridgeConfig}`);
    }

    try {
      nextOpencode = buildNextOpencodeConfig(existingOpencode);
    } catch {
      throw new Error(`无法安全解析现有 OpenCode 配置：${opencodeConfig}`);
    }

    // 先生成所有目标内容，再统一落盘，避免部分写入成功后中途失败。
    await writeFileAtomically(bridgeConfig, nextBridge);
    await writeFileAtomically(opencodeConfig, nextOpencode);
    await writeFileAtomically(npmrcPath, nextNpmrc);

    writeLine('配置已完成。');
    writeLine(`1. Message Bridge 配置已写入 ${bridgeConfig}`);
    writeLine(`2. OpenCode 配置已更新 ${opencodeConfig}`);
    writeLine(`3. npm scope 配置已更新 ${npmrcPath}`);
    writeLine('4. 下次启动或重启 OpenCode 时会自动安装并加载 npm 插件。');
    writeLine('5. 若首次 npx 无法拉取安装包，可执行:');
    writeLine(`   npx -y --registry=${DEFAULT_SCOPE_REGISTRY} ${PLUGIN_NAME} install`);
  } finally {
    await prompts.close();
  }
}

main().catch((error) => {
  writeError(error instanceof Error ? error.message : String(error));
  exit(1);
});
