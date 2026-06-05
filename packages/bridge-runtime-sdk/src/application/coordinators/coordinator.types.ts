import type { FactToSkillEventProjector, SkillEventToGatewayMessageProjector } from '../projectors/index.ts';
import type { OutboundSink } from '../ports/outbound-sink.ts';
import type { RuntimeObservation } from '../runtime-observation/index.ts';

export interface EventPipeline {
  sink: OutboundSink;
  factProjector: FactToSkillEventProjector;
  eventProjector: SkillEventToGatewayMessageProjector;
  observation: RuntimeObservation;
  toolDoneCompatDelay: {
    sleep: (ms: number) => Promise<void>;
    delayMs: number;
  };
}
