export function createLargeMessageUpdatedEvent() {
  const aiGatewayBefore = '[INFO] ai-gateway before line\n'.repeat(24000);
  const aiGatewayAfter = `${aiGatewayBefore}[INFO] ai-gateway after tail\n`.repeat(2);
  const skillServerBefore = '[INFO] skill-server before line\n'.repeat(22000);
  const skillServerAfter = `${skillServerBefore}[INFO] skill-server after tail\n`.repeat(2);

  return {
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg_large_summary_fixture',
        sessionID: 'ses_large_summary_fixture',
        role: 'user',
        time: {
          created: 1774001188464,
        },
        model: {
          providerID: 'bailian-coding-plan',
          modelID: 'kimi-k2.5',
        },
        summary: {
          additions: 1227,
          deletions: 0,
          files: 2,
          diffs: [
            {
              file: 'logs/local-stack/ai-gateway.log',
              status: 'modified',
              additions: 829,
              deletions: 0,
              before: aiGatewayBefore,
              after: aiGatewayAfter,
            },
            {
              file: 'logs/local-stack/skill-server.log',
              status: 'modified',
              additions: 398,
              deletions: 0,
              before: skillServerBefore,
              after: skillServerAfter,
            },
          ],
        },
      },
    },
  };
}
