#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const smokeTests = [
  'tests/e2e/connect-register.test.mjs',
  'tests/e2e/chat-stream.test.mjs',
  'tests/e2e/permission-roundtrip.test.mjs',
  'tests/e2e/directory-context.test.mjs',
];

for (const smokeTest of smokeTests) {
  const result = spawnSync(
    'node',
    ['--import', 'tsx/esm', '--test-isolation=none', '--test', smokeTest],
    {
      stdio: 'inherit',
      env: process.env,
    },
  );

  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }
}

process.exit(0);
