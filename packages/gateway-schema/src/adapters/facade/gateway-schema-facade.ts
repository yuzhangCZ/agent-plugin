import type { DownstreamNormalizerPort } from '../../application/ports/downstream-normalizer-port.ts';
import type { ProtocolFailureReporterPort } from '../../application/ports/protocol-failure-reporter-port.ts';
import type { ToolEventValidatorPort } from '../../application/ports/tool-event-validator-port.ts';
import type { TransportMessageValidatorPort } from '../../application/ports/transport-message-validator-port.ts';
import type { GatewayDownstreamBusinessRequest } from '../../contract/schemas/downstream.ts';
import type { GatewayToolEventPayload } from '../../contract/schemas/tool-event/index.ts';
import type { Result } from '../../shared/result.ts';
import type { GatewayUplinkBusinessMessage, GatewayWireProtocol } from '../../contract/schemas/upstream.ts';
import type { WireContractViolation } from '../../contract/errors/wire-errors.ts';
import type { UnknownBoundaryInput } from '../../shared/boundary-types.ts';
import { NoopProtocolFailureReporter } from '../reporters/noop-protocol-failure-reporter.ts';
import { DefaultDownstreamNormalizer } from '../validators/downstream-normalizer.ts';
import { DefaultToolEventValidator } from '../validators/tool-event-validator.ts';
import { DefaultTransportMessageValidator } from '../validators/transport-message-validator.ts';
import { normalizeDownstreamUseCase } from '../../application/usecases/normalize-downstream.ts';
import { validateToolEventUseCase } from '../../application/usecases/validate-tool-event.ts';
import { validateGatewayWireProtocolMessageUseCase } from '../../application/usecases/validate-gateway-wire-protocol-message.ts';
import { zodErrorToWireViolation } from '../zod/zod-error-to-wire-violation.ts';
import { gatewayUplinkBusinessMessageSchema } from '../../contract/schemas/upstream.ts';

export interface GatewaySchemaFacadeOptions {
  reporter?: ProtocolFailureReporterPort;
  downstreamNormalizer?: DownstreamNormalizerPort;
  toolEventValidator?: ToolEventValidatorPort;
  transportMessageValidator?: TransportMessageValidatorPort;
}

/**
 * `gateway-schema` 的唯一公开入口。
 * 调用方只应在边界层把原始输入交给这里做归一化/校验，
 * 不应直接依赖内部 validator 细节。
 */
export class GatewaySchemaFacade {
  private readonly reporter: ProtocolFailureReporterPort;
  private readonly downstreamNormalizer: DownstreamNormalizerPort;
  private readonly toolEventValidator: ToolEventValidatorPort;
  private readonly transportMessageValidator: TransportMessageValidatorPort;

  constructor(options: GatewaySchemaFacadeOptions = {}) {
    this.reporter = options.reporter ?? new NoopProtocolFailureReporter();
    this.downstreamNormalizer = options.downstreamNormalizer ?? new DefaultDownstreamNormalizer();
    this.toolEventValidator = options.toolEventValidator ?? new DefaultToolEventValidator();
    this.transportMessageValidator = options.transportMessageValidator ?? new DefaultTransportMessageValidator();
  }

  /** 下行入口：把 gateway -> plugin 的原始消息收窄成共享协议对象。 */
  normalizeDownstream(raw: UnknownBoundaryInput): Result<GatewayDownstreamBusinessRequest, WireContractViolation> {
    return normalizeDownstreamUseCase(
      { raw },
      {
        normalizer: this.downstreamNormalizer,
        reporter: this.reporter,
      },
    );
  }

  /** 事件入口：校验插件投影后的 `tool_event.event` 是否满足共享外部契约。 */
  validateToolEvent(raw: UnknownBoundaryInput): Result<GatewayToolEventPayload, WireContractViolation> {
    return validateToolEventUseCase(
      { raw },
      {
        validator: this.toolEventValidator,
        reporter: this.reporter,
      },
    );
  }

  /** 上行入口：校验全量 current-state wire protocol union。 */
  validateGatewayWireProtocolMessage(raw: UnknownBoundaryInput): Result<GatewayWireProtocol, WireContractViolation> {
    return validateGatewayWireProtocolMessageUseCase(
      { raw },
      {
        validator: this.transportMessageValidator,
        reporter: this.reporter,
      },
    );
  }

  /** 业务上行入口：只接收 `tool_event` / `tool_done` / `tool_error` / `session_created` / `status_response`。 */
  validateGatewayUplinkBusinessMessage(raw: UnknownBoundaryInput): Result<GatewayUplinkBusinessMessage, WireContractViolation> {
    const result = this.validateGatewayWireProtocolMessage(raw);
    if (!result.ok) {
      return result;
    }

    const parsed = gatewayUplinkBusinessMessageSchema.safeParse(result.value);
    if (parsed.success) {
      return { ok: true, value: parsed.data };
    }

    const violation = zodErrorToWireViolation(parsed.error, {
      stage: 'transport',
      messageType: typeof raw === 'object' && raw !== null && 'type' in raw ? String((raw as { type?: unknown }).type) : undefined,
    });
    this.reporter.report(violation.violation);
    return { ok: false, error: violation };
  }

}

const defaultFacade = new GatewaySchemaFacade();

/** 便捷函数：默认复用单例 façade，避免调用方重复组装依赖。 */
export function normalizeDownstream(raw: UnknownBoundaryInput, options?: GatewaySchemaFacadeOptions) {
  return (options ? new GatewaySchemaFacade(options) : defaultFacade).normalizeDownstream(raw);
}

/** 便捷函数：供插件在发送 `tool_event` 前做统一协议准入。 */
export function validateToolEvent(raw: UnknownBoundaryInput, options?: GatewaySchemaFacadeOptions) {
  return (options ? new GatewaySchemaFacade(options) : defaultFacade).validateToolEvent(raw);
}

/** 便捷函数：只校验协议层业务上行消息。 */
export function validateGatewayUplinkBusinessMessage(raw: UnknownBoundaryInput, options?: GatewaySchemaFacadeOptions) {
  return (options ? new GatewaySchemaFacade(options) : defaultFacade).validateGatewayUplinkBusinessMessage(raw);
}

/** 便捷函数：校验 current-state umbrella wire protocol union。 */
export function validateGatewayWireProtocolMessage(raw: UnknownBoundaryInput, options?: GatewaySchemaFacadeOptions) {
  return (options ? new GatewaySchemaFacade(options) : defaultFacade).validateGatewayWireProtocolMessage(raw);
}
