// 包入口只暴露稳定共享契约和 facade；消费者不应再依赖内部源码层级路径。
export * from './shared/result.ts';
export * from './contract/index.ts';
export * from './application/ports/downstream-normalizer-port.ts';
export * from './application/ports/tool-event-validator-port.ts';
export * from './application/ports/transport-message-validator-port.ts';
export * from './application/ports/protocol-failure-reporter-port.ts';
export * from './adapters/reporters/noop-protocol-failure-reporter.ts';
export * from './adapters/reporters/recording-protocol-failure-reporter.ts';
export * from './adapters/facade/gateway-wire-v1-facade.ts';
