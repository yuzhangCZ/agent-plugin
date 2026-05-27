import type { BridgeEvent } from '../../../runtime/types.js';
import type { RuntimeAppliedResult } from '../dto/results/index.js';

export interface OwnedHostEventForwarder {
  forward(input: { toolSessionId: string; event: BridgeEvent }): Promise<RuntimeAppliedResult>;
}
