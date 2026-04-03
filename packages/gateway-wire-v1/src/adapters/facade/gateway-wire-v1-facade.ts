import type { DownstreamNormalizerPort } from '../../application/ports/downstream-normalizer-port.ts';
import type { ProtocolFailureReporterPort } from '../../application/ports/protocol-failure-reporter-port.ts';
import type { ToolEventValidatorPort } from '../../application/ports/tool-event-validator-port.ts';
import type { TransportMessageValidatorPort } from '../../application/ports/transport-message-validator-port.ts';
import type { DownstreamMessage } from '../../contract/schemas/downstream.ts';
import type { GatewayToolEventV1 } from '../../contract/schemas/tool-event/index.ts';
import type { Result } from '../../shared/result.ts';
import type { UpstreamTransportMessage } from '../../contract/schemas/upstream.ts';
import type { WireContractViolation } from '../../contract/errors/wire-errors.ts';
import type { UnknownBoundaryInput } from '../../shared/boundary-types.ts';
import { NoopProtocolFailureReporter } from '../reporters/noop-protocol-failure-reporter.ts';
import { DefaultDownstreamNormalizer } from '../validators/downstream-normalizer.ts';
import { DefaultToolEventValidator } from '../validators/tool-event-validator.ts';
import { DefaultTransportMessageValidator } from '../validators/transport-message-validator.ts';
import { normalizeDownstreamUseCase } from '../../application/usecases/normalize-downstream.ts';
import { validateToolEventUseCase } from '../../application/usecases/validate-tool-event.ts';
import { validateUpstreamMessageUseCase } from '../../application/usecases/validate-upstream-message.ts';

export interface GatewayWireV1FacadeOptions {
  reporter?: ProtocolFailureReporterPort;
  downstreamNormalizer?: DownstreamNormalizerPort;
  toolEventValidator?: ToolEventValidatorPort;
  transportMessageValidator?: TransportMessageValidatorPort;
}

/**
 * `gateway-wire-v1` 的唯一公开入口。
 * 调用方只应在边界层把原始输入交给这里做归一化/校验，
 * 不应直接依赖内部 validator 细节。
 */
export class GatewayWireV1Facade {
  private readonly reporter: ProtocolFailureReporterPort;
  private readonly downstreamNormalizer: DownstreamNormalizerPort;
  private readonly toolEventValidator: ToolEventValidatorPort;
  private readonly transportMessageValidator: TransportMessageValidatorPort;

  constructor(options: GatewayWireV1FacadeOptions = {}) {
    this.reporter = options.reporter ?? new NoopProtocolFailureReporter();
    this.downstreamNormalizer = options.downstreamNormalizer ?? new DefaultDownstreamNormalizer();
    this.toolEventValidator = options.toolEventValidator ?? new DefaultToolEventValidator();
    this.transportMessageValidator = options.transportMessageValidator ?? new DefaultTransportMessageValidator();
  }

  /** 下行入口：把 gateway -> plugin 的原始消息收窄成共享协议对象。 */
  normalizeDownstream(raw: UnknownBoundaryInput): Result<DownstreamMessage, WireContractViolation> {
    return normalizeDownstreamUseCase(
      { raw },
      {
        normalizer: this.downstreamNormalizer,
        reporter: this.reporter,
      },
    );
  }

  /** 事件入口：校验插件投影后的 `tool_event.event` 是否满足共享外部契约。 */
  validateToolEvent(raw: UnknownBoundaryInput): Result<GatewayToolEventV1, WireContractViolation> {
    return validateToolEventUseCase(
      { raw },
      {
        validator: this.toolEventValidator,
        reporter: this.reporter,
      },
    );
  }

  /** 上行入口：所有发往 gateway 的 transport 消息都应先经过这里。 */
  validateUpstreamMessage(raw: UnknownBoundaryInput): Result<UpstreamTransportMessage, WireContractViolation> {
    return validateUpstreamMessageUseCase(
      { raw },
      {
        validator: this.transportMessageValidator,
        reporter: this.reporter,
      },
    );
  }
}

const defaultFacade = new GatewayWireV1Facade();

/** 便捷函数：默认复用单例 façade，避免调用方重复组装依赖。 */
export function normalizeDownstream(raw: UnknownBoundaryInput, options?: GatewayWireV1FacadeOptions) {
  return (options ? new GatewayWireV1Facade(options) : defaultFacade).normalizeDownstream(raw);
}

/** 便捷函数：供插件在发送 `tool_event` 前做统一协议准入。 */
export function validateToolEvent(raw: UnknownBoundaryInput, options?: GatewayWireV1FacadeOptions) {
  return (options ? new GatewayWireV1Facade(options) : defaultFacade).validateToolEvent(raw);
}

/** 便捷函数：供插件在发送任意上行 transport 消息前做统一协议准入。 */
export function validateUpstreamMessage(raw: UnknownBoundaryInput, options?: GatewayWireV1FacadeOptions) {
  return (options ? new GatewayWireV1Facade(options) : defaultFacade).validateUpstreamMessage(raw);
}
