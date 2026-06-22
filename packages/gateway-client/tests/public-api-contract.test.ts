import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  GatewayClientError,
  GatewayClientStatus,
  mapGatewayClientAvailability,
} from '../src/index.ts';

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function assertNever(value: never): never {
  throw new Error(`Unhandled availability value: ${String(value)}`);
}

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

test('public api negative type fixture rejects gateway error stage field', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'gateway-client-contract-'));
  const tempFixture = path.join(tempDir, 'public-api-negative-error-stage.ts');
  writeFileSync(
    tempFixture,
    `import type { GatewayClientErrorShape } from ${JSON.stringify(path.resolve(packageRoot, 'src/index.ts'))};\n\ndeclare const error: GatewayClientErrorShape;\nvoid error.stage;\n`,
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
      return output.includes('stage');
    },
  );
});

test('public api negative type fixture rejects gateway status data fields', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'gateway-client-contract-'));
  const tempFixture = path.join(tempDir, 'public-api-negative-status-fields.ts');
  writeFileSync(
    tempFixture,
    `import type { GatewayClient } from ${JSON.stringify(path.resolve(packageRoot, 'src/index.ts'))};\n\ndeclare const client: GatewayClient;\nconst status = client.getStatus();\nvoid status.phase;\nvoid status.code;\nvoid status.message;\nvoid status.retryable;\n`,
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
      return output.includes('phase')
        && output.includes('code')
        && output.includes('message')
        && output.includes('retryable');
    },
  );
});

test('gateway status does not expose mutable runtime status fields', () => {
  const status = GatewayClientStatus.ready();

  assert.deepEqual(Object.keys(status), []);
  assert.equal('kind' in status, false);
  assert.equal('error' in status, false);
  assert.equal(JSON.stringify(status), '{}');

  assert.throws(
    () => {
      (status as unknown as { kind: string }).kind = 'closed';
    },
    TypeError,
  );
  assert.equal(status.isReady(), true);
});

test('gateway status exposes minimal diagnostic fields for logs', () => {
  assert.deepEqual(GatewayClientStatus.ready().toDiagnosticFields(), {
    status: 'ready',
    available: true,
  });
  assert.deepEqual(GatewayClientStatus.connecting().toDiagnosticFields(), {
    status: 'connecting',
    available: false,
  });
  assert.deepEqual(GatewayClientStatus.reconnecting().toDiagnosticFields(), {
    status: 'reconnecting',
    available: false,
  });
  assert.deepEqual(GatewayClientStatus.closed().toDiagnosticFields(), {
    status: 'closed',
    available: false,
  });

  const manualClosed = GatewayClientStatus.closed(new GatewayClientError({
    code: 'GATEWAY_CLOSED_MANUAL',
    disposition: 'cancelled',
    retryable: false,
    message: 'gateway_closed_manual',
  }));

  assert.deepEqual(manualClosed.toDiagnosticFields(), {
    status: 'closed',
    available: false,
    errorCode: 'GATEWAY_CLOSED_MANUAL',
    errorDisposition: 'cancelled',
    errorRetryable: false,
    errorMessage: 'gateway_closed_manual',
  });
  assert.equal('cancelled' in manualClosed.toDiagnosticFields(), false);
  assert.equal('closed' in manualClosed.toDiagnosticFields(), false);
  assert.equal('ready' in manualClosed.toDiagnosticFields(), false);
  assert.equal('retryable' in manualClosed.toDiagnosticFields(), false);
});

test('gateway status rejects diagnostic errors as closed terminal state', () => {
  const diagnostic = new GatewayClientError({
    code: 'GATEWAY_NOT_READY',
    disposition: 'diagnostic',
    retryable: true,
    message: 'gateway_not_ready',
  });

  assert.throws(
    () => GatewayClientStatus.closed(diagnostic),
    /GatewayClientStatus\.closed cannot accept diagnostic error GATEWAY_NOT_READY/,
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
      default:
        return assertNever(availability);
    }
  }

  assert.equal(consumeAvailability(mapGatewayClientAvailability({
    code: 'GATEWAY_HANDSHAKE_TIMEOUT',
    disposition: 'startup_failure',
    retryable: true,
    message: 'gateway_handshake_timeout',
  })), 'server_unavailable');
  assert.equal(consumeAvailability(mapGatewayClientAvailability({
    code: 'GATEWAY_HANDSHAKE_REJECTED',
    disposition: 'startup_failure',
    retryable: false,
    message: 'gateway_register_rejected',
  })), 'server_unavailable');
  assert.equal(consumeAvailability(mapGatewayClientAvailability({
    code: 'GATEWAY_TRANSPORT_ERROR',
    disposition: 'runtime_failure',
    retryable: true,
    message: 'gateway_websocket_error',
  })), 'network_unavailable');
  assert.equal(consumeAvailability(mapGatewayClientAvailability({
    code: 'GATEWAY_TRANSPORT_ERROR',
    disposition: 'runtime_failure',
    retryable: false,
    message: 'gateway_runtime_transport_closed',
    details: {
      closeCode: 4403,
    },
  })), 'server_unavailable');
  assert.equal(consumeAvailability(mapGatewayClientAvailability({
    code: 'GATEWAY_OUTBOUND_PROTOCOL_INVALID',
    disposition: 'diagnostic',
    retryable: false,
    message: 'gateway_invalid_message_type:heartbeat',
  })), 'queue_user_action');
  assert.equal(consumeAvailability(mapGatewayClientAvailability({
    code: 'GATEWAY_NOT_READY',
    disposition: 'diagnostic',
    retryable: true,
    message: 'gateway_not_ready',
  })), 'queue_user_action');
});
