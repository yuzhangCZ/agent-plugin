import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mapGatewayClientAvailability } from '../src/index.ts';

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

test('public api exports stable gateway availability mapper', () => {
  const error = {
    code: 'GATEWAY_NOT_READY',
    disposition: 'diagnostic',
    stage: 'handshake',
    retryable: true,
    message: 'gateway_not_ready',
  } as const;

  assert.equal(mapGatewayClientAvailability(error), null);
});

test('public api negative type fixture rejects legacy category-based error shape', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'gateway-client-contract-'));
  const tempFixture = path.join(tempDir, 'public-api-negative-error-shape.ts');
  writeFileSync(
    tempFixture,
    `import type { GatewayClientErrorShape } from ${JSON.stringify(path.resolve(packageRoot, 'src/index.ts'))};\n\nconst _error: GatewayClientErrorShape = {\n  code: 'GATEWAY_TRANSPORT_ERROR',\n  category: 'transport',\n  retryable: true,\n  message: 'legacy',\n};\n`,
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
      return output.includes('category') || output.includes('source') || output.includes('phase');
    },
  );
});

test('availability mapper is sufficient for upper-layer neutral consumption', () => {
  function consumeAvailability(
    availability: ReturnType<typeof mapGatewayClientAvailability>,
  ): 'queue_user_action' | 'server_unavailable' | 'network_unavailable' {
    switch (availability) {
      case 'remote_unavailable':
        return 'server_unavailable';
      case 'transport_unavailable':
        return 'network_unavailable';
      case null:
        return 'queue_user_action';
    }
  }

  assert.equal(consumeAvailability(mapGatewayClientAvailability({
    code: 'GATEWAY_HANDSHAKE_TIMEOUT',
    disposition: 'startup_failure',
    stage: 'handshake',
    retryable: true,
    message: 'gateway_handshake_timeout',
  })), 'server_unavailable');
  assert.equal(consumeAvailability(mapGatewayClientAvailability({
    code: 'GATEWAY_HANDSHAKE_REJECTED',
    disposition: 'startup_failure',
    stage: 'handshake',
    retryable: false,
    message: 'gateway_register_rejected',
  })), 'server_unavailable');
  assert.equal(consumeAvailability(mapGatewayClientAvailability({
    code: 'GATEWAY_TRANSPORT_ERROR',
    disposition: 'runtime_failure',
    stage: 'ready',
    retryable: true,
    message: 'gateway_websocket_error',
  })), 'network_unavailable');
  assert.equal(consumeAvailability(mapGatewayClientAvailability({
    code: 'GATEWAY_OUTBOUND_PROTOCOL_INVALID',
    disposition: 'diagnostic',
    stage: 'ready',
    retryable: false,
    message: 'gateway_invalid_message_type:heartbeat',
  })), 'queue_user_action');
  assert.equal(consumeAvailability(mapGatewayClientAvailability({
    code: 'GATEWAY_NOT_READY',
    disposition: 'diagnostic',
    stage: 'handshake',
    retryable: true,
    message: 'gateway_not_ready',
  })), 'queue_user_action');
});
