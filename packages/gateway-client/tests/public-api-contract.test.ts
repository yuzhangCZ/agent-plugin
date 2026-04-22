import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { gatewayClientFailureTranslator, translateGatewayClientFailure } from '../src/index.ts';

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('public api positive type fixture compiles with stable entry exports', async () => {
  await assert.doesNotReject(async () => {
    await execFileAsync('pnpm', ['exec', 'tsc', '--noEmit', '-p', 'tests/type-contracts/tsconfig.positive.json'], {
      cwd: packageRoot,
    });
  });
});

test('public api negative type fixture rejects importing overrides from stable entry', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'gateway-client-contract-'));
  const tempFixture = path.join(tempDir, 'public-api-negative-overrides.ts');
  writeFileSync(
    tempFixture,
    `import type { GatewayClientOverrides } from ${JSON.stringify(path.resolve(packageRoot, 'src/index.ts'))};\n\nconst _overrides: GatewayClientOverrides = {};\n`,
  );

  await assert.rejects(
    execFileAsync(
      'pnpm',
      [
        'exec',
        'tsc',
        '--noEmit',
        '--target',
        'ES2022',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        '--strict',
        '--allowImportingTsExtensions',
        '--types',
        'node',
        tempFixture,
      ],
      {
        cwd: packageRoot,
      },
    ),
    (error) => {
      const output = typeof error === 'object' && error
        ? `${'stdout' in error ? String(error.stdout) : ''}\n${'stderr' in error ? String(error.stderr) : ''}`
        : '';
      return output.includes('GatewayClientOverrides');
    },
  );
});

test('public api negative type fixture rejects control frames in send payload', async () => {
  await assert.rejects(
    execFileAsync('pnpm', ['exec', 'tsc', '--noEmit', '-p', 'tests/type-contracts/tsconfig.negative.json'], {
      cwd: packageRoot,
    }),
    (error) => {
      const output = typeof error === 'object' && error
        ? `${'stdout' in error ? String(error.stdout) : ''}\n${'stderr' in error ? String(error.stderr) : ''}`
        : '';
      return output.includes('heartbeat');
    },
  );
});

test('public api negative type fixture rejects importing config assembly helper from stable entry', async () => {
  await assert.rejects(
    execFileAsync('pnpm', ['exec', 'tsc', '--noEmit', '-p', 'tests/type-contracts/tsconfig.negative-assemble.json'], {
      cwd: packageRoot,
    }),
    (error) => {
      const output = typeof error === 'object' && error
        ? `${'stdout' in error ? String(error.stdout) : ''}\n${'stderr' in error ? String(error.stderr) : ''}`
        : '';
      return output.includes('assembleGatewayClientConfig');
    },
  );
});

test('public api exports stable neutral failure translator helper', () => {
  const error = {
    code: 'GATEWAY_NOT_READY',
    source: 'state_gate',
    phase: 'before_ready',
    retryable: true,
    message: 'gateway_not_ready',
  } as const;

  assert.deepEqual(gatewayClientFailureTranslator.translate(error), {
    failureClass: 'state_gate',
    code: 'GATEWAY_NOT_READY',
    phase: 'before_ready',
    retryable: true,
  });
  assert.deepEqual(translateGatewayClientFailure(error), {
    failureClass: 'state_gate',
    code: 'GATEWAY_NOT_READY',
    phase: 'before_ready',
    retryable: true,
  });
});

test('public api negative type fixture rejects legacy category-based error shape', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'gateway-client-contract-'));
  const tempFixture = path.join(tempDir, 'public-api-negative-error-shape.ts');
  writeFileSync(
    tempFixture,
    `import type { GatewayClientErrorShape } from ${JSON.stringify(path.resolve(packageRoot, 'src/index.ts'))};\n\nconst _error: GatewayClientErrorShape = {\n  code: 'GATEWAY_WEBSOCKET_ERROR',\n  category: 'transport',\n  retryable: true,\n  message: 'legacy',\n};\n`,
  );

  await assert.rejects(
    execFileAsync(
      'pnpm',
      [
        'exec',
        'tsc',
        '--noEmit',
        '--target',
        'ES2022',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        '--strict',
        '--allowImportingTsExtensions',
        '--types',
        'node',
        tempFixture,
      ],
      {
        cwd: packageRoot,
      },
    ),
    (error) => {
      const output = typeof error === 'object' && error
        ? `${'stdout' in error ? String(error.stdout) : ''}\n${'stderr' in error ? String(error.stderr) : ''}`
        : '';
      return output.includes('category') || output.includes('source');
    },
  );
});

test('failure signal is sufficient for upper-layer neutral consumption', () => {
  function consumeFailureSignal(
    signal: ReturnType<typeof gatewayClientFailureTranslator.translate>,
  ): 'retry_handshake' | 'halt_handshake' | 'ready_transport_drop' | 'protocol_fail_closed' | 'queue_user_action' {
    if (signal.failureClass === 'handshake_failure') {
      return signal.retryable && signal.phase === 'reconnecting' ? 'retry_handshake' : 'halt_handshake';
    }
    if (signal.failureClass === 'transport_failure') {
      return signal.phase === 'ready' ? 'ready_transport_drop' : 'queue_user_action';
    }
    if (signal.failureClass === 'protocol_diagnostic') {
      return signal.code === 'GATEWAY_PROTOCOL_VIOLATION' ? 'protocol_fail_closed' : 'queue_user_action';
    }
    return signal.phase === 'reconnecting' ? 'queue_user_action' : 'halt_handshake';
  }

  assert.equal(consumeFailureSignal(gatewayClientFailureTranslator.translate({
    code: 'GATEWAY_CONNECT_TIMEOUT',
    source: 'handshake',
    phase: 'reconnecting',
    retryable: true,
    message: 'gateway_handshake_timeout',
  })), 'retry_handshake');
  assert.equal(consumeFailureSignal(gatewayClientFailureTranslator.translate({
    code: 'GATEWAY_REGISTER_REJECTED',
    source: 'handshake',
    phase: 'before_ready',
    retryable: false,
    message: 'gateway_register_rejected',
  })), 'halt_handshake');
  assert.equal(consumeFailureSignal(gatewayClientFailureTranslator.translate({
    code: 'GATEWAY_WEBSOCKET_ERROR',
    source: 'transport',
    phase: 'ready',
    retryable: true,
    message: 'gateway_websocket_error',
  })), 'ready_transport_drop');
  assert.equal(consumeFailureSignal(gatewayClientFailureTranslator.translate({
    code: 'GATEWAY_PROTOCOL_VIOLATION',
    source: 'outbound_protocol',
    phase: 'before_ready',
    retryable: false,
    message: 'gateway_invalid_message_type:heartbeat',
  })), 'protocol_fail_closed');
  assert.equal(consumeFailureSignal(translateGatewayClientFailure({
    code: 'GATEWAY_NOT_READY',
    source: 'state_gate',
    phase: 'reconnecting',
    retryable: true,
    message: 'gateway_not_ready',
  })), 'queue_user_action');
});
