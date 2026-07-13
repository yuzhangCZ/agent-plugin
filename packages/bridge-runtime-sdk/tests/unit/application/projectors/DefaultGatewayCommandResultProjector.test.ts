import assert from 'node:assert/strict';
import test from 'node:test';

import { DefaultGatewayCommandResultProjector } from '@/application/projectors/index.ts';

test('DefaultGatewayCommandResultProjector maps status, session created, and slash command results', () => {
  const projector = new DefaultGatewayCommandResultProjector();

  assert.deepEqual(projector.projectStatus({ online: true }), {
    type: 'status_response',
    opencodeOnline: true,
  });
  assert.deepEqual(projector.projectSessionCreated({ welinkSessionId: 'we-1', toolSessionId: 'tool-1' }), {
    type: 'session_created',
    welinkSessionId: 'we-1',
    toolSessionId: 'tool-1',
    session: { sessionId: 'tool-1' },
  });
  assert.deepEqual(projector.projectSlashCommands({
    toolSessionId: 'tool-1',
    traceId: 'trace-1',
    slashCommands: [{ command: '/new', description: 'New session' }],
  }), {
    type: 'slash_commands_result',
    toolSessionId: 'tool-1',
    traceId: 'trace-1',
    payload: {
      slashCommands: [{ command: '/new', description: 'New session' }],
    },
  });
});
