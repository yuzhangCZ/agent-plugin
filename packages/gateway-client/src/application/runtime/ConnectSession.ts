import type { GatewayTransport } from '../../ports/GatewayTransport.ts';
import type { GatewayRuntimeContext, GatewayRuntimeStatePort } from './GatewayRuntimeContracts.ts';
import { GatewayClientError } from '../../errors/GatewayClientError.ts';
import type { GatewayClientErrorPhase, GatewayClientErrorSource } from '../../domain/error-contract.ts';
import { extractWebSocketErrorDetails, getErrorDetails } from '../telemetry/error-detail-mapper.ts';
import type { InboundClassificationResult, InboundFrameClassifier } from './InboundFrameClassifier.ts';
import type { HandshakeFrameProcessor, HandshakeResult } from './HandshakeFrameProcessor.ts';
import { InboundFrameRouter } from './InboundFrameRouter.ts';
import { OutboundSender } from './OutboundSender.ts';
import { ReconnectOrchestrator } from './ReconnectOrchestrator.ts';
import { HeartbeatLoop } from './HeartbeatLoop.ts';
import { shouldRetryOnClose } from './shouldRetryOnClose.ts';

const GATEWAY_REJECTION_CLOSE_CODES = new Set([4403, 4408, 4409]);

type GatewayCloseEventLike = Partial<CloseEvent> & {
  code?: unknown;
  reason?: unknown;
  wasClean?: unknown;
};

type ConnectAttemptPhase = 'transport-opening' | 'register-sent' | 'ready' | 'terminal';

function isGatewayRejectedCloseCode(code: unknown): boolean {
  return typeof code === 'number' && Number.isFinite(code) && GATEWAY_REJECTION_CLOSE_CODES.has(code);
}

class ConnectAttempt {
  private readonly transport: GatewayTransport;
  private readonly outboundSender: OutboundSender;
  private readonly inboundFrameClassifier: InboundFrameClassifier;
  private readonly handshakeFrameProcessor: HandshakeFrameProcessor;
  private readonly inboundFrameRouter: InboundFrameRouter;
  private readonly reconnectOrchestrator: ReconnectOrchestrator;
  private readonly heartbeatLoop: HeartbeatLoop;
  private readonly context: GatewayRuntimeContext;
  private readonly state: GatewayRuntimeStatePort;
  private readonly releaseHandshakeOwnership: () => void;
  private readonly onTerminal: () => void;
  private readonly reconnectAttempt: boolean;
  private readonly connectPromise: Promise<void>;
  private resolveConnect!: () => void;
  private rejectConnect!: (error: GatewayClientError) => void;
  private phase: ConnectAttemptPhase = 'transport-opening';
  private opened = false;
  private connectSettled = false;
  private terminalError: GatewayClientError | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private terminalCleanupCompleted = false;

  constructor(
    transport: GatewayTransport,
    outboundSender: OutboundSender,
    inboundFrameClassifier: InboundFrameClassifier,
    handshakeFrameProcessor: HandshakeFrameProcessor,
    inboundFrameRouter: InboundFrameRouter,
    reconnectOrchestrator: ReconnectOrchestrator,
    heartbeatLoop: HeartbeatLoop,
    context: GatewayRuntimeContext,
    state: GatewayRuntimeStatePort,
    releaseHandshakeOwnership: () => void,
    onTerminal: () => void,
    reconnectAttempt: boolean,
  ) {
    this.transport = transport;
    this.outboundSender = outboundSender;
    this.inboundFrameClassifier = inboundFrameClassifier;
    this.handshakeFrameProcessor = handshakeFrameProcessor;
    this.inboundFrameRouter = inboundFrameRouter;
    this.reconnectOrchestrator = reconnectOrchestrator;
    this.heartbeatLoop = heartbeatLoop;
    this.context = context;
    this.state = state;
    this.releaseHandshakeOwnership = releaseHandshakeOwnership;
    this.onTerminal = onTerminal;
    this.reconnectAttempt = reconnectAttempt;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
  }

  get promise(): Promise<void> {
    return this.connectPromise;
  }

  private isTerminal(): boolean {
    return this.phase === 'terminal';
  }

  private resolveErrorPhase(): GatewayClientErrorPhase {
    if (this.context.abortSignal?.aborted || this.state.isManuallyDisconnected()) {
      return 'stopping';
    }
    if (this.reconnectAttempt && this.phase !== 'ready') {
      return 'reconnecting';
    }
    switch (this.phase) {
      case 'transport-opening':
        return 'before_open';
      case 'register-sent':
        return 'before_ready';
      case 'ready':
        return 'ready';
      case 'terminal':
        return this.opened ? 'before_ready' : 'before_open';
    }
  }

  start(url: string, protocols?: string[]): void {
    this.context.telemetry.reset();
    this.state.setState('CONNECTING');
    this.state.setManuallyDisconnected(false);
    this.state.setReconnecting(this.reconnectAttempt);
    this.bindAbortListener();
    this.transport.open({
      url,
      protocols,
      onOpen: (event) => {
        void this.handleOpen(event);
      },
      onClose: (event) => {
        this.handleClose(event);
      },
      onError: (event) => {
        this.handleError(event);
      },
      onMessage: (event) => {
        void this.handleMessage(event).catch((error) => {
          this.handleMessageFailure(error);
        });
      },
    });
  }

  private bindAbortListener(): void {
    if (!this.context.abortSignal) {
      return;
    }
    this.context.abortSignal.addEventListener('abort', this.handleAbort, { once: true });
  }

  private cleanupAbortListener(): void {
    this.context.abortSignal?.removeEventListener('abort', this.handleAbort);
  }

  private readonly handleAbort = () => {
    if (this.isTerminal()) {
      return;
    }
    this.state.setManuallyDisconnected(true);
    this.state.setState('DISCONNECTED');
    this.context.logger?.warn?.('gateway.connect.aborted');
    this.rejectHandshake(new GatewayClientError({
      code: 'GATEWAY_CONNECT_ABORTED',
      source: 'state_gate',
      phase: 'stopping',
      retryable: false,
      message: 'gateway_connection_aborted',
    }));
    this.enterTerminal();
    this.transport.close();
  };

  private async handleOpen(event?: unknown): Promise<void> {
    if (this.isTerminal()) {
      return;
    }

    this.opened = true;
    this.context.telemetry.logRawFrame('onOpen', event);
    this.context.logger?.info?.('gateway.open');
    this.state.setState('CONNECTED');

    try {
      this.outboundSender.sendInternalControl(this.context.options.registerMessage);
      this.context.logger?.info?.('gateway.register.sent', {
        toolType: this.context.options.registerMessage.toolType,
        toolVersion: this.context.options.registerMessage.toolVersion,
      });
      this.phase = 'register-sent';
      this.armHandshakeTimeout();
    } catch (error) {
      const clientError = this.toClientError(
        error,
        'GATEWAY_PROTOCOL_VIOLATION',
        'handshake',
        this.resolveErrorPhase(),
        false,
      );
      this.context.logger?.error?.('gateway.register.failed', {
        error: clientError.message,
        ...getErrorDetails(clientError),
      });
      this.failBeforeReady(clientError, { emitError: false, closeTransport: true });
    }
  }

  private armHandshakeTimeout(): void {
    const timeoutMs = this.context.options.handshakeTimeoutMs;
    if (!timeoutMs || timeoutMs <= 0) {
      return;
    }
    this.handshakeTimer = setTimeout(() => {
      this.failBeforeReady(new GatewayClientError({
        code: 'GATEWAY_CONNECT_TIMEOUT',
        source: 'handshake',
        phase: this.resolveErrorPhase(),
        retryable: true,
        message: 'gateway_handshake_timeout',
        details: { timeoutMs },
      }), { emitError: true, closeTransport: true });
    }, timeoutMs);
  }

  private clearHandshakeTimeout(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  private async handleMessage(event: { data: string | ArrayBuffer | Blob | Uint8Array }): Promise<void> {
    if (this.isTerminal()) {
      return;
    }
    const classification = await this.inboundFrameClassifier.classify(event);
    if (this.isTerminal()) {
      return;
    }
    if (classification.kind === 'nonparsed') {
      await this.inboundFrameRouter.route(classification);
      return;
    }

    this.context.sink.emitInbound(classification.frame);

    if (classification.kind === 'handshake-control' || classification.kind === 'invalid-handshake') {
      this.handleHandshakeResult(this.handshakeFrameProcessor.process(classification.frame));
      return;
    }

    await this.inboundFrameRouter.route(classification);
  }

  private handleMessageFailure(error: unknown): void {
    if (this.isTerminal()) {
      return;
    }
    const clientError = this.toClientError(
      error,
      'GATEWAY_PROTOCOL_VIOLATION',
      'inbound_protocol',
      this.resolveErrorPhase(),
      false,
    );
    this.context.sink.emitError(clientError);
  }

  private handleHandshakeResult(result: HandshakeResult): void {
    if (result.kind === 'ready') {
      if (this.phase === 'ready') {
        this.context.logger?.warn?.('gateway.register.duplicate_ok');
        return;
      }
      this.clearHandshakeTimeout();
      this.reconnectOrchestrator.reset();
      this.state.setReconnecting(false);
      this.context.logger?.info?.('gateway.register.accepted');
      this.phase = 'ready';
      this.state.setState('READY');
      this.context.logger?.info?.('gateway.ready');
      this.heartbeatLoop.start();
      this.resolveHandshake();
      return;
    }

    if (result.kind === 'rejected') {
      const error = this.withResolvedPhase(result.error);
      this.context.logger?.error?.('gateway.register.rejected', error.details);
      this.failBeforeReady(error, { emitError: true, closeTransport: true });
      return;
    }

    const error = this.withResolvedPhase(result.error);
    this.context.logger?.error?.('gateway.control.validation_failed', {
      ...error.details,
    });
    this.failBeforeReady(error, { emitError: true, closeTransport: true });
  }

  private handleError(event?: unknown): void {
    if (this.isTerminal()) {
      return;
    }
    this.context.telemetry.logRawFrame('onError', event);
    this.recordTerminalError(new GatewayClientError({
      code: 'GATEWAY_WEBSOCKET_ERROR',
      source: 'transport',
      phase: this.resolveErrorPhase(),
      retryable: true,
      message: 'gateway_websocket_error',
      details: extractWebSocketErrorDetails(event),
    }), true);
  }

  private handleClose(event?: unknown): void {
    if (this.isTerminal()) {
      return;
    }
    const close = event as GatewayCloseEventLike | undefined;
    const rejected = isGatewayRejectedCloseCode(close?.code);
    const reconnectPlanned =
      this.phase === 'ready'
      && shouldRetryOnClose({
        closeCode: close?.code,
        manuallyDisconnected: this.state.isManuallyDisconnected(),
        aborted: !!this.context.abortSignal?.aborted,
      })
      && this.context.reconnectEnabled;

    this.context.telemetry.logClose({
      opened: this.opened,
      manuallyDisconnected: this.state.isManuallyDisconnected(),
      aborted: !!this.context.abortSignal?.aborted,
      rejected,
      reconnectPlanned,
      code: close?.code,
      reason: close?.reason,
      wasClean: close?.wasClean,
    });

    this.state.setState('DISCONNECTED');

    if (!this.opened) {
      this.rejectHandshake(new GatewayClientError({
        code: 'GATEWAY_CLOSED_BEFORE_OPEN',
        source: 'transport',
        phase: this.resolveErrorPhase(),
        retryable: true,
        message: 'gateway_websocket_closed_before_open',
        details: {
          code: close?.code,
          reason: close?.reason,
        },
      }));
      this.enterTerminal();
      return;
    }

    if (this.phase !== 'ready') {
      const terminalError = this.terminalError ?? new GatewayClientError({
        code: 'GATEWAY_UNEXPECTED_CLOSE',
        source: rejected ? 'handshake' : 'transport',
        phase: this.resolveErrorPhase(),
        retryable: !rejected,
        message: 'gateway_unexpected_close_before_ready',
        details: {
          code: close?.code,
          reason: close?.reason,
          wasClean: close?.wasClean,
        },
      });
      this.rejectHandshake(terminalError);
      this.enterTerminal();
      if (rejected) {
        this.context.logger?.warn?.('gateway.close.rejected', {
          code: close?.code,
          reason: close?.reason,
          rejected: true,
        });
      }
      return;
    }

    this.enterTerminal();
    if (rejected) {
      this.context.logger?.warn?.('gateway.close.rejected', {
        code: close?.code,
        reason: close?.reason,
        rejected: true,
      });
      return;
    }
    if (reconnectPlanned) {
      this.reconnectOrchestrator.scheduleReconnect();
    }
  }

  private failBeforeReady(
    error: GatewayClientError,
    options: { emitError: boolean; closeTransport: boolean },
  ): void {
    this.recordTerminalError(error, options.emitError);
    this.state.setState('DISCONNECTED');
    this.rejectHandshake(error);
    this.enterTerminal();
    if (options.closeTransport) {
      this.transport.close();
    }
  }

  private resolveHandshake(): void {
    if (this.connectSettled) {
      return;
    }
    this.connectSettled = true;
    this.cleanupAbortListener();
    this.releaseHandshakeOwnership();
    this.resolveConnect();
  }

  private rejectHandshake(error: GatewayClientError): void {
    if (this.connectSettled) {
      return;
    }
    this.connectSettled = true;
    this.cleanupAbortListener();
    this.releaseHandshakeOwnership();
    this.rejectConnect(error);
  }

  private enterTerminal(): void {
    if (this.terminalCleanupCompleted) {
      return;
    }
    const wasReady = this.phase === 'ready';
    this.phase = 'terminal';
    this.terminalCleanupCompleted = true;
    this.clearHandshakeTimeout();
    this.cleanupAbortListener();
    this.heartbeatLoop.stop();
    this.reconnectOrchestrator.stop();
    if (this.reconnectAttempt && !wasReady) {
      this.state.setReconnecting(false);
    }
    this.releaseHandshakeOwnership();
    this.onTerminal();
  }

  private withResolvedPhase(error: GatewayClientError): GatewayClientError {
    const phase = this.resolveErrorPhase();
    if (error.phase === phase) {
      return error;
    }
    return new GatewayClientError({
      code: error.code,
      source: error.source,
      phase,
      retryable: error.retryable,
      message: error.message,
      details: error.details,
      cause: error.cause,
    });
  }

  private recordTerminalError(error: GatewayClientError, emitError: boolean): GatewayClientError {
    if (!this.terminalError) {
      this.terminalError = error;
      this.context.logger?.error?.('gateway.error', {
        error: error.message,
        ...error.details,
      });
      if (emitError) {
        this.context.sink.emitError(error);
      }
      return error;
    }
    return this.terminalError;
  }

  private toClientError(
    error: unknown,
    fallbackCode: GatewayClientError['code'],
    fallbackSource: GatewayClientErrorSource,
    fallbackPhase: GatewayClientErrorPhase,
    fallbackRetryable: boolean,
  ): GatewayClientError {
    if (error instanceof GatewayClientError) {
      return error;
    }
    if (error instanceof Error) {
      return new GatewayClientError({
        code: fallbackCode,
        source: fallbackSource,
        phase: fallbackPhase,
        retryable: fallbackRetryable,
        message: error.message,
        cause: error,
      });
    }
    return new GatewayClientError({
      code: fallbackCode,
      source: fallbackSource,
      phase: fallbackPhase,
      retryable: fallbackRetryable,
      message: String(error),
      cause: error,
    });
  }
}

/**
 * 单次连接会话编排器。
 * @remarks 负责 active connect attempt 管理；具体时序细节下沉到 attempt。
 */
export class ConnectSession {
  private readonly transport: GatewayTransport;
  private readonly outboundSender: OutboundSender;
  private readonly inboundFrameClassifier: InboundFrameClassifier;
  private readonly handshakeFrameProcessor: HandshakeFrameProcessor;
  private readonly inboundFrameRouter: InboundFrameRouter;
  private readonly reconnectOrchestrator: ReconnectOrchestrator;
  private readonly heartbeatLoop: HeartbeatLoop;
  private readonly context: GatewayRuntimeContext;
  private readonly state: GatewayRuntimeStatePort;
  private activeAttempt: ConnectAttempt | null = null;

  constructor(
    transport: GatewayTransport,
    outboundSender: OutboundSender,
    inboundFrameClassifier: InboundFrameClassifier,
    handshakeFrameProcessor: HandshakeFrameProcessor,
    inboundFrameRouter: InboundFrameRouter,
    reconnectOrchestrator: ReconnectOrchestrator,
    heartbeatLoop: HeartbeatLoop,
    context: GatewayRuntimeContext,
    state: GatewayRuntimeStatePort,
  ) {
    this.transport = transport;
    this.outboundSender = outboundSender;
    this.inboundFrameClassifier = inboundFrameClassifier;
    this.handshakeFrameProcessor = handshakeFrameProcessor;
    this.inboundFrameRouter = inboundFrameRouter;
    this.reconnectOrchestrator = reconnectOrchestrator;
    this.heartbeatLoop = heartbeatLoop;
    this.context = context;
    this.state = state;
  }

  connect(options: { reconnectAttempt: boolean } = { reconnectAttempt: false }): Promise<void> {
    this.context.logger?.info?.('gateway.connect.started', {
      url: this.context.options.url,
      state: this.state.getState(),
    });

    if (this.context.abortSignal?.aborted) {
      this.state.setManuallyDisconnected(true);
      this.state.setState('DISCONNECTED');
      this.context.logger?.warn?.('gateway.connect.aborted_precheck');
      return Promise.reject(new GatewayClientError({
        code: 'GATEWAY_CONNECT_ABORTED',
        source: 'state_gate',
        phase: 'stopping',
        retryable: false,
        message: 'gateway_connection_aborted',
      }));
    }

    if (this.state.getState() === 'READY') {
      return Promise.resolve();
    }

    if (this.activeAttempt) {
      return this.activeAttempt.promise;
    }

    try {
      // 对外 connect() 的 fulfilled 语义是握手完成并进入 READY，不是单纯 transport open。
      const parsedUrl = new URL(this.context.options.url).toString();

      const attempt = new ConnectAttempt(
        this.transport,
        this.outboundSender,
        this.inboundFrameClassifier,
        this.handshakeFrameProcessor,
        this.inboundFrameRouter,
        this.reconnectOrchestrator,
        this.heartbeatLoop,
        this.context,
        this.state,
        () => {
          if (this.activeAttempt === attempt) {
            this.activeAttempt = null;
          }
        },
        () => {},
        options.reconnectAttempt,
      );
      const authPayload = this.context.options.authPayloadProvider?.();
      const protocols = authPayload ? [this.context.authSubprotocolBuilder(authPayload)] : undefined;
      attempt.start(parsedUrl, protocols);
      this.activeAttempt = attempt;
      return attempt.promise;
    } catch (error) {
      if (error instanceof TypeError && error.message.includes('Invalid URL')) {
        return Promise.reject(
          this.toClientError(
            error,
            'GATEWAY_WEBSOCKET_ERROR',
            'transport',
            options.reconnectAttempt ? 'reconnecting' : 'before_open',
            true,
          ),
        );
      }
      return Promise.reject(
        this.toClientError(
          error,
          'GATEWAY_WEBSOCKET_ERROR',
          'handshake',
          options.reconnectAttempt ? 'reconnecting' : 'before_open',
          false,
        ),
      );
    }
  }

  private toClientError(
    error: unknown,
    fallbackCode: GatewayClientError['code'],
    fallbackSource: GatewayClientErrorSource,
    fallbackPhase: GatewayClientErrorPhase,
    fallbackRetryable: boolean,
  ): GatewayClientError {
    if (error instanceof GatewayClientError) {
      return error;
    }
    if (error instanceof Error) {
      return new GatewayClientError({
        code: fallbackCode,
        source: fallbackSource,
        phase: fallbackPhase,
        retryable: fallbackRetryable,
        message: error.message,
        cause: error,
      });
    }
    return new GatewayClientError({
      code: fallbackCode,
      source: fallbackSource,
      phase: fallbackPhase,
      retryable: fallbackRetryable,
      message: String(error),
      cause: error,
    });
  }
}
