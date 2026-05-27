import type { InteractionLookupResult } from '../dto/results/index.js';

export interface InteractionLookupBridge {
  findQuestion(questionId: string): Promise<InteractionLookupResult>;
  findPermission(permissionId: string): Promise<InteractionLookupResult>;
}
