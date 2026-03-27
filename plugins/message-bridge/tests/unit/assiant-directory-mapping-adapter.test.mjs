import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsonAssiantDirectoryMappingAdapter } from '../../src/adapter/JsonAssiantDirectoryMappingAdapter.ts';

function createLoggerRecorder() {
  const calls = [];
  const logger = {
    debug: (message, extra) => calls.push({ level: 'debug', message, extra }),
    info: (message, extra) => calls.push({ level: 'info', message, extra }),
    warn: (message, extra) => calls.push({ level: 'warn', message, extra }),
    error: (message, extra) => calls.push({ level: 'error', message, extra }),
    child: () => logger,
    getTraceId: () => 'test-trace-id',
  };

  return { calls, logger };
}

async function withTempMapFile(content, run) {
  const workspace = await mkdtemp(join(tmpdir(), 'mb-assiant-map-'));
  const filePath = join(workspace, 'assiant-directory-map.json');
  await writeFile(filePath, content, 'utf8');

  try {
    await run(filePath);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

describe('JsonAssiantDirectoryMappingAdapter', () => {
  test('resolves nested directory mapping', async () => {
    await withTempMapFile(
      JSON.stringify({
        'persona-1': {
          directory: '/tenant/persona-1',
        },
      }),
      async (filePath) => {
        const { calls, logger } = createLoggerRecorder();
        const adapter = new JsonAssiantDirectoryMappingAdapter(filePath, () => logger);

        const result = await adapter.resolveDirectory('persona-1');

        assert.strictEqual(result, '/tenant/persona-1');
        assert.strictEqual(calls.some((call) => call.message === 'assiant.directory_map.invalid_entry'), false);
      },
    );
  });

  test('warns when root is not an object', async () => {
    await withTempMapFile(JSON.stringify('not-an-object'), async (filePath) => {
      const { calls, logger } = createLoggerRecorder();
      const adapter = new JsonAssiantDirectoryMappingAdapter(filePath, () => logger);

      const result = await adapter.resolveDirectory('persona-1');

      assert.strictEqual(result, undefined);
      assert.deepStrictEqual(
        calls.filter((call) => call.message === 'assiant.directory_map.invalid_shape'),
        [
          {
            level: 'warn',
            message: 'assiant.directory_map.invalid_shape',
            extra: {
              filePath,
              reason: 'root_not_object',
              rootType: 'string',
            },
          },
        ],
      );
    });
  });

  test('warns when root is an array', async () => {
    await withTempMapFile(JSON.stringify([]), async (filePath) => {
      const { calls, logger } = createLoggerRecorder();
      const adapter = new JsonAssiantDirectoryMappingAdapter(filePath, () => logger);

      const result = await adapter.resolveDirectory('persona-1');

      assert.strictEqual(result, undefined);
      assert.deepStrictEqual(
        calls.filter((call) => call.message === 'assiant.directory_map.invalid_shape'),
        [
          {
            level: 'warn',
            message: 'assiant.directory_map.invalid_shape',
            extra: {
              filePath,
              reason: 'root_not_object',
              rootType: 'array',
            },
          },
        ],
      );
    });
  });

  test('warns on legacy flat string entries', async () => {
    await withTempMapFile(
      JSON.stringify({
        'persona-1': '/tenant/persona-1',
      }),
      async (filePath) => {
        const { calls, logger } = createLoggerRecorder();
        const adapter = new JsonAssiantDirectoryMappingAdapter(filePath, () => logger);

        const result = await adapter.resolveDirectory('persona-1');

        assert.strictEqual(result, undefined);
        assert.deepStrictEqual(
          calls.filter((call) => call.message === 'assiant.directory_map.invalid_entry').map((call) => call.extra),
          [
            {
              filePath,
              assiantId: 'persona-1',
              entryType: 'string',
              isLegacyFlatString: true,
              hasValidAssiantId: true,
            },
          ],
        );
        assert.strictEqual(calls.some((call) => call.message === 'assiant.directory_map.invalid_shape'), false);
      },
    );
  });

  test('warns on blank assiantId keys instead of silently ignoring them', async () => {
    await withTempMapFile(
      JSON.stringify({
        '   ': {
          directory: '/tenant/blank-key',
        },
      }),
      async (filePath) => {
        const { calls, logger } = createLoggerRecorder();
        const adapter = new JsonAssiantDirectoryMappingAdapter(filePath, () => logger);

        const result = await adapter.resolveDirectory('persona-1');

        assert.strictEqual(result, undefined);
        assert.deepStrictEqual(
          calls.filter((call) => call.message === 'assiant.directory_map.invalid_entry').map((call) => call.extra),
          [
            {
              filePath,
              assiantId: '   ',
              entryType: 'object',
              isLegacyFlatString: false,
              hasValidAssiantId: false,
            },
          ],
        );
      },
    );
  });

  test('warns when nested entry misses a valid directory', async () => {
    await withTempMapFile(
      JSON.stringify({
        'persona-1': {
          directory: '   ',
        },
        'persona-2': {},
        'persona-3': {
          directory: 123,
        },
        'persona-4': null,
        'persona-5': false,
        'persona-6': [],
      }),
      async (filePath) => {
        const { calls, logger } = createLoggerRecorder();
        const adapter = new JsonAssiantDirectoryMappingAdapter(filePath, () => logger);

        const persona1 = await adapter.resolveDirectory('persona-1');

        assert.strictEqual(persona1, undefined);

        const warnings = calls.filter((call) => call.message === 'assiant.directory_map.invalid_entry');
        assert.deepStrictEqual(warnings.map((call) => call.extra), [
          {
            filePath,
            assiantId: 'persona-1',
            entryType: 'object',
            isLegacyFlatString: false,
            hasValidAssiantId: true,
            hasDirectory: true,
            directoryType: 'string',
          },
          {
            filePath,
            assiantId: 'persona-2',
            entryType: 'object',
            isLegacyFlatString: false,
            hasValidAssiantId: true,
            hasDirectory: false,
            directoryType: 'undefined',
          },
          {
            filePath,
            assiantId: 'persona-3',
            entryType: 'object',
            isLegacyFlatString: false,
            hasValidAssiantId: true,
            hasDirectory: true,
            directoryType: 'number',
          },
          {
            filePath,
            assiantId: 'persona-4',
            entryType: 'null',
            isLegacyFlatString: false,
            hasValidAssiantId: true,
          },
          {
            filePath,
            assiantId: 'persona-5',
            entryType: 'boolean',
            isLegacyFlatString: false,
            hasValidAssiantId: true,
          },
          {
            filePath,
            assiantId: 'persona-6',
            entryType: 'array',
            isLegacyFlatString: false,
            hasValidAssiantId: true,
          },
        ]);
      },
    );
  });

  test('keeps valid nested entries when the file contains mixed invalid entries', async () => {
    await withTempMapFile(
      JSON.stringify({
        'persona-ok': {
          directory: '/tenant/persona-ok',
        },
        'persona-legacy': '/tenant/legacy',
        'persona-null': null,
      }),
      async (filePath) => {
        const { calls, logger } = createLoggerRecorder();
        const adapter = new JsonAssiantDirectoryMappingAdapter(filePath, () => logger);

        const result = await adapter.resolveDirectory('persona-ok');

        assert.strictEqual(result, '/tenant/persona-ok');
        assert.deepStrictEqual(
          calls.filter((call) => call.message === 'assiant.directory_map.invalid_entry').map((call) => call.extra),
          [
            {
              filePath,
              assiantId: 'persona-legacy',
              entryType: 'string',
              isLegacyFlatString: true,
              hasValidAssiantId: true,
            },
            {
              filePath,
              assiantId: 'persona-null',
              entryType: 'null',
              isLegacyFlatString: false,
              hasValidAssiantId: true,
            },
          ],
        );
      },
    );
  });

  test('reloads the mapping file on each lookup', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-assiant-map-hot-'));
    const filePath = join(workspace, 'assiant-directory-map.json');
    await writeFile(
      filePath,
      JSON.stringify({
        'persona-1': {
          directory: '/tenant/persona-1',
        },
      }),
      'utf8',
    );

    try {
      const { logger } = createLoggerRecorder();
      const adapter = new JsonAssiantDirectoryMappingAdapter(filePath, () => logger);

      assert.strictEqual(await adapter.resolveDirectory('persona-1'), '/tenant/persona-1');

      await writeFile(
        filePath,
        JSON.stringify({
          'persona-1': {
            directory: '/tenant/persona-2',
          },
        }),
        'utf8',
      );

      assert.strictEqual(await adapter.resolveDirectory('persona-1'), '/tenant/persona-2');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
