import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { SubagentSessionMapper } from '../../src/session/SubagentSessionMapper.ts';

function createClient(sessionGet) {
  return {
    session: {
      get: sessionGet,
    },
  };
}

describe('subagent session mapper', () => {
  test('records child mapping from session.created control event', async () => {
    const getCalls = [];
    const mapper = new SubagentSessionMapper(createClient(async (options) => {
      getCalls.push(options);
      return {
        data: {
          id: 'unexpected',
        },
      };
    }));

    mapper.recordSessionCreated({
      childSessionId: 'ses_child_1',
      parentSessionId: 'ses_parent_1',
      agentName: 'research-agent',
    });

    await assert.doesNotReject(async () => {
      assert.deepStrictEqual(await mapper.resolve('ses_child_1'), {
        status: 'mapped',
        mapping: {
          childSessionId: 'ses_child_1',
          parentSessionId: 'ses_parent_1',
          agentName: 'research-agent',
        },
      });
    });
    assert.strictEqual(getCalls.length, 0);
  });

  test('uses session.get official response shape to lazily resolve child mappings', async () => {
    const getCalls = [];
    const mapper = new SubagentSessionMapper(createClient(async (options) => {
      getCalls.push(options);
      return {
        data: {
          id: 'ses_child_2',
          parentID: 'ses_parent_2',
          title: 'planner-agent',
        },
      };
    }));

    assert.deepStrictEqual(await mapper.resolve('ses_child_2'), {
      status: 'mapped',
      mapping: {
        childSessionId: 'ses_child_2',
        parentSessionId: 'ses_parent_2',
        agentName: 'planner-agent',
      },
    });
    assert.deepStrictEqual(await mapper.resolve('ses_child_2'), {
      status: 'mapped',
      mapping: {
        childSessionId: 'ses_child_2',
        parentSessionId: 'ses_parent_2',
        agentName: 'planner-agent',
      },
    });
    assert.deepStrictEqual(getCalls, [
      {
        sessionID: 'ses_child_2',
      },
    ]);
  });

  test('negative-caches main sessions to avoid repeated session.get calls', async () => {
    const getCalls = [];
    const mapper = new SubagentSessionMapper(createClient(async (options) => {
      getCalls.push(options);
      return {
        data: {
          id: 'ses_parent_3',
          title: 'main-session',
        },
      };
    }));

    assert.deepStrictEqual(await mapper.resolve('ses_parent_3'), { status: 'root' });
    assert.deepStrictEqual(await mapper.resolve('ses_parent_3'), { status: 'root' });
    assert.deepStrictEqual(getCalls, [
      {
        sessionID: 'ses_parent_3',
      },
    ]);
  });

  test('does not negative-cache session.get error wrapper failures', async () => {
    let calls = 0;
    const mapper = new SubagentSessionMapper(createClient(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          error: {
            message: 'temporary sdk failure',
            code: 'SDK_UNREACHABLE',
          },
        };
      }

      return {
        data: {
          id: 'ses_child_4',
          parentID: 'ses_parent_4',
          title: 'recovered-agent',
        },
      };
    }));

    assert.deepStrictEqual(await mapper.resolve('ses_child_4'), {
      status: 'lookup_failed',
      error: {
        message: 'temporary sdk failure',
        code: 'SDK_UNREACHABLE',
      },
    });
    assert.deepStrictEqual(await mapper.resolve('ses_child_4'), {
      status: 'mapped',
      mapping: {
        childSessionId: 'ses_child_4',
        parentSessionId: 'ses_parent_4',
        agentName: 'recovered-agent',
      },
    });
    assert.strictEqual(calls, 2);
  });

  test('does not negative-cache thrown session.get failures', async () => {
    let calls = 0;
    const mapper = new SubagentSessionMapper(createClient(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('network timeout');
      }

      return {
        data: {
          id: 'ses_child_5',
          parentID: 'ses_parent_5',
          title: 'retry-agent',
        },
      };
    }));

    const first = await mapper.resolve('ses_child_5');
    assert.strictEqual(first.status, 'lookup_failed');
    assert.match(first.error.message, /network timeout/);
    assert.deepStrictEqual(await mapper.resolve('ses_child_5'), {
      status: 'mapped',
      mapping: {
        childSessionId: 'ses_child_5',
        parentSessionId: 'ses_parent_5',
        agentName: 'retry-agent',
      },
    });
    assert.strictEqual(calls, 2);
  });
});
