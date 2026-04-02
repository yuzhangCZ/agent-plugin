import type { ConnectionState, ErrorCode } from './common.js';
import type {
  ActionName,
  ActionPayloadByName,
  ActionResultDataByName,
} from '../contracts/downstream-messages.js';
import type { HostClientLike, OpencodeClient } from './sdk.js';
import type { BridgeLogger } from './logger.js';
import type { ToolErrorEvidence } from '../utils/error.js';

export interface ActionContext {
  client: OpencodeClient;
  hostClient: HostClientLike;
  connectionState: ConnectionState;
  agentId: string;
  welinkSessionId?: string;
  // 兼容字段：仅 create_session 的目录决策链路消费，其他 action 不应透传。
  effectiveDirectory?: string;
  assiantDirectoryMappingConfigured?: boolean;
  logger?: BridgeLogger;
}

export type ActionSuccess<TData = void> = TData extends void
  ? { success: true; data?: undefined }
  : { success: true; data: TData };

export interface ActionFailure {
  success: false;
  errorCode?: ErrorCode;
  errorMessage?: string;
  errorEvidence?: ToolErrorEvidence;
}

export type ActionResult<TData = void> = ActionSuccess<TData> | ActionFailure;

export interface Action<
  TName extends ActionName = ActionName,
  TPayload extends ActionPayloadByName[TName] = ActionPayloadByName[TName],
  TData = ActionResultDataByName[TName],
> {
  name: TName;
  execute(payload: TPayload, context: ActionContext): Promise<ActionResult<TData>>;
  errorMapper(error: unknown): ErrorCode;
}
