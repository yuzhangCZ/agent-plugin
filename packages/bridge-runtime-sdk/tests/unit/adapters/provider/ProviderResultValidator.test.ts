import assert from 'node:assert/strict';
import test from 'node:test';

import { ProviderResultValidator } from '@/adapters/provider/ProviderResultValidator.ts';

test('ProviderResultValidator keeps valid slash commands and trims descriptions', () => {
  const validator = new ProviderResultValidator();

  const result = validator.validateListSlashCommandsResult({
    slashCommands: [
      { command: '/new', description: '  New session  ' },
      { command: '/status', description: 'Status' },
    ],
  });

  assert.deepEqual(result, {
    slashCommands: [
      { command: '/new', description: 'New session' },
      { command: '/status', description: 'Status' },
    ],
  });
});

test('ProviderResultValidator drops slash commands without a single slash command token', () => {
  const validator = new ProviderResultValidator();

  const result = validator.validateListSlashCommandsResult({
    slashCommands: [
      { command: 'new', description: 'missing slash' },
      { command: '//new', description: 'double slash' },
      { command: '/new chat', description: 'contains whitespace' },
      { command: '/valid', description: 'valid' },
    ],
  });

  assert.deepEqual(result, {
    slashCommands: [{ command: '/valid', description: 'valid' }],
  });
});
