import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '../../..');

const toolEventModelPath = resolve(repoRoot, 'packages/gateway-schema/src/contract/literals/tool-event.ts');
const downstreamModelPath = resolve(repoRoot, 'packages/gateway-schema/src/contract/literals/downstream.ts');
const upstreamModelPath = resolve(repoRoot, 'packages/gateway-schema/src/contract/literals/upstream.ts');
const downstreamValidatorDir = resolve(repoRoot, 'packages/gateway-schema/src/adapters/validators');
const bridgeGatewayWireDir = resolve(repoRoot, 'plugins/message-bridge/src/gateway-wire');
const openclawGatewayWireDir = resolve(repoRoot, 'plugins/message-bridge-openclaw/src/gateway-wire');
const packagesDir = resolve(repoRoot, 'packages');
const pluginsDir = resolve(repoRoot, 'plugins');
const ALLOWED_PROTOCOL_LITERAL_FACADE_FILES = new Set([
  resolve(repoRoot, 'plugins/message-bridge/src/gateway-wire/transport.ts'),
  resolve(repoRoot, 'plugins/message-bridge-openclaw/src/gateway-wire/transport.ts'),
]);

const PROTOCOL_LITERALS = [
  'message.updated',
  'message.part.updated',
  'message.part.delta',
  'message.part.removed',
  'session.status',
  'session.idle',
  'session.updated',
  'session.error',
  'permission.updated',
  'permission.asked',
  'question.asked',
  'status_query',
  'invoke',
  'chat',
  'create_session',
  'close_session',
  'abort_session',
  'permission_reply',
  'question_reply',
  'register',
  'heartbeat',
  'tool_event',
  'tool_done',
  'tool_error',
  'session_created',
  'status_response',
  'once',
  'always',
  'reject',
];

const PROTOCOL_LITERAL_PATTERNS = PROTOCOL_LITERALS.map((literal) => new RegExp(`['"]${literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`, 'g'));
const LEGACY_GATEWAY_WIRE_PATH_PATTERNS = [
  'src/domain/model/',
  'src/domain/error/',
  'src/adapters/zod/schemas/',
];

async function collectTsFiles(rootDir) {
  const result = [];
  const entries = await readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const filePath = resolve(rootDir, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await collectTsFiles(filePath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      result.push(filePath);
    }
  }
  return result;
}

async function collectCodeFiles(rootDir) {
  const result = [];
  const entries = await readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const filePath = resolve(rootDir, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await collectCodeFiles(filePath)));
      continue;
    }
    if (entry.isFile() && /\.(?:ts|mjs)$/.test(entry.name)) {
      result.push(filePath);
    }
  }
  return result;
}

function hasChineseCommentNear(lines, index) {
  const start = Math.max(0, index - 2);
  for (let i = index - 1; i >= start; i -= 1) {
    if (/\/\//.test(lines[i]) && /[\u4e00-\u9fff]/.test(lines[i])) {
      return true;
    }
  }
  return false;
}

test('shared tool-event model forbids open index signatures', async () => {
  const [toolEventSource, downstreamSource, upstreamSource] = await Promise.all([
    readFile(toolEventModelPath, 'utf8'),
    readFile(downstreamModelPath, 'utf8'),
    readFile(upstreamModelPath, 'utf8'),
  ]);

  for (const [label, source] of [
    ['tool-event', toolEventSource],
    ['downstream', downstreamSource],
    ['upstream', upstreamSource],
  ]) {
    assert.equal(source.includes('[key: string]: unknown'), false, `${label} should not keep open index signatures`);
  }
});

test('boundary unknown usage must carry a Chinese explanation comment', async () => {
  const files = [
    toolEventModelPath,
    downstreamModelPath,
    upstreamModelPath,
    ...(await collectTsFiles(downstreamValidatorDir)),
  ];

  for (const filePath of files) {
    const source = await readFile(filePath, 'utf8');
    const lines = source.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!/\bunknown\b/.test(line)) {
        return;
      }

      assert.ok(
        hasChineseCommentNear(lines, index),
        `${basename(filePath)}:${index + 1} contains unknown without a Chinese explanation comment`,
      );
    });
  }
});

test('protocol implementation files do not retain bare protocol literals', async () => {
  const files = [
    ...(await collectTsFiles(bridgeGatewayWireDir)),
    ...(await collectTsFiles(openclawGatewayWireDir)),
  ];

  for (const filePath of files) {
    // 统一传输常量门面允许显式导出协议字面量，避免索引映射随共享协议扩容而漂移。
    if (ALLOWED_PROTOCOL_LITERAL_FACADE_FILES.has(filePath)) {
      continue;
    }
    const source = await readFile(filePath, 'utf8');
    for (let index = 0; index < PROTOCOL_LITERALS.length; index += 1) {
      const matches = source.match(PROTOCOL_LITERAL_PATTERNS[index]);
      assert.equal(matches !== null, false, `${basename(filePath)} should not contain bare protocol literal ${PROTOCOL_LITERALS[index]}`);
    }
  }
});

test('gateway-wire legacy source paths must not reappear in workspace code', async () => {
  const files = [
    ...(await collectCodeFiles(packagesDir)),
    ...(await collectCodeFiles(pluginsDir)),
  ];

  for (const filePath of files) {
    if (filePath === __filename) {
      continue;
    }
    const source = await readFile(filePath, 'utf8');
    for (const legacyPath of LEGACY_GATEWAY_WIRE_PATH_PATTERNS) {
      assert.equal(
        source.includes(legacyPath),
        false,
        `${basename(filePath)} should not reference removed gateway-wire path ${legacyPath}`,
      );
    }
  }
});
