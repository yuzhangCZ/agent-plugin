#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const tracked = new Set();
for (const candidate of ['release', 'plugins/message-bridge/release']) {
  const output = execFileSync('git', ['ls-files', candidate], {
    encoding: 'utf8',
  });
  for (const line of output.split('\n')) {
    const normalized = line.trim();
    if (normalized) {
      tracked.add(normalized);
    }
  }
}

if (tracked.size > 0) {
  console.error('[check-release-tracking] failed: release artifacts must not be tracked by git.');
  for (const file of tracked) {
    console.error(`- ${file}`);
  }
  process.exit(1);
}

console.log('Release tracking check passed: no tracked files under plugins/message-bridge/release.');
