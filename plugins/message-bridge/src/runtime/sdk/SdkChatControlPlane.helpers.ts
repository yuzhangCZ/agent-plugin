import { randomUUID } from 'node:crypto';
import type {
  MessageDoneFact,
  MessageStartFact,
  ProviderFact,
  ProviderRun,
  TextDeltaFact,
  TextDoneFact,
} from '@wecode/bridge-runtime-sdk';

function fromFacts(facts: ProviderFact[]): AsyncIterable<ProviderFact> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const fact of facts) {
        yield fact;
      }
    },
  };
}

export function buildSyntheticRun(toolSessionId: string, text: string): ProviderRun {
  const messageId = `msg_${randomUUID().replaceAll('-', '')}`;
  const partId = `prt_${randomUUID().replaceAll('-', '')}`;
  const facts: ProviderFact[] = [
    {
      type: 'message.start',
      messageId,
    } satisfies MessageStartFact,
    {
      type: 'text.delta',
      messageId,
      partId,
      content: text,
    } satisfies TextDeltaFact,
    {
      type: 'text.done',
      messageId,
      partId,
      content: text,
    } satisfies TextDoneFact,
    {
      type: 'message.done',
      messageId,
      reason: 'stop',
    } satisfies MessageDoneFact,
  ];

  return {
    runId: `synthetic-${toolSessionId}`,
    facts: fromFacts(facts),
    async result() {
      return { outcome: 'completed' };
    },
  };
}
