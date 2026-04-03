import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GATEWAY_WIRE_TOOL_EVENT_FIXTURES,
  GATEWAY_WIRE_SIMPLE_TOOL_EVENT_FIXTURES,
  createGatewayWireCreateSessionInvokeMessage,
  createGatewayWireLegacyCreateSessionInvokeMessage,
  createGatewayWireMessageUpdatedEvent,
  createGatewayWireMessagePartUpdatedToolEvent,
  createGatewayWireSessionStatusEvent,
  createGatewayWirePermissionUpdatedEvent,
} from '../fixtures/index.mjs';
import {
  assertMessagePartUpdatedShape,
  assertSimpleToolEventShape,
  assertProjectedMessageUpdatedShape,
  assertWireViolationShape,
} from '../assertions/index.mjs';
import {
  DOWNSTREAM_MESSAGE_TYPES,
  INVOKE_ACTIONS,
} from '../../gateway-wire-v1/src/contract/literals/downstream.ts';
import {
  SUPPORTED_TOOL_EVENT_TYPES,
} from '../../gateway-wire-v1/src/contract/literals/tool-event.ts';
import {
  TRANSPORT_UPSTREAM_MESSAGE_TYPES,
  UPSTREAM_MESSAGE_TYPES,
  TOOL_ERROR_REASONS,
} from '../../gateway-wire-v1/src/contract/literals/upstream.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '../../..');

const docsArchitecturePath = resolve(repoRoot, 'docs/architecture/gateway-wire-v1-architecture.md');
const docsEventContractPath = resolve(repoRoot, 'docs/design/interfaces/gateway-wire-v1-event-contract.md');
const pluginPackageJsonPath = resolve(repoRoot, 'plugins/message-bridge/package.json');
const lockfilePath = resolve(repoRoot, 'pnpm-lock.yaml');

function extractToolEventSectionHeadings(markdown) {
  return [...markdown.matchAll(/^##\s+`?([^`\n]+)`?\s*$/gm)]
    .map((match) => match[1])
    .filter((heading) => SUPPORTED_TOOL_EVENT_TYPES.includes(heading));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getSection(markdown, heading) {
  const sectionHeadingPattern = new RegExp(String.raw`^##\s+\`?${escapeRegExp(heading)}\`?\s*$`, 'm');
  const startMatch = markdown.match(sectionHeadingPattern);
  if (!startMatch || startMatch.index === undefined) {
    return null;
  }

  const start = startMatch.index;
  const rest = markdown.slice(start + startMatch[0].length);
  const nextHeadingMatch = rest.match(/\n##\s+`?[^`\n]+`?\s*$/m);
  const end = nextHeadingMatch ? start + startMatch[0].length + nextHeadingMatch.index : markdown.length;
  return markdown.slice(start, end);
}

test('gateway wire fixtures expose canonical and legacy create_session inputs', () => {
  const canonical = createGatewayWireCreateSessionInvokeMessage();
  const legacy = createGatewayWireLegacyCreateSessionInvokeMessage();

  assert.strictEqual(canonical.type, 'invoke');
  assert.strictEqual(canonical.action, 'create_session');
  assert.deepStrictEqual(canonical.payload, {
    title: 'gateway-wire session',
    assistantId: 'persona-gateway',
  });

  assert.strictEqual(legacy.type, 'invoke');
  assert.strictEqual(legacy.action, 'create_session');
  assert.deepStrictEqual(legacy.payload, {
    sessionId: 'legacy-session-id',
    metadata: { source: 'legacy-openclaw' },
  });
});

test('gateway wire tool_event fixtures stay aligned with supported event types', () => {
  assert.deepStrictEqual(
    GATEWAY_WIRE_TOOL_EVENT_FIXTURES.map((fixture) => fixture.type),
    SUPPORTED_TOOL_EVENT_TYPES,
  );

  for (const fixture of GATEWAY_WIRE_TOOL_EVENT_FIXTURES) {
    const event = fixture.build();
    assert.strictEqual(event.type, fixture.type);
  }
});

test('gateway wire simple tool_event fixtures stay aligned with the shared contract subset', () => {
  assert.deepStrictEqual(
    GATEWAY_WIRE_SIMPLE_TOOL_EVENT_FIXTURES.map((fixture) => fixture.type),
    [
      'message.part.delta',
      'message.part.removed',
      'session.status',
      'session.idle',
      'session.updated',
      'session.error',
      'permission.updated',
      'permission.asked',
      'question.asked',
    ],
  );

  assert.doesNotThrow(() =>
    assertSimpleToolEventShape(createGatewayWireSessionStatusEvent(), {
      type: 'session.status',
      properties: {
        sessionID: 'tool-gateway-wire',
        status: { type: 'busy' },
      },
    }),
  );
  assert.doesNotThrow(() =>
    assertSimpleToolEventShape(createGatewayWirePermissionUpdatedEvent(), {
      type: 'permission.updated',
      properties: {
        sessionID: 'tool-gateway-wire',
        id: 'perm-gateway-wire',
        status: 'granted',
      },
    }),
  );
});

test('gateway wire message.updated fixture stays in projected shape', () => {
  const event = createGatewayWireMessageUpdatedEvent();

  assertProjectedMessageUpdatedShape(event, {
    hasSummary: true,
    additions: 12,
    deletions: 3,
    files: 2,
    diffCount: 1,
  });
});

test('gateway wire message.part.updated tool fixture stays in projected shape', () => {
  const event = createGatewayWireMessagePartUpdatedToolEvent();

  assertMessagePartUpdatedShape(event, {
    part: {
      id: 'part-gateway-wire-tool',
      sessionID: 'tool-gateway-wire',
      messageID: 'msg-gateway-wire-tool',
      type: 'tool',
      tool: 'search',
      callID: 'call-gateway-wire-tool',
      state: {
        status: 'completed',
        output: {
          total: 3,
          nested: {
            ok: true,
          },
        },
        error: 'tool failed',
        title: 'Search results',
      },
    },
  });
});

test('gateway wire docs must declare the reference host version and field-table contract', async () => {
  const [architectureDoc, eventDoc, packageJson, lockfile] = await Promise.all([
    readFile(docsArchitecturePath, 'utf8'),
    readFile(docsEventContractPath, 'utf8'),
    readFile(pluginPackageJsonPath, 'utf8'),
    readFile(lockfilePath, 'utf8'),
  ]);

  const manifest = JSON.parse(packageJson);

  assert.strictEqual(manifest.devDependencies['@opencode-ai/plugin'], '1.2.15');
  assert.strictEqual(manifest.devDependencies['@opencode-ai/sdk'], '1.2.15');
  assert.match(lockfile, /@opencode-ai\/plugin@1\.2\.15/);
  assert.match(lockfile, /@opencode-ai\/sdk@1\.2\.15/);
  assert.match(architectureDoc, /@opencode-ai\/plugin@1\.2\.15/);
  assert.match(architectureDoc, /@opencode-ai\/sdk@1\.2\.15/);
  assert.match(eventDoc, /@opencode-ai\/plugin@1\.2\.15/);
  assert.match(eventDoc, /@opencode-ai\/sdk@1\.2\.15/);

  const docEventTypes = extractToolEventSectionHeadings(eventDoc);
  assert.deepStrictEqual(docEventTypes, SUPPORTED_TOOL_EVENT_TYPES);

  for (const eventType of SUPPORTED_TOOL_EVENT_TYPES) {
    const section = getSection(eventDoc, eventType);
    assert.ok(section, `missing section for ${eventType}`);
    assert.match(section, /\| 字段路径 \| 类型 \| 必填 \| 取值\/枚举 \| 说明 \| 来源 \| 参考宿主版本 \|/);
  }
});

test('gateway wire constants stay aligned with downstream and transport capability sets', () => {
  assert.deepStrictEqual(DOWNSTREAM_MESSAGE_TYPES, ['invoke', 'status_query']);
  assert.deepStrictEqual(INVOKE_ACTIONS, [
    'chat',
    'create_session',
    'close_session',
    'permission_reply',
    'abort_session',
    'question_reply',
  ]);
  assert.deepStrictEqual(TRANSPORT_UPSTREAM_MESSAGE_TYPES, [
    'register',
    'register_ok',
    'register_rejected',
    'heartbeat',
    'tool_event',
    'tool_done',
    'tool_error',
    'session_created',
    'status_response',
  ]);
  assert.deepStrictEqual(UPSTREAM_MESSAGE_TYPES, TRANSPORT_UPSTREAM_MESSAGE_TYPES);
  assert.deepStrictEqual(TOOL_ERROR_REASONS, ['session_not_found']);
});

test('wire violation assertions cover the shared error envelope', () => {
  assert.doesNotThrow(() =>
    assertWireViolationShape(
      {
        stage: 'payload',
        code: 'missing_required_field',
        field: 'welinkSessionId',
        message: 'welinkSessionId is required',
        messageType: 'invoke',
        action: 'create_session',
      },
      {
        stage: 'payload',
        code: 'missing_required_field',
        field: 'welinkSessionId',
        message: 'welinkSessionId is required',
        messageType: 'invoke',
        action: 'create_session',
      },
    ),
  );
});
