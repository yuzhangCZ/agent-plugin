import type { BridgeEvent } from '../../../runtime/types.js';
import type { HostEventHandleResult } from '../dto/results/index.js';

export interface HostEventPort {
  handle(event: BridgeEvent): Promise<HostEventHandleResult>;
}
