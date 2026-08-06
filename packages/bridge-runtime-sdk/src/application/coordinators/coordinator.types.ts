import type { FactToSkillEventProjector, SkillEventToGatewayMessageProjector } from '../projectors/index.ts';
import type { OutboundSink } from '../ports/outbound-sink.ts';
import type { ToolErrorReporter } from '../reporters/index.ts';
import type { RuntimeObservation } from '../runtime-observation/index.ts';

export interface EventPipeline {
  sink: OutboundSink;
  factProjector: FactToSkillEventProjector;
  eventProjector: SkillEventToGatewayMessageProjector;
  toolErrorReporter: ToolErrorReporter;
  observation: RuntimeObservation;
}
