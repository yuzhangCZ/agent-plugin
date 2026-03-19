import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

describe('e2e smoke directory-context', () => {
  test('gateway-driven create_session and chat reuse BRIDGE_DIRECTORY', { timeout: 30000 }, () => {
    const stdout = execFileSync('node', ['./scripts/e2e-smoke.mjs'], {
      cwd: process.cwd(),
      stdio: 'pipe',
      env: {
        ...process.env,
        MB_SCENARIO: 'directory-context',
      },
    }).toString();

    assert.ok(stdout.includes('E2E PASS'));
    assert.ok(stdout.includes('scenario=directory-context'));
  });
});
