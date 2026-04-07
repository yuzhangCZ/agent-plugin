import type { WireViolation } from '../../contract/errors/wire-errors.ts';

/** 失败报告端口：统一承接协议违约信息，供日志或测试记录使用。 */
export interface ProtocolFailureReporterPort {
  report(violation: WireViolation): void;
}
