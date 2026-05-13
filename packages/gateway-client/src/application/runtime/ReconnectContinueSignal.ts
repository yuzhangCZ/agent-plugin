/**
 * 内部信号：当前 reconnect attempt 命中可继续窗口的 close 事实，需要由 orchestrator 安排下一次 attempt。
 */
export class ReconnectContinueSignal extends Error {
  constructor() {
    super('gateway_reconnect_continue');
  }
}
