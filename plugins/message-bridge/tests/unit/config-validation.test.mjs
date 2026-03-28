import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ConfigValidationAggregateError,
  loadConfig,
  validateConfig,
} from '../../src/config/index.ts';
import { AppLogger } from '../../src/runtime/AppLogger.ts';

const originalHome = process.env.HOME;
const originalBridgeDirectory = process.env.BRIDGE_DIRECTORY;

const createValidConfig = (overrides = {}) => ({
  config_version: 1,
  enabled: true,
  gateway: {
    url: 'ws://localhost:8081/ws/agent',
    channel: 'openx',
    heartbeatIntervalMs: 30000,
    reconnect: {
      baseMs: 1000,
      maxMs: 30000,
      exponential: true,
    },
  },
  sdk: {
    timeoutMs: 10000,
  },
  auth: {
    ak: 'test-ak-001',
    sk: 'test-sk-secret-001',
  },
  events: {
    allowlist: ['message.updated'],
  },
  ...overrides,
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (originalBridgeDirectory === undefined) {
    delete process.env.BRIDGE_DIRECTORY;
  } else {
    process.env.BRIDGE_DIRECTORY = originalBridgeDirectory;
  }
});

describe('config validation for sdk.baseUrl compatibility', () => {
  test('validateConfig passes without sdk.baseUrl', () => {
    const errors = validateConfig({
      config_version: 1,
      enabled: true,
      gateway: {
        url: 'ws://localhost:8081/ws/agent',
        heartbeatIntervalMs: 30000,
        reconnect: {
          baseMs: 1000,
          maxMs: 30000,
          exponential: true,
        },
      },
      sdk: {
        timeoutMs: 10000,
      },
      auth: {
        ak: 'test-ak-001',
        sk: 'test-sk-secret-001',
      },
      events: {
        allowlist: ['message.updated'],
      },
    });

    assert.deepStrictEqual(errors, []);
  });

  test('validateConfig allows sdk.baseUrl', () => {
    const errors = validateConfig({
      config_version: 1,
      enabled: true,
      gateway: {
        url: 'ws://localhost:8081/ws/agent',
        heartbeatIntervalMs: 30000,
        reconnect: {
          baseMs: 1000,
          maxMs: 30000,
          exponential: true,
        },
      },
      sdk: {
        timeoutMs: 10000,
        baseUrl: 'http://localhost:54321',
      },
      auth: {
        ak: 'test-ak-001',
        sk: 'test-sk-secret-001',
      },
      events: {
        allowlist: ['message.updated'],
      },
    });

    assert.deepStrictEqual(errors, []);
  });

  test('loadConfig keeps sdk.baseUrl when project config contains it', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-cfg-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
    process.env.HOME = fakeHome;

    await mkdir(join(workspace, '.opencode'), { recursive: true });
    await writeFile(
      join(workspace, '.opencode', 'message-bridge.jsonc'),
      JSON.stringify({
        config_version: 1,
        enabled: true,
        gateway: {
          url: 'ws://localhost:8081/ws/agent',
          heartbeatIntervalMs: 30000,
          reconnect: {
            baseMs: 1000,
            maxMs: 30000,
            exponential: true,
          },
        },
        sdk: {
          timeoutMs: 10000,
          baseUrl: 'http://localhost:54321',
        },
        auth: {
          ak: 'test-ak-001',
          sk: 'test-sk-secret-001',
        },
        events: {
          allowlist: ['message.updated'],
        },
      }),
      'utf8',
    );

    try {
      const config = await loadConfig(workspace);
      assert.strictEqual(config.sdk.timeoutMs, 10000);
      assert.strictEqual(config.sdk.baseUrl, 'http://localhost:54321');
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test('loadConfig writes structured config logs through logger', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-cfg-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
    process.env.HOME = fakeHome;

    await mkdir(join(workspace, '.opencode'), { recursive: true });
    await writeFile(
      join(workspace, '.opencode', 'message-bridge.jsonc'),
      JSON.stringify({
        config_version: 1,
        enabled: true,
        gateway: {
          url: 'ws://localhost:8081/ws/agent',
          heartbeatIntervalMs: 30000,
          reconnect: {
            baseMs: 1000,
            maxMs: 30000,
            exponential: true,
          },
        },
        sdk: {
          timeoutMs: 10000,
        },
        auth: {
          ak: 'test-ak-001',
          sk: 'test-sk-secret-001',
        },
        events: {
          allowlist: ['message.updated'],
        },
      }),
      'utf8',
    );

    const calls = [];
    const logger = new AppLogger(
      {
        app: {
          log: async (options) => {
            calls.push(options);
          },
        },
      },
      { component: 'test' },
      undefined,
      undefined,
      true,
    );

    try {
      const config = await loadConfig(workspace, logger);
      assert.strictEqual(config.enabled, true);
      await new Promise((r) => setTimeout(r, 10));

      const messages = calls.map((entry) => entry.body.message);
      assert.ok(messages.includes('config.resolve.started'));
      assert.ok(messages.includes('config.source.loaded'));
      assert.ok(messages.includes('config.resolve.completed'));
      assert.ok(messages.includes('config.validation.passed'));

      const completed = calls.find((entry) => entry.body.message === 'config.resolve.completed');
      assert.strictEqual(completed.body.extra.component, 'config');
      assert.ok(completed.body.extra.sources.includes('default'));
      assert.ok(completed.body.extra.sources.includes(
        `project:${join(workspace, '.opencode', 'message-bridge.jsonc')}`,
      ));
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test('loadConfig does not log validation failures for sdk.baseUrl', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-cfg-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
    process.env.HOME = fakeHome;

    await mkdir(join(workspace, '.opencode'), { recursive: true });
    await writeFile(
      join(workspace, '.opencode', 'message-bridge.jsonc'),
      JSON.stringify({
        config_version: 1,
        enabled: true,
        gateway: {
          url: 'ws://localhost:8081/ws/agent',
          heartbeatIntervalMs: 30000,
          reconnect: {
            baseMs: 1000,
            maxMs: 30000,
            exponential: true,
          },
        },
        sdk: {
          timeoutMs: 10000,
          baseUrl: 'http://localhost:54321',
        },
        auth: {
          ak: 'test-ak-001',
          sk: 'test-sk-secret-001',
        },
        events: {
          allowlist: ['message.updated'],
        },
      }),
      'utf8',
    );

    const calls = [];
    const logger = new AppLogger(
      {
        app: {
          log: async (options) => {
            calls.push(options);
          },
        },
      },
      { component: 'test' },
      undefined,
      undefined,
      true,
    );

    try {
      const config = await loadConfig(workspace, logger);
      assert.strictEqual(config.sdk.baseUrl, 'http://localhost:54321');
      await new Promise((r) => setTimeout(r, 10));

      const failure = calls.find((entry) => entry.body.message === 'config.validation.failed');
      assert.strictEqual(failure, undefined);
      assert.ok(calls.some((entry) => entry.body.message === 'config.validation.passed'));
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });
});

describe('config suffix lookup support (.jsonc + .json)', () => {
  test('loadConfig reads project message-bridge.json when jsonc is absent', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-json-project-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
    process.env.HOME = fakeHome;

    await mkdir(join(workspace, '.opencode'), { recursive: true });
    await writeFile(
      join(workspace, '.opencode', 'message-bridge.json'),
      JSON.stringify(
        createValidConfig({
          auth: {
            ak: 'project-json-ak',
            sk: 'project-json-sk',
          },
        }),
      ),
      'utf8',
    );

    try {
      const config = await loadConfig(workspace);
      assert.strictEqual(config.auth.ak, 'project-json-ak');
      assert.strictEqual(config.auth.sk, 'project-json-sk');
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test('loadConfig reads user message-bridge.json when project config is absent', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-json-user-workspace-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
    process.env.HOME = fakeHome;

    await mkdir(join(fakeHome, '.config', 'opencode'), { recursive: true });
    await writeFile(
      join(fakeHome, '.config', 'opencode', 'message-bridge.json'),
      JSON.stringify(
        createValidConfig({
          auth: {
            ak: 'user-json-ak',
            sk: 'user-json-sk',
          },
        }),
      ),
      'utf8',
    );

    try {
      const config = await loadConfig(workspace);
      assert.strictEqual(config.auth.ak, 'user-json-ak');
      assert.strictEqual(config.auth.sk, 'user-json-sk');
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test('prefers message-bridge.jsonc over message-bridge.json in the same directory', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-json-priority-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
    process.env.HOME = fakeHome;

    await mkdir(join(workspace, '.opencode'), { recursive: true });
    await writeFile(
      join(workspace, '.opencode', 'message-bridge.json'),
      JSON.stringify(
        createValidConfig({
          auth: {
            ak: 'project-json-ak',
            sk: 'project-json-sk',
          },
        }),
      ),
      'utf8',
    );
    await writeFile(
      join(workspace, '.opencode', 'message-bridge.jsonc'),
      JSON.stringify(
        createValidConfig({
          auth: {
            ak: 'project-jsonc-ak',
            sk: 'project-jsonc-sk',
          },
        }),
      ),
      'utf8',
    );

    try {
      const config = await loadConfig(workspace);
      assert.strictEqual(config.auth.ak, 'project-jsonc-ak');
      assert.strictEqual(config.auth.sk, 'project-jsonc-sk');
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test('supports upward lookup and finds parent message-bridge.json', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-json-upward-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
    process.env.HOME = fakeHome;

    const nested = join(workspace, 'src', 'components');
    await mkdir(join(workspace, '.opencode'), { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(workspace, '.opencode', 'message-bridge.json'),
      JSON.stringify(
        createValidConfig({
          auth: {
            ak: 'parent-json-ak',
            sk: 'parent-json-sk',
          },
        }),
      ),
      'utf8',
    );

    try {
      const config = await loadConfig(nested);
      assert.strictEqual(config.auth.ak, 'parent-json-ak');
      assert.strictEqual(config.auth.sk, 'parent-json-sk');
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test('config.resolve.completed logs the actual loaded suffix path', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-json-logs-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
    process.env.HOME = fakeHome;

    await mkdir(join(workspace, '.opencode'), { recursive: true });
    await writeFile(
      join(workspace, '.opencode', 'message-bridge.json'),
      JSON.stringify(createValidConfig()),
      'utf8',
    );

    const calls = [];
    const logger = new AppLogger(
      {
        app: {
          log: async (options) => {
            calls.push(options);
          },
        },
      },
      { component: 'test' },
      undefined,
      undefined,
      true,
    );

    try {
      await loadConfig(workspace, logger);
      await new Promise((r) => setTimeout(r, 10));

      const completed = calls.find((entry) => entry.body.message === 'config.resolve.completed');
      assert.notStrictEqual(completed, undefined);
      assert.ok(completed.body.extra.sources.includes(
        `project:${join(workspace, '.opencode', 'message-bridge.json')}`,
      ));
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test('does not fallback to .json when preferred .jsonc exists but is invalid', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-json-parse-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
    process.env.HOME = fakeHome;

    await mkdir(join(workspace, '.opencode'), { recursive: true });
    await writeFile(
      join(workspace, '.opencode', 'message-bridge.jsonc'),
      '{"config_version":1,',
      'utf8',
    );
    await writeFile(
      join(workspace, '.opencode', 'message-bridge.json'),
      JSON.stringify(createValidConfig()),
      'utf8',
    );

    try {
      await assert.rejects(
        loadConfig(workspace),
        (err) => err instanceof ConfigValidationAggregateError,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test('trims gateway.channel from config files without inventing a fallback', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-json-defaults-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
    process.env.HOME = fakeHome;

    await mkdir(join(workspace, '.opencode'), { recursive: true });
    await writeFile(
      join(workspace, '.opencode', 'message-bridge.json'),
      JSON.stringify(createValidConfig({
        gateway: {
          url: 'ws://localhost:8081/ws/agent',
          heartbeatIntervalMs: 30000,
          reconnect: {
            baseMs: 1000,
            maxMs: 30000,
            exponential: true,
          },
          channel: '  openx  ',
        },
      })),
      'utf8',
    );

    try {
      const config = await loadConfig(workspace);
      assert.strictEqual(config.gateway.channel, 'openx');
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test('loadConfig reports invalid nested object shapes instead of silently restoring defaults', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-json-invalid-shapes-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
    process.env.HOME = fakeHome;

    await mkdir(join(workspace, '.opencode'), { recursive: true });
    await writeFile(
      join(workspace, '.opencode', 'message-bridge.json'),
      JSON.stringify({
        config_version: 1,
        enabled: true,
        debug: false,
        gateway: null,
        sdk: null,
        auth: null,
        events: null,
      }),
      'utf8',
    );

    try {
      await assert.rejects(
        loadConfig(workspace),
        (err) =>
          err instanceof ConfigValidationAggregateError &&
          err.errors.some((e) => e.path === 'gateway' && e.code === 'INVALID_TYPE') &&
          err.errors.some((e) => e.path === 'sdk' && e.code === 'INVALID_TYPE') &&
          err.errors.some((e) => e.path === 'auth' && e.code === 'INVALID_TYPE') &&
          err.errors.some((e) => e.path === 'events' && e.code === 'INVALID_TYPE'),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test('loadConfig reports invalid gateway nested object shapes', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-json-invalid-gateway-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
    process.env.HOME = fakeHome;

    await mkdir(join(workspace, '.opencode'), { recursive: true });
    await writeFile(
      join(workspace, '.opencode', 'message-bridge.json'),
      JSON.stringify(createValidConfig({
        gateway: {
          url: 'ws://localhost:8081/ws/agent',
          channel: 'openx',
          heartbeatIntervalMs: 30000,
          reconnect: null,
          ping: null,
        },
      })),
      'utf8',
    );

    try {
      await assert.rejects(
        loadConfig(workspace),
        (err) =>
          err instanceof ConfigValidationAggregateError &&
          err.errors.some((e) => e.path === 'gateway.reconnect' && e.code === 'INVALID_TYPE') &&
          err.errors.some((e) => e.path === 'gateway.ping' && e.code === 'INVALID_TYPE'),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test('resolver reaches validation for malformed config instead of throwing before validation', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-json-invalid-logger-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
    process.env.HOME = fakeHome;

    await mkdir(join(workspace, '.opencode'), { recursive: true });
    await writeFile(
      join(workspace, '.opencode', 'message-bridge.json'),
      JSON.stringify({
        config_version: 1,
        enabled: true,
        gateway: null,
        auth: {
          ak: 'test-ak-001',
          sk: 'test-sk-secret-001',
        },
      }),
      'utf8',
    );

    const calls = [];
    const logger = new AppLogger(
      {
        app: {
          log: async (options) => {
            calls.push(options);
          },
        },
      },
      { component: 'test' },
      undefined,
      undefined,
      true,
    );

    try {
      await assert.rejects(
        loadConfig(workspace, logger),
        (err) =>
          err instanceof ConfigValidationAggregateError &&
          err.errors.some((e) => e.path === 'gateway' && e.code === 'INVALID_TYPE'),
      );
      await new Promise((r) => setTimeout(r, 10));

      const messages = calls.map((entry) => entry.body.message);
      assert.ok(messages.includes('config.resolve.completed'));
      assert.ok(messages.includes('config.validation.failed'));
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test('preserves explicit empty events.allowlist instead of restoring default allowlist', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-json-empty-allowlist-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
    process.env.HOME = fakeHome;

    await mkdir(join(workspace, '.opencode'), { recursive: true });
    await writeFile(
      join(workspace, '.opencode', 'message-bridge.json'),
      JSON.stringify(createValidConfig({
        events: {
          allowlist: [],
        },
      })),
      'utf8',
    );

    try {
      const config = await loadConfig(workspace);
      assert.deepStrictEqual(config.events.allowlist, []);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test('loads gateway.channel from BRIDGE_GATEWAY_CHANNEL', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-json-env-channel-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
    const originalChannel = process.env.BRIDGE_GATEWAY_CHANNEL;
    const originalAuthAk = process.env.BRIDGE_AUTH_AK;
    const originalAuthSk = process.env.BRIDGE_AUTH_SK;
    process.env.HOME = fakeHome;
    process.env.BRIDGE_GATEWAY_CHANNEL = '  miniapp  ';
    process.env.BRIDGE_AUTH_AK = 'env-ak';
    process.env.BRIDGE_AUTH_SK = 'env-sk';

    await mkdir(join(workspace, '.opencode'), { recursive: true });
    await writeFile(
      join(workspace, '.opencode', 'message-bridge.json'),
      JSON.stringify(createValidConfig()),
      'utf8',
    );

    try {
      const config = await loadConfig(workspace);
      assert.strictEqual(config.gateway.channel, 'miniapp');
    } finally {
      if (originalChannel === undefined) {
        delete process.env.BRIDGE_GATEWAY_CHANNEL;
      } else {
        process.env.BRIDGE_GATEWAY_CHANNEL = originalChannel;
      }
      if (originalAuthAk === undefined) {
        delete process.env.BRIDGE_AUTH_AK;
      } else {
        process.env.BRIDGE_AUTH_AK = originalAuthAk;
      }
      if (originalAuthSk === undefined) {
        delete process.env.BRIDGE_AUTH_SK;
      } else {
        process.env.BRIDGE_AUTH_SK = originalAuthSk;
      }
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test('ignores removed BRIDGE_CHANNEL override', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-json-env-legacy-channel-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
    const originalChannel = process.env.BRIDGE_CHANNEL;
    process.env.HOME = fakeHome;
    process.env.BRIDGE_CHANNEL = 'uniassistant';

    await mkdir(join(workspace, '.opencode'), { recursive: true });
    await writeFile(
      join(workspace, '.opencode', 'message-bridge.json'),
      JSON.stringify(createValidConfig({
        gateway: {
          channel: 'openx',
        },
      })),
      'utf8',
    );

    try {
      const config = await loadConfig(workspace);
      assert.strictEqual(config.gateway.channel, 'openx');
    } finally {
      if (originalChannel === undefined) {
        delete process.env.BRIDGE_CHANNEL;
      } else {
        process.env.BRIDGE_CHANNEL = originalChannel;
      }
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test('loads bridgeDirectory from BRIDGE_DIRECTORY and trims whitespace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-json-env-dir-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
    process.env.HOME = fakeHome;
    process.env.BRIDGE_DIRECTORY = '  /tmp/bridge-dir  ';

    await mkdir(join(workspace, '.opencode'), { recursive: true });
    await writeFile(
      join(workspace, '.opencode', 'message-bridge.json'),
      JSON.stringify(createValidConfig()),
      'utf8',
    );

    try {
      const config = await loadConfig(workspace);
      assert.strictEqual(config.bridgeDirectory, '/tmp/bridge-dir');
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test('treats blank BRIDGE_DIRECTORY as unset', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-json-env-dir-blank-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
    process.env.HOME = fakeHome;
    process.env.BRIDGE_DIRECTORY = '   ';

    await mkdir(join(workspace, '.opencode'), { recursive: true });
    await writeFile(
      join(workspace, '.opencode', 'message-bridge.json'),
      JSON.stringify(createValidConfig()),
      'utf8',
    );

    try {
      const config = await loadConfig(workspace);
      assert.strictEqual(config.bridgeDirectory, undefined);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test('loads auth from BRIDGE_AUTH_AK and BRIDGE_AUTH_SK', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-json-env-auth-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
    const originalAuthAk = process.env.BRIDGE_AUTH_AK;
    const originalAuthSk = process.env.BRIDGE_AUTH_SK;
    process.env.HOME = fakeHome;
    process.env.BRIDGE_AUTH_AK = 'env-auth-ak';
    process.env.BRIDGE_AUTH_SK = 'env-auth-sk';

    await mkdir(join(workspace, '.opencode'), { recursive: true });
    await writeFile(
      join(workspace, '.opencode', 'message-bridge.json'),
      JSON.stringify(createValidConfig({
        auth: {
          ak: '',
          sk: '',
        },
      })),
      'utf8',
    );

    try {
      const config = await loadConfig(workspace);
      assert.strictEqual(config.auth.ak, 'env-auth-ak');
      assert.strictEqual(config.auth.sk, 'env-auth-sk');
    } finally {
      if (originalAuthAk === undefined) {
        delete process.env.BRIDGE_AUTH_AK;
      } else {
        process.env.BRIDGE_AUTH_AK = originalAuthAk;
      }
      if (originalAuthSk === undefined) {
        delete process.env.BRIDGE_AUTH_SK;
      } else {
        process.env.BRIDGE_AUTH_SK = originalAuthSk;
      }
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  describe('auth credential source policy by BRIDGE_GATEWAY_CHANNEL', () => {
    test('requires env auth when BRIDGE_GATEWAY_CHANNEL is set and does not fallback to local auth', async () => {
      const workspace = await mkdtemp(join(tmpdir(), 'mb-json-env-auth-channel-strict-'));
      const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
      const originalGatewayChannel = process.env.BRIDGE_GATEWAY_CHANNEL;
      const originalBridgeChannel = process.env.BRIDGE_CHANNEL;
      const originalAuthAk = process.env.BRIDGE_AUTH_AK;
      const originalAuthSk = process.env.BRIDGE_AUTH_SK;
      process.env.HOME = fakeHome;
      process.env.BRIDGE_GATEWAY_CHANNEL = 'uniassistant';
      delete process.env.BRIDGE_CHANNEL;
      delete process.env.BRIDGE_AUTH_AK;
      delete process.env.BRIDGE_AUTH_SK;

      await mkdir(join(workspace, '.opencode'), { recursive: true });
      await writeFile(
        join(workspace, '.opencode', 'message-bridge.json'),
        JSON.stringify(createValidConfig({
          auth: {
            ak: 'local-ak',
            sk: 'local-sk',
          },
        })),
        'utf8',
      );

      try {
        await assert.rejects(
          loadConfig(workspace),
          (err) =>
            err instanceof ConfigValidationAggregateError &&
            err.errors.some((e) => e.path === 'auth.ak' && e.code === 'MISSING_REQUIRED') &&
            err.errors.some((e) => e.path === 'auth.sk' && e.code === 'MISSING_REQUIRED'),
        );
      } finally {
        if (originalGatewayChannel === undefined) {
          delete process.env.BRIDGE_GATEWAY_CHANNEL;
        } else {
          process.env.BRIDGE_GATEWAY_CHANNEL = originalGatewayChannel;
        }
        if (originalBridgeChannel === undefined) {
          delete process.env.BRIDGE_CHANNEL;
        } else {
          process.env.BRIDGE_CHANNEL = originalBridgeChannel;
        }
        if (originalAuthAk === undefined) {
          delete process.env.BRIDGE_AUTH_AK;
        } else {
          process.env.BRIDGE_AUTH_AK = originalAuthAk;
        }
        if (originalAuthSk === undefined) {
          delete process.env.BRIDGE_AUTH_SK;
        } else {
          process.env.BRIDGE_AUTH_SK = originalAuthSk;
        }
        await rm(workspace, { recursive: true, force: true });
        await rm(fakeHome, { recursive: true, force: true });
      }
    });

    test('uses env auth when BRIDGE_GATEWAY_CHANNEL is set even if local auth exists', async () => {
      const workspace = await mkdtemp(join(tmpdir(), 'mb-json-env-auth-channel-priority-'));
      const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
      const originalGatewayChannel = process.env.BRIDGE_GATEWAY_CHANNEL;
      const originalBridgeChannel = process.env.BRIDGE_CHANNEL;
      const originalAuthAk = process.env.BRIDGE_AUTH_AK;
      const originalAuthSk = process.env.BRIDGE_AUTH_SK;
      process.env.HOME = fakeHome;
      process.env.BRIDGE_GATEWAY_CHANNEL = 'codeagent';
      delete process.env.BRIDGE_CHANNEL;
      process.env.BRIDGE_AUTH_AK = 'env-ak';
      process.env.BRIDGE_AUTH_SK = 'env-sk';

      await mkdir(join(workspace, '.opencode'), { recursive: true });
      await writeFile(
        join(workspace, '.opencode', 'message-bridge.json'),
        JSON.stringify(createValidConfig({
          auth: {
            ak: 'local-ak',
            sk: 'local-sk',
          },
        })),
        'utf8',
      );

      try {
        const config = await loadConfig(workspace);
        assert.strictEqual(config.auth.ak, 'env-ak');
        assert.strictEqual(config.auth.sk, 'env-sk');
      } finally {
        if (originalGatewayChannel === undefined) {
          delete process.env.BRIDGE_GATEWAY_CHANNEL;
        } else {
          process.env.BRIDGE_GATEWAY_CHANNEL = originalGatewayChannel;
        }
        if (originalBridgeChannel === undefined) {
          delete process.env.BRIDGE_CHANNEL;
        } else {
          process.env.BRIDGE_CHANNEL = originalBridgeChannel;
        }
        if (originalAuthAk === undefined) {
          delete process.env.BRIDGE_AUTH_AK;
        } else {
          process.env.BRIDGE_AUTH_AK = originalAuthAk;
        }
        if (originalAuthSk === undefined) {
          delete process.env.BRIDGE_AUTH_SK;
        } else {
          process.env.BRIDGE_AUTH_SK = originalAuthSk;
        }
        await rm(workspace, { recursive: true, force: true });
        await rm(fakeHome, { recursive: true, force: true });
      }
    });

    test('requires env auth when BRIDGE_GATEWAY_CHANNEL is set to openx explicitly', async () => {
      const workspace = await mkdtemp(join(tmpdir(), 'mb-json-env-auth-channel-openx-strict-'));
      const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
      const originalGatewayChannel = process.env.BRIDGE_GATEWAY_CHANNEL;
      const originalBridgeChannel = process.env.BRIDGE_CHANNEL;
      const originalAuthAk = process.env.BRIDGE_AUTH_AK;
      const originalAuthSk = process.env.BRIDGE_AUTH_SK;
      process.env.HOME = fakeHome;
      process.env.BRIDGE_GATEWAY_CHANNEL = 'openx';
      delete process.env.BRIDGE_CHANNEL;
      delete process.env.BRIDGE_AUTH_AK;
      delete process.env.BRIDGE_AUTH_SK;

      await mkdir(join(workspace, '.opencode'), { recursive: true });
      await writeFile(
        join(workspace, '.opencode', 'message-bridge.json'),
        JSON.stringify(createValidConfig({
          auth: {
            ak: 'local-ak',
            sk: 'local-sk',
          },
        })),
        'utf8',
      );

      try {
        await assert.rejects(
          loadConfig(workspace),
          (err) =>
            err instanceof ConfigValidationAggregateError &&
            err.errors.some((e) => e.path === 'auth.ak' && e.code === 'MISSING_REQUIRED') &&
            err.errors.some((e) => e.path === 'auth.sk' && e.code === 'MISSING_REQUIRED'),
        );
      } finally {
        if (originalGatewayChannel === undefined) {
          delete process.env.BRIDGE_GATEWAY_CHANNEL;
        } else {
          process.env.BRIDGE_GATEWAY_CHANNEL = originalGatewayChannel;
        }
        if (originalBridgeChannel === undefined) {
          delete process.env.BRIDGE_CHANNEL;
        } else {
          process.env.BRIDGE_CHANNEL = originalBridgeChannel;
        }
        if (originalAuthAk === undefined) {
          delete process.env.BRIDGE_AUTH_AK;
        } else {
          process.env.BRIDGE_AUTH_AK = originalAuthAk;
        }
        if (originalAuthSk === undefined) {
          delete process.env.BRIDGE_AUTH_SK;
        } else {
          process.env.BRIDGE_AUTH_SK = originalAuthSk;
        }
        await rm(workspace, { recursive: true, force: true });
        await rm(fakeHome, { recursive: true, force: true });
      }
    });

    test('uses env auth when BRIDGE_GATEWAY_CHANNEL is unset and env has both AK/SK', async () => {
      const workspace = await mkdtemp(join(tmpdir(), 'mb-json-env-auth-unset-both-'));
      const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
      const originalGatewayChannel = process.env.BRIDGE_GATEWAY_CHANNEL;
      const originalBridgeChannel = process.env.BRIDGE_CHANNEL;
      const originalAuthAk = process.env.BRIDGE_AUTH_AK;
      const originalAuthSk = process.env.BRIDGE_AUTH_SK;
      process.env.HOME = fakeHome;
      delete process.env.BRIDGE_GATEWAY_CHANNEL;
      delete process.env.BRIDGE_CHANNEL;
      process.env.BRIDGE_AUTH_AK = 'env-both-ak';
      process.env.BRIDGE_AUTH_SK = 'env-both-sk';

      await mkdir(join(workspace, '.opencode'), { recursive: true });
      await writeFile(
        join(workspace, '.opencode', 'message-bridge.json'),
        JSON.stringify(createValidConfig({
          auth: {
            ak: 'local-ak',
            sk: 'local-sk',
          },
        })),
        'utf8',
      );

      try {
        const config = await loadConfig(workspace);
        assert.strictEqual(config.auth.ak, 'env-both-ak');
        assert.strictEqual(config.auth.sk, 'env-both-sk');
      } finally {
        if (originalGatewayChannel === undefined) {
          delete process.env.BRIDGE_GATEWAY_CHANNEL;
        } else {
          process.env.BRIDGE_GATEWAY_CHANNEL = originalGatewayChannel;
        }
        if (originalBridgeChannel === undefined) {
          delete process.env.BRIDGE_CHANNEL;
        } else {
          process.env.BRIDGE_CHANNEL = originalBridgeChannel;
        }
        if (originalAuthAk === undefined) {
          delete process.env.BRIDGE_AUTH_AK;
        } else {
          process.env.BRIDGE_AUTH_AK = originalAuthAk;
        }
        if (originalAuthSk === undefined) {
          delete process.env.BRIDGE_AUTH_SK;
        } else {
          process.env.BRIDGE_AUTH_SK = originalAuthSk;
        }
        await rm(workspace, { recursive: true, force: true });
        await rm(fakeHome, { recursive: true, force: true });
      }
    });

    test('falls back to local auth when BRIDGE_GATEWAY_CHANNEL is unset and env auth is missing', async () => {
      const workspace = await mkdtemp(join(tmpdir(), 'mb-json-env-auth-unset-fallback-'));
      const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
      const originalGatewayChannel = process.env.BRIDGE_GATEWAY_CHANNEL;
      const originalBridgeChannel = process.env.BRIDGE_CHANNEL;
      const originalAuthAk = process.env.BRIDGE_AUTH_AK;
      const originalAuthSk = process.env.BRIDGE_AUTH_SK;
      process.env.HOME = fakeHome;
      delete process.env.BRIDGE_GATEWAY_CHANNEL;
      delete process.env.BRIDGE_CHANNEL;
      delete process.env.BRIDGE_AUTH_AK;
      delete process.env.BRIDGE_AUTH_SK;

      await mkdir(join(workspace, '.opencode'), { recursive: true });
      await writeFile(
        join(workspace, '.opencode', 'message-bridge.json'),
        JSON.stringify(createValidConfig({
          auth: {
            ak: 'local-fallback-ak',
            sk: 'local-fallback-sk',
          },
        })),
        'utf8',
      );

      try {
        const config = await loadConfig(workspace);
        assert.strictEqual(config.auth.ak, 'local-fallback-ak');
        assert.strictEqual(config.auth.sk, 'local-fallback-sk');
      } finally {
        if (originalGatewayChannel === undefined) {
          delete process.env.BRIDGE_GATEWAY_CHANNEL;
        } else {
          process.env.BRIDGE_GATEWAY_CHANNEL = originalGatewayChannel;
        }
        if (originalBridgeChannel === undefined) {
          delete process.env.BRIDGE_CHANNEL;
        } else {
          process.env.BRIDGE_CHANNEL = originalBridgeChannel;
        }
        if (originalAuthAk === undefined) {
          delete process.env.BRIDGE_AUTH_AK;
        } else {
          process.env.BRIDGE_AUTH_AK = originalAuthAk;
        }
        if (originalAuthSk === undefined) {
          delete process.env.BRIDGE_AUTH_SK;
        } else {
          process.env.BRIDGE_AUTH_SK = originalAuthSk;
        }
        await rm(workspace, { recursive: true, force: true });
        await rm(fakeHome, { recursive: true, force: true });
      }
    });

    test('falls back to local auth atomically when BRIDGE_GATEWAY_CHANNEL is unset and env has only one field', async () => {
      const workspace = await mkdtemp(join(tmpdir(), 'mb-json-env-auth-unset-atomic-'));
      const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
      const originalGatewayChannel = process.env.BRIDGE_GATEWAY_CHANNEL;
      const originalBridgeChannel = process.env.BRIDGE_CHANNEL;
      const originalAuthAk = process.env.BRIDGE_AUTH_AK;
      const originalAuthSk = process.env.BRIDGE_AUTH_SK;
      process.env.HOME = fakeHome;
      delete process.env.BRIDGE_GATEWAY_CHANNEL;
      delete process.env.BRIDGE_CHANNEL;
      process.env.BRIDGE_AUTH_AK = 'env-only-ak';
      delete process.env.BRIDGE_AUTH_SK;

      await mkdir(join(workspace, '.opencode'), { recursive: true });
      await writeFile(
        join(workspace, '.opencode', 'message-bridge.json'),
        JSON.stringify(createValidConfig({
          auth: {
            ak: 'local-atomic-ak',
            sk: 'local-atomic-sk',
          },
        })),
        'utf8',
      );

      try {
        const config = await loadConfig(workspace);
        assert.strictEqual(config.auth.ak, 'local-atomic-ak');
        assert.strictEqual(config.auth.sk, 'local-atomic-sk');
      } finally {
        if (originalGatewayChannel === undefined) {
          delete process.env.BRIDGE_GATEWAY_CHANNEL;
        } else {
          process.env.BRIDGE_GATEWAY_CHANNEL = originalGatewayChannel;
        }
        if (originalBridgeChannel === undefined) {
          delete process.env.BRIDGE_CHANNEL;
        } else {
          process.env.BRIDGE_CHANNEL = originalBridgeChannel;
        }
        if (originalAuthAk === undefined) {
          delete process.env.BRIDGE_AUTH_AK;
        } else {
          process.env.BRIDGE_AUTH_AK = originalAuthAk;
        }
        if (originalAuthSk === undefined) {
          delete process.env.BRIDGE_AUTH_SK;
        } else {
          process.env.BRIDGE_AUTH_SK = originalAuthSk;
        }
        await rm(workspace, { recursive: true, force: true });
        await rm(fakeHome, { recursive: true, force: true });
      }
    });

    test('treats blank BRIDGE_GATEWAY_CHANNEL as unset for auth source policy', async () => {
      const workspace = await mkdtemp(join(tmpdir(), 'mb-json-env-auth-blank-gateway-channel-'));
      const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
      const originalGatewayChannel = process.env.BRIDGE_GATEWAY_CHANNEL;
      const originalBridgeChannel = process.env.BRIDGE_CHANNEL;
      const originalAuthAk = process.env.BRIDGE_AUTH_AK;
      const originalAuthSk = process.env.BRIDGE_AUTH_SK;
      process.env.HOME = fakeHome;
      process.env.BRIDGE_GATEWAY_CHANNEL = '   ';
      delete process.env.BRIDGE_CHANNEL;
      process.env.BRIDGE_AUTH_AK = 'env-blank-ak';
      process.env.BRIDGE_AUTH_SK = 'env-blank-sk';

      await mkdir(join(workspace, '.opencode'), { recursive: true });
      await writeFile(
        join(workspace, '.opencode', 'message-bridge.json'),
        JSON.stringify(createValidConfig({
          auth: {
            ak: 'local-ak',
            sk: 'local-sk',
          },
        })),
        'utf8',
      );

      try {
        const config = await loadConfig(workspace);
        assert.strictEqual(config.auth.ak, 'env-blank-ak');
        assert.strictEqual(config.auth.sk, 'env-blank-sk');
      } finally {
        if (originalGatewayChannel === undefined) {
          delete process.env.BRIDGE_GATEWAY_CHANNEL;
        } else {
          process.env.BRIDGE_GATEWAY_CHANNEL = originalGatewayChannel;
        }
        if (originalBridgeChannel === undefined) {
          delete process.env.BRIDGE_CHANNEL;
        } else {
          process.env.BRIDGE_CHANNEL = originalBridgeChannel;
        }
        if (originalAuthAk === undefined) {
          delete process.env.BRIDGE_AUTH_AK;
        } else {
          process.env.BRIDGE_AUTH_AK = originalAuthAk;
        }
        if (originalAuthSk === undefined) {
          delete process.env.BRIDGE_AUTH_SK;
        } else {
          process.env.BRIDGE_AUTH_SK = originalAuthSk;
        }
        await rm(workspace, { recursive: true, force: true });
        await rm(fakeHome, { recursive: true, force: true });
      }
    });

    test('ignores BRIDGE_CHANNEL for auth policy when BRIDGE_GATEWAY_CHANNEL is unset', async () => {
      const workspace = await mkdtemp(join(tmpdir(), 'mb-json-env-auth-ignore-legacy-channel-'));
      const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
      const originalGatewayChannel = process.env.BRIDGE_GATEWAY_CHANNEL;
      const originalBridgeChannel = process.env.BRIDGE_CHANNEL;
      const originalAuthAk = process.env.BRIDGE_AUTH_AK;
      const originalAuthSk = process.env.BRIDGE_AUTH_SK;
      process.env.HOME = fakeHome;
      delete process.env.BRIDGE_GATEWAY_CHANNEL;
      process.env.BRIDGE_CHANNEL = 'uniassistant';
      process.env.BRIDGE_AUTH_AK = 'env-only-ak';
      delete process.env.BRIDGE_AUTH_SK;

      await mkdir(join(workspace, '.opencode'), { recursive: true });
      await writeFile(
        join(workspace, '.opencode', 'message-bridge.json'),
        JSON.stringify(createValidConfig({
          auth: {
            ak: 'local-ak',
            sk: 'local-sk',
          },
        })),
        'utf8',
      );

      try {
        const config = await loadConfig(workspace);
        assert.strictEqual(config.auth.ak, 'local-ak');
        assert.strictEqual(config.auth.sk, 'local-sk');
      } finally {
        if (originalGatewayChannel === undefined) {
          delete process.env.BRIDGE_GATEWAY_CHANNEL;
        } else {
          process.env.BRIDGE_GATEWAY_CHANNEL = originalGatewayChannel;
        }
        if (originalBridgeChannel === undefined) {
          delete process.env.BRIDGE_CHANNEL;
        } else {
          process.env.BRIDGE_CHANNEL = originalBridgeChannel;
        }
        if (originalAuthAk === undefined) {
          delete process.env.BRIDGE_AUTH_AK;
        } else {
          process.env.BRIDGE_AUTH_AK = originalAuthAk;
        }
        if (originalAuthSk === undefined) {
          delete process.env.BRIDGE_AUTH_SK;
        } else {
          process.env.BRIDGE_AUTH_SK = originalAuthSk;
        }
        await rm(workspace, { recursive: true, force: true });
        await rm(fakeHome, { recursive: true, force: true });
      }
    });
  });

  test('ignores BRIDGE_AK and BRIDGE_SK aliases', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-json-env-auth-alias-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
    const originalBridgeAk = process.env.BRIDGE_AK;
    const originalBridgeSk = process.env.BRIDGE_SK;
    process.env.HOME = fakeHome;
    process.env.BRIDGE_AK = 'alias-ak';
    process.env.BRIDGE_SK = 'alias-sk';

    await mkdir(join(workspace, '.opencode'), { recursive: true });
    await writeFile(
      join(workspace, '.opencode', 'message-bridge.json'),
      JSON.stringify(createValidConfig({
        auth: {
          ak: '',
          sk: '',
        },
      })),
      'utf8',
    );

    try {
      await assert.rejects(
        loadConfig(workspace),
        (err) =>
          err instanceof ConfigValidationAggregateError &&
          err.errors.some((e) => e.path === 'auth.ak' && e.code === 'MISSING_REQUIRED') &&
          err.errors.some((e) => e.path === 'auth.sk' && e.code === 'MISSING_REQUIRED'),
      );
    } finally {
      if (originalBridgeAk === undefined) {
        delete process.env.BRIDGE_AK;
      } else {
        process.env.BRIDGE_AK = originalBridgeAk;
      }
      if (originalBridgeSk === undefined) {
        delete process.env.BRIDGE_SK;
      } else {
        process.env.BRIDGE_SK = originalBridgeSk;
      }
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test('prefers BRIDGE_AUTH_AK and BRIDGE_AUTH_SK over removed aliases', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-json-env-auth-priority-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
    const originalAuthAk = process.env.BRIDGE_AUTH_AK;
    const originalAuthSk = process.env.BRIDGE_AUTH_SK;
    const originalBridgeAk = process.env.BRIDGE_AK;
    const originalBridgeSk = process.env.BRIDGE_SK;
    process.env.HOME = fakeHome;
    process.env.BRIDGE_AUTH_AK = 'primary-ak';
    process.env.BRIDGE_AUTH_SK = 'primary-sk';
    process.env.BRIDGE_AK = 'alias-ak';
    process.env.BRIDGE_SK = 'alias-sk';

    await mkdir(join(workspace, '.opencode'), { recursive: true });
    await writeFile(
      join(workspace, '.opencode', 'message-bridge.json'),
      JSON.stringify(createValidConfig({
        auth: {
          ak: '',
          sk: '',
        },
      })),
      'utf8',
    );

    try {
      const config = await loadConfig(workspace);
      assert.strictEqual(config.auth.ak, 'primary-ak');
      assert.strictEqual(config.auth.sk, 'primary-sk');
    } finally {
      if (originalAuthAk === undefined) {
        delete process.env.BRIDGE_AUTH_AK;
      } else {
        process.env.BRIDGE_AUTH_AK = originalAuthAk;
      }
      if (originalAuthSk === undefined) {
        delete process.env.BRIDGE_AUTH_SK;
      } else {
        process.env.BRIDGE_AUTH_SK = originalAuthSk;
      }
      if (originalBridgeAk === undefined) {
        delete process.env.BRIDGE_AK;
      } else {
        process.env.BRIDGE_AK = originalBridgeAk;
      }
      if (originalBridgeSk === undefined) {
        delete process.env.BRIDGE_SK;
      } else {
        process.env.BRIDGE_SK = originalBridgeSk;
      }
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test('ignores removed BRIDGE_GATEWAY_TOOL_TYPE override', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-json-env-tooltype-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
    const originalToolType = process.env.BRIDGE_GATEWAY_TOOL_TYPE;
    process.env.HOME = fakeHome;
    process.env.BRIDGE_GATEWAY_TOOL_TYPE = 'legacy-tool-type';

    await mkdir(join(workspace, '.opencode'), { recursive: true });
    await writeFile(
      join(workspace, '.opencode', 'message-bridge.json'),
      JSON.stringify(createValidConfig()),
      'utf8',
    );

    try {
      const config = await loadConfig(workspace);
      assert.strictEqual(config.gateway.channel, 'openx');
    } finally {
      if (originalToolType === undefined) {
        delete process.env.BRIDGE_GATEWAY_TOOL_TYPE;
      } else {
        process.env.BRIDGE_GATEWAY_TOOL_TYPE = originalToolType;
      }
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test('ignores removed gateway metadata environment overrides', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-json-mac-env-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
    const originalDeviceName = process.env.BRIDGE_GATEWAY_DEVICE_NAME;
    const originalMacAddress = process.env.BRIDGE_GATEWAY_MAC_ADDRESS;
    const originalToolVersion = process.env.BRIDGE_GATEWAY_TOOL_VERSION;
    process.env.HOME = fakeHome;
    process.env.BRIDGE_GATEWAY_DEVICE_NAME = 'env-device';
    process.env.BRIDGE_GATEWAY_MAC_ADDRESS = '11:22:33:44:55:66';
    process.env.BRIDGE_GATEWAY_TOOL_VERSION = '9.9.9';

    await mkdir(join(workspace, '.opencode'), { recursive: true });
    await writeFile(
      join(workspace, '.opencode', 'message-bridge.json'),
      JSON.stringify(createValidConfig()),
      'utf8',
    );

    try {
      const config = await loadConfig(workspace);
      assert.strictEqual(config.gateway.url, 'ws://localhost:8081/ws/agent');
      assert.strictEqual(config.gateway.channel, 'openx');
      assert.strictEqual(config.gateway.heartbeatIntervalMs, 30000);
    } finally {
      if (originalDeviceName === undefined) {
        delete process.env.BRIDGE_GATEWAY_DEVICE_NAME;
      } else {
        process.env.BRIDGE_GATEWAY_DEVICE_NAME = originalDeviceName;
      }
      if (originalMacAddress === undefined) {
        delete process.env.BRIDGE_GATEWAY_MAC_ADDRESS;
      } else {
        process.env.BRIDGE_GATEWAY_MAC_ADDRESS = originalMacAddress;
      }
      if (originalToolVersion === undefined) {
        delete process.env.BRIDGE_GATEWAY_TOOL_VERSION;
      } else {
        process.env.BRIDGE_GATEWAY_TOOL_VERSION = originalToolVersion;
      }
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test('logs warning when gateway.channel is unknown but keeps value', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-json-unknown-channel-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
    const originalChannel = process.env.BRIDGE_GATEWAY_CHANNEL;
    const originalAuthAk = process.env.BRIDGE_AUTH_AK;
    const originalAuthSk = process.env.BRIDGE_AUTH_SK;
    process.env.HOME = fakeHome;
    process.env.BRIDGE_GATEWAY_CHANNEL = 'legacy-tool-type';
    process.env.BRIDGE_AUTH_AK = 'env-ak';
    process.env.BRIDGE_AUTH_SK = 'env-sk';

    await mkdir(join(workspace, '.opencode'), { recursive: true });
    await writeFile(
      join(workspace, '.opencode', 'message-bridge.json'),
      JSON.stringify(createValidConfig()),
      'utf8',
    );

    const calls = [];
    const logger = new AppLogger(
      {
        app: {
          log: async (options) => {
            calls.push(options);
          },
        },
      },
      { component: 'test' },
      undefined,
      undefined,
      true,
    );

    try {
      const config = await loadConfig(workspace, logger);
      assert.strictEqual(config.gateway.channel, 'legacy-tool-type');
      await new Promise((resolve) => setTimeout(resolve, 10));
      const warnLog = calls.find((entry) => entry.body.message === 'config.gateway.channel.unknown');
      assert.ok(warnLog);
      assert.strictEqual(warnLog.body.extra.toolType, 'legacy-tool-type');
      assert.deepStrictEqual(warnLog.body.extra.knownToolTypes, ['openx', 'uniassistant', 'codeagent']);
      assert.strictEqual(warnLog.body.extra.source, 'env');
    } finally {
      if (originalChannel === undefined) {
        delete process.env.BRIDGE_GATEWAY_CHANNEL;
      } else {
        process.env.BRIDGE_GATEWAY_CHANNEL = originalChannel;
      }
      if (originalAuthAk === undefined) {
        delete process.env.BRIDGE_AUTH_AK;
      } else {
        process.env.BRIDGE_AUTH_AK = originalAuthAk;
      }
      if (originalAuthSk === undefined) {
        delete process.env.BRIDGE_AUTH_SK;
      } else {
        process.env.BRIDGE_AUTH_SK = originalAuthSk;
      }
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test('logs env snapshot only when BRIDGE_DEBUG=true and redacts sensitive values', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-json-env-snapshot-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
    const originalDebug = process.env.BRIDGE_DEBUG;
    const originalGatewayChannel = process.env.BRIDGE_GATEWAY_CHANNEL;
    const originalAuthAk = process.env.BRIDGE_AUTH_AK;
    const originalAuthSk = process.env.BRIDGE_AUTH_SK;
    const originalLegacyChannel = process.env.BRIDGE_CHANNEL;
    const originalBridgeAk = process.env.BRIDGE_AK;
    const originalBridgeSk = process.env.BRIDGE_SK;
    const originalLegacyToolType = process.env.BRIDGE_GATEWAY_TOOL_TYPE;

    process.env.HOME = fakeHome;
    process.env.BRIDGE_DEBUG = 'true';
    process.env.BRIDGE_GATEWAY_CHANNEL = 'uniassistant';
    process.env.BRIDGE_AUTH_AK = 'snapshot-ak';
    process.env.BRIDGE_AUTH_SK = 'snapshot-sk';
    process.env.BRIDGE_CHANNEL = 'legacy-channel';
    process.env.BRIDGE_AK = 'legacy-ak';
    process.env.BRIDGE_SK = 'legacy-sk';
    process.env.BRIDGE_GATEWAY_TOOL_TYPE = 'legacy-tool-type';

    await mkdir(join(workspace, '.opencode'), { recursive: true });
    await writeFile(
      join(workspace, '.opencode', 'message-bridge.json'),
      JSON.stringify(createValidConfig()),
      'utf8',
    );

    const calls = [];
    const logger = new AppLogger(
      {
        app: {
          log: async (options) => {
            calls.push(options);
          },
        },
      },
      { component: 'test' },
      undefined,
      undefined,
      true,
    );

    try {
      const config = await loadConfig(workspace, logger);
      assert.strictEqual(config.gateway.channel, 'uniassistant');
      await new Promise((resolve) => setTimeout(resolve, 10));

      const snapshot = calls.find((entry) => entry.body.message === 'config.env.snapshot');
      assert.ok(snapshot);
      assert.deepStrictEqual(snapshot.body.extra.keys, [
        'BRIDGE_ENABLED',
        'BRIDGE_DEBUG',
        'BRIDGE_DIRECTORY',
        'BRIDGE_CONFIG_VERSION',
        'BRIDGE_GATEWAY_URL',
        'BRIDGE_GATEWAY_CHANNEL',
        'BRIDGE_GATEWAY_RECONNECT_BASE_MS',
        'BRIDGE_GATEWAY_RECONNECT_MAX_MS',
        'BRIDGE_GATEWAY_RECONNECT_EXPONENTIAL',
        'BRIDGE_GATEWAY_HEARTBEAT_INTERVAL_MS',
        'BRIDGE_EVENT_HEARTBEAT_INTERVAL_MS',
        'BRIDGE_GATEWAY_PING_INTERVAL_MS',
        'BRIDGE_AUTH_AK',
        'BRIDGE_AUTH_SK',
        'BRIDGE_SDK_TIMEOUT_MS',
        'BRIDGE_EVENTS_ALLOWLIST',
        'BRIDGE_ASSISTANT_DIRECTORY_MAP_FILE',
      ]);
      assert.deepStrictEqual(snapshot.body.extra.values.BRIDGE_DEBUG, {
        present: true,
        value: 'true',
      });
      assert.deepStrictEqual(snapshot.body.extra.values.BRIDGE_GATEWAY_CHANNEL, {
        present: true,
        value: 'uniassistant',
      });
      assert.deepStrictEqual(snapshot.body.extra.values.BRIDGE_AUTH_AK, {
        present: true,
        value: '***',
      });
      assert.deepStrictEqual(snapshot.body.extra.values.BRIDGE_AUTH_SK, {
        present: true,
        value: '***',
      });
      assert.strictEqual('BRIDGE_CHANNEL' in snapshot.body.extra.values, false);
      assert.strictEqual('BRIDGE_AK' in snapshot.body.extra.values, false);
      assert.strictEqual('BRIDGE_SK' in snapshot.body.extra.values, false);
      assert.strictEqual('BRIDGE_GATEWAY_TOOL_TYPE' in snapshot.body.extra.values, false);
    } finally {
      if (originalDebug === undefined) {
        delete process.env.BRIDGE_DEBUG;
      } else {
        process.env.BRIDGE_DEBUG = originalDebug;
      }
      if (originalGatewayChannel === undefined) {
        delete process.env.BRIDGE_GATEWAY_CHANNEL;
      } else {
        process.env.BRIDGE_GATEWAY_CHANNEL = originalGatewayChannel;
      }
      if (originalAuthAk === undefined) {
        delete process.env.BRIDGE_AUTH_AK;
      } else {
        process.env.BRIDGE_AUTH_AK = originalAuthAk;
      }
      if (originalAuthSk === undefined) {
        delete process.env.BRIDGE_AUTH_SK;
      } else {
        process.env.BRIDGE_AUTH_SK = originalAuthSk;
      }
      if (originalLegacyChannel === undefined) {
        delete process.env.BRIDGE_CHANNEL;
      } else {
        process.env.BRIDGE_CHANNEL = originalLegacyChannel;
      }
      if (originalBridgeAk === undefined) {
        delete process.env.BRIDGE_AK;
      } else {
        process.env.BRIDGE_AK = originalBridgeAk;
      }
      if (originalBridgeSk === undefined) {
        delete process.env.BRIDGE_SK;
      } else {
        process.env.BRIDGE_SK = originalBridgeSk;
      }
      if (originalLegacyToolType === undefined) {
        delete process.env.BRIDGE_GATEWAY_TOOL_TYPE;
      } else {
        process.env.BRIDGE_GATEWAY_TOOL_TYPE = originalLegacyToolType;
      }
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test('does not log env snapshot when BRIDGE_DEBUG is disabled', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-json-env-snapshot-off-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
    const originalDebug = process.env.BRIDGE_DEBUG;
    process.env.HOME = fakeHome;
    delete process.env.BRIDGE_DEBUG;

    await mkdir(join(workspace, '.opencode'), { recursive: true });
    await writeFile(
      join(workspace, '.opencode', 'message-bridge.json'),
      JSON.stringify(createValidConfig()),
      'utf8',
    );

    const calls = [];
    const logger = new AppLogger(
      {
        app: {
          log: async (options) => {
            calls.push(options);
          },
        },
      },
      { component: 'test' },
      undefined,
      undefined,
      true,
    );

    try {
      await loadConfig(workspace, logger);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const snapshot = calls.find((entry) => entry.body.message === 'config.env.snapshot');
      assert.strictEqual(snapshot, undefined);
    } finally {
      if (originalDebug === undefined) {
        delete process.env.BRIDGE_DEBUG;
      } else {
        process.env.BRIDGE_DEBUG = originalDebug;
      }
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test('logs env snapshot when debug is enabled from project config', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-json-project-debug-snapshot-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
    const originalDebug = process.env.BRIDGE_DEBUG;
    delete process.env.BRIDGE_DEBUG;
    process.env.HOME = fakeHome;

    await mkdir(join(workspace, '.opencode'), { recursive: true });
    await writeFile(
      join(workspace, '.opencode', 'message-bridge.json'),
      JSON.stringify(createValidConfig({
        debug: true,
      })),
      'utf8',
    );

    const calls = [];
    const logger = new AppLogger(
      {
        app: {
          log: async (options) => {
            calls.push(options);
          },
        },
      },
      { component: 'test' },
      undefined,
      undefined,
      true,
    );

    try {
      const config = await loadConfig(workspace, logger);
      assert.strictEqual(config.debug, true);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const snapshot = calls.find((entry) => entry.body.message === 'config.env.snapshot');
      assert.ok(snapshot);
      assert.deepStrictEqual(snapshot.body.extra.values.BRIDGE_DEBUG, {
        present: false,
      });
    } finally {
      if (originalDebug === undefined) {
        delete process.env.BRIDGE_DEBUG;
      } else {
        process.env.BRIDGE_DEBUG = originalDebug;
      }
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });
});
