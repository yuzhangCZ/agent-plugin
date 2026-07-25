import type {
  BridgeGatewayHostConfig,
  BridgeGatewayProbeResult,
  BridgeRuntime,
  BridgeRuntimeOptions,
  BridgeRuntimeStatusSnapshot,
  RuntimeDiagnostics,
  ThirdPartyAgentProvider,
} from '@wecode/bridge-runtime-sdk';
import { createBridgeRuntime } from '@wecode/bridge-runtime-sdk';
import type { GatewayMode, RuntimeSnapshot, SafeGatewayConfig } from '@agent-plugin/bridge-runtime-sdk-lab-shared';

import { toSafeGatewayConfig } from './config-loader.ts';
import { buildGatewayDownstreamViews } from './downstream-view.ts';
import { EventStore } from './event-store.ts';
import { sanitizeForDisplay } from './sanitize.ts';
import { TestProvider } from './test-provider.ts';

type RuntimeFactory = (options: BridgeRuntimeOptions) => Promise<BridgeRuntime>;

export interface RuntimeManagerOptions {
  createRuntime?: RuntimeFactory;
  provider?: ThirdPartyAgentProvider;
  events?: EventStore;
}

export interface RuntimeCreateResult {
  gateway: SafeGatewayConfig;
  status: BridgeRuntimeStatusSnapshot;
}

export class RuntimeManager {
  readonly #createRuntime: RuntimeFactory;
  readonly #provider: ThirdPartyAgentProvider;
  readonly #events: EventStore;
  #runtime: BridgeRuntime | undefined;
  #gateway: SafeGatewayConfig | undefined;
  #mode: GatewayMode = 'real-gateway';

  constructor(options: RuntimeManagerOptions = {}) {
    this.#events = options.events ?? new EventStore();
    this.#provider = options.provider ?? new TestProvider(this.#events);
    this.#createRuntime = options.createRuntime ?? createBridgeRuntime;
  }

  get provider(): ThirdPartyAgentProvider {
    return this.#provider;
  }

  get events(): EventStore {
    return this.#events;
  }

  setMode(mode: GatewayMode): RuntimeSnapshot {
    this.#mode = mode;
    this.#events.append('runtime.mode.changed', `Gateway mode changed to ${mode}`, { mode });
    return this.snapshot();
  }

  async create(config: BridgeGatewayHostConfig): Promise<RuntimeCreateResult> {
    if (this.#runtime) {
      await this.#runtime.stop();
      this.#events.append('runtime.replaced', 'Previous runtime stopped before replacement');
    }

    const runtime = await this.#createRuntime({
      provider: this.#provider,
      gatewayHost: config,
      debug: true,
      onTelemetryUpdated: () => {
        this.#events.append('runtime.telemetry.updated', 'Runtime telemetry updated');
      },
      logger: createLabLogger(this.#events),
    });

    this.#runtime = runtime;
    this.#gateway = toSafeGatewayConfig(config);
    this.#events.append('runtime.created', 'Bridge runtime created', { gateway: this.#gateway });
    return {
      gateway: this.#gateway,
      status: runtime.getStatus(),
    };
  }

  async start(): Promise<BridgeRuntimeStatusSnapshot> {
    const runtime = this.#requireRuntime();
    await runtime.start();
    const status = runtime.getStatus();
    this.#events.append('runtime.started', 'Bridge runtime started', { status });
    return status;
  }

  async stop(): Promise<BridgeRuntimeStatusSnapshot | undefined> {
    if (!this.#runtime) {
      return undefined;
    }
    await this.#runtime.stop();
    const status = this.#runtime.getStatus();
    this.#events.append('runtime.stopped', 'Bridge runtime stopped', { status });
    return status;
  }

  async probe(timeoutMs = 3000): Promise<BridgeGatewayProbeResult> {
    const result = await this.#requireRuntime().probe({ timeoutMs });
    this.#events.append('runtime.probed', 'Gateway probe completed', { result });
    return result;
  }

  getStatus(): BridgeRuntimeStatusSnapshot | undefined {
    return this.#runtime?.getStatus();
  }

  getDiagnostics(): RuntimeDiagnostics | undefined {
    const diagnostics = this.#runtime?.getDiagnostics();
    return sanitizeForDisplay(diagnostics) as RuntimeDiagnostics | undefined;
  }

  snapshot(): RuntimeSnapshot {
    const events = this.#events.list();
    return {
      mode: this.#mode,
      gateway: this.#gateway,
      status: this.getStatus(),
      diagnostics: this.getDiagnostics(),
      downstreams: buildGatewayDownstreamViews(events, this.#mode),
      events,
    };
  }

  #requireRuntime(): BridgeRuntime {
    if (!this.#runtime) {
      throw new Error('Runtime has not been created');
    }
    return this.#runtime;
  }
}

type LabLogger = NonNullable<BridgeRuntimeOptions['logger']>;

function createLabLogger(events: EventStore): LabLogger {
  return {
    debug: (message, meta) => events.append('sdk.log.debug', message, meta),
    info: (message, meta) => events.append('sdk.log.info', message, meta),
    warn: (message, meta) => events.append('sdk.log.warn', message, meta),
    error: (message, meta) => events.append('sdk.log.error', message, meta),
    child: () => createLabLogger(events),
    getTraceId: () => `lab_${crypto.randomUUID()}`,
  };
}
