import type { GatewayToolEventV1 } from '../../contract/schemas/tool-event/index.ts';
import type { Result } from '../../shared/result.ts';
import type { WireContractViolation } from '../../contract/errors/wire-errors.ts';
import type { UnknownBoundaryInput } from '../../shared/boundary-types.ts';

/** 事件端口：校验插件投影后的 `tool_event.event` 是否满足共享外部契约。 */
export interface ToolEventValidatorPort {
  validate(raw: UnknownBoundaryInput): Result<GatewayToolEventV1, WireContractViolation>;
}
