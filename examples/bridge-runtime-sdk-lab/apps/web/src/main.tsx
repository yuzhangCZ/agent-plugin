import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  Bug,
  Cable,
  CircleStop,
  FileJson,
  Gauge,
  KeyRound,
  Pause,
  Play,
  Radar,
  RefreshCw,
  Send,
  ShieldCheck,
  TerminalSquare,
  Zap,
} from 'lucide-react';
import type {
  DownstreamRunResult,
  DownstreamScenario,
  GatewayMode,
  LabGatewayDownstreamView,
  LabEvent,
  ProviderScenarioConfig,
  RuntimeActionResult,
  RuntimeSnapshot,
} from '@agent-plugin/bridge-runtime-sdk-lab-shared';

import './styles.css';

const API_BASE = '';

const runtimeButtons = [
  { id: 'create', label: '初始化', icon: Cable },
  { id: 'start', label: '启动', icon: Play },
  { id: 'stop', label: '停止', icon: CircleStop },
  { id: 'probe', label: '探测', icon: Radar },
  { id: 'status', label: '状态', icon: Gauge },
  { id: 'diagnostics', label: '诊断', icon: FileJson },
] as const;

const commands = [
  'initialize',
  'health',
  'createSession',
  'listSlashCommands',
  'runMessage',
  'replyQuestion',
  'replyPermission',
  'closeSession',
  'abortSession',
  'dispose',
  'outbound',
];

const scenarioKindsByCommand: Record<string, ProviderScenarioConfig['kind'][]> = {
  initialize: ['success', 'throw', 'timeout'],
  health: ['success', 'offline', 'throw', 'timeout'],
  createSession: ['success', 'throw', 'timeout'],
  listSlashCommands: ['success', 'throw', 'timeout'],
  runMessage: [
    'success',
    'throw',
    'timeout',
    'invalid_fact',
    'failed_run',
    'session_not_found',
    'result_reject',
    'facts_throw',
    'enrich_failure',
    'aborted_run',
  ],
  replyQuestion: ['success', 'throw', 'timeout'],
  replyPermission: ['success', 'throw', 'timeout'],
  closeSession: ['success', 'throw', 'timeout'],
  abortSession: ['success', 'throw', 'timeout'],
  dispose: ['success', 'throw', 'timeout'],
  outbound: ['success', 'invalid_fact', 'facts_throw', 'enrich_failure'],
};

function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot>({ mode: 'real-gateway', events: [] });
  const [lastResult, setLastResult] = useState<RuntimeActionResult | undefined>();
  const [downstreamResult, setDownstreamResult] = useState<DownstreamRunResult | undefined>();
  const [downstreamScenarios, setDownstreamScenarios] = useState<DownstreamScenario[]>([]);
  const [selectedDownstreamId, setSelectedDownstreamId] = useState('invalid-chat-missing-text');
  const [busyAction, setBusyAction] = useState<string | undefined>();
  const [mode, setMode] = useState<GatewayMode>('real-gateway');
  const [config, setConfig] = useState({
    url: '',
    channel: '',
    toolVersion: 'sdk-lab',
    pluginVersion: 'sdk-lab',
  });
  const [scenario, setScenario] = useState<ProviderScenarioConfig>({
    command: 'runMessage',
    kind: 'success',
    delayMs: 0,
  });
  const [qrInput, setQrInput] = useState({
    channel: 'opencode',
    mac: 'sdk-lab-device',
    environment: 'prod',
  });

  const refresh = useCallback(async () => {
    const next = await api<RuntimeSnapshot>('/api/snapshot');
    setSnapshot(next);
    setMode(next.mode);
    if (next.gateway) {
      setConfig((current) => ({
        url: next.gateway?.url ?? current.url,
        channel: next.gateway?.register.channel ?? current.channel,
        toolVersion: next.gateway?.register.toolVersion ?? current.toolVersion,
        pluginVersion: next.gateway?.register.pluginVersion ?? current.pluginVersion,
      }));
    }
    const scenarios = await api<DownstreamScenario[]>('/api/downstream/scenarios');
    setDownstreamScenarios(scenarios);
    if (scenarios.length > 0 && !scenarios.some((item) => item.id === selectedDownstreamId)) {
      setSelectedDownstreamId(scenarios[0]?.id ?? '');
    }
  }, [selectedDownstreamId]);

  useEffect(() => {
    void refresh();
    const events = new EventSource('/api/events');
    events.onmessage = (message) => {
      const event = JSON.parse(message.data) as LabEvent;
      setSnapshot((current) => ({
        ...current,
        events: [event, ...current.events].slice(0, 300),
      }));
    };
    return () => {
      events.close();
    };
  }, [refresh]);

  const statusState = readStatusState(snapshot.status);
  const eventGroups = useMemo(() => groupEvents(snapshot.events), [snapshot.events]);
  const selectedDownstream = downstreamScenarios.find((item) => item.id === selectedDownstreamId);
  const groupedDownstream = useMemo(() => groupScenarios(downstreamScenarios), [downstreamScenarios]);
  const availableScenarioKinds = scenarioKindsByCommand[scenario.command] ?? ['success'];

  const runRuntimeAction = useCallback(async (action: (typeof runtimeButtons)[number]['id']) => {
    setBusyAction(action);
    try {
      const result = await callRuntimeAction(action, config, mode);
      setLastResult(result);
      await refresh();
    } finally {
      setBusyAction(undefined);
    }
  }, [config, mode, refresh]);

  const updateMode = useCallback(async (nextMode: GatewayMode) => {
    setMode(nextMode);
    setLastResult(await api<RuntimeActionResult>('/api/mode', {
      method: 'POST',
      body: JSON.stringify({ mode: nextMode }),
    }));
    await refresh();
  }, [refresh]);

  const applyScenario = useCallback(async () => {
    setBusyAction('scenario');
    try {
      setLastResult(await api<RuntimeActionResult>('/api/provider/scenario', {
        method: 'POST',
        body: JSON.stringify(scenario),
      }));
      await refresh();
    } finally {
      setBusyAction(undefined);
    }
  }, [refresh, scenario]);

  const triggerOutbound = useCallback(async () => {
    setBusyAction('outbound');
    try {
      setLastResult(await api<RuntimeActionResult>('/api/outbound/run', {
        method: 'POST',
        body: JSON.stringify({}),
      }));
      await refresh();
    } finally {
      setBusyAction(undefined);
    }
  }, [refresh]);

  const runQrAuth = useCallback(async () => {
    setBusyAction('qrcode');
    try {
      setLastResult(await api<RuntimeActionResult>('/api/qrcode/run', {
        method: 'POST',
        body: JSON.stringify(qrInput),
      }));
      await refresh();
    } finally {
      setBusyAction(undefined);
    }
  }, [qrInput, refresh]);

  const runDownstreamScenario = useCallback(async () => {
    setBusyAction('downstream');
    try {
      const result = await api<RuntimeActionResult<DownstreamRunResult>>('/api/downstream/run', {
        method: 'POST',
        body: JSON.stringify({ scenarioId: selectedDownstreamId }),
      });
      setLastResult(result);
      if (result.payload) {
        setDownstreamResult(result.payload);
      }
      await refresh();
    } finally {
      setBusyAction(undefined);
    }
  }, [refresh, selectedDownstreamId]);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Zap size={18} />
          </div>
          <div>
            <h1>Bridge SDK Lab</h1>
            <p>Runtime acceptance console</p>
          </div>
        </div>

        <section className="panel">
          <div className="section-title">
            <ShieldCheck size={16} />
            <span>Gateway 配置</span>
          </div>
          <label>
            <span>配置来源</span>
            <input value=".opencode/message-bridge.jsonc" readOnly />
          </label>
          <label>
            <span>Gateway URL</span>
            <input value={config.url} onChange={(event) => setConfig({ ...config, url: event.target.value })} placeholder="ws://localhost:8081/ws/agent" />
          </label>
          <label>
            <span>Channel</span>
            <input value={config.channel} onChange={(event) => setConfig({ ...config, channel: event.target.value })} placeholder="opencode" />
          </label>
          <div className="two-col">
            <label>
              <span>Tool</span>
              <input value={config.toolVersion} onChange={(event) => setConfig({ ...config, toolVersion: event.target.value })} />
            </label>
            <label>
              <span>Plugin</span>
              <input value={config.pluginVersion} onChange={(event) => setConfig({ ...config, pluginVersion: event.target.value })} />
            </label>
          </div>
          <div className="auth-row">
            <KeyRound size={15} />
            <span>Auth</span>
            <strong>{snapshot.gateway?.authLoaded ? '已加载' : '未加载'}</strong>
          </div>
        </section>

        <section className="panel">
          <div className="section-title">
            <Activity size={16} />
            <span>模式</span>
          </div>
          <div className="segmented">
            <button className={mode === 'real-gateway' ? 'selected' : ''} onClick={() => void updateMode('real-gateway')}>真实</button>
            <button className={mode === 'mock-gateway' ? 'selected' : ''} onClick={() => void updateMode('mock-gateway')}>Mock</button>
          </div>
        </section>

        <section className="panel">
          <div className="section-title">
            <Radar size={16} />
            <span>Gateway Downstream</span>
          </div>
          <GatewayDownstreamSummary downstreams={snapshot.downstreams ?? []} compact />
        </section>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <h2>SDK Runtime 验收工作台</h2>
            <p>前端触发生命周期操作，真实 gateway 下行触发 Provider SPI。</p>
          </div>
          <button className="icon-button" onClick={() => void refresh()} title="刷新快照">
            <RefreshCw size={17} />
          </button>
        </header>

        <section className="control-band">
          {runtimeButtons.map((button) => {
            const Icon = button.icon;
            return (
              <button key={button.id} className="action-button" onClick={() => void runRuntimeAction(button.id)} disabled={busyAction === button.id}>
                <Icon size={17} />
                <span>{button.label}</span>
              </button>
            );
          })}
        </section>

        <section className="grid">
          <div className="panel large">
            <div className="section-title">
              <Bug size={16} />
              <span>Provider 场景</span>
            </div>
            <div className="scenario-form">
              <label>
                <span>Command</span>
                <select
                  value={scenario.command}
                  onChange={(event) => setScenario(normalizeScenarioForCommand({
                    ...scenario,
                    command: event.target.value,
                  }))}
                >
                  {commands.map((command) => (
                    <option key={command} value={command}>{command}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Kind</span>
                <select value={scenario.kind} onChange={(event) => setScenario({ ...scenario, kind: event.target.value as ProviderScenarioConfig['kind'] })}>
                  {availableScenarioKinds.map((kind) => (
                    <option key={kind} value={kind}>{kind}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Delay ms</span>
                <input type="number" value={scenario.delayMs ?? 0} onChange={(event) => setScenario({ ...scenario, delayMs: Number(event.target.value) })} />
              </label>
              <button className="primary" onClick={() => void applyScenario()} disabled={busyAction === 'scenario'}>
                <TerminalSquare size={16} />
                <span>应用场景</span>
              </button>
            </div>
            <div className="command-strip">
              {commands.map((command) => (
                <button
                  key={command}
                  className={scenario.command === command ? 'selected' : ''}
                  onClick={() => setScenario(normalizeScenarioForCommand({ ...scenario, command }))}
                >
                  {command}
                </button>
              ))}
            </div>
            <p className="muted">Kind 会随 Command 过滤，只展示该 Provider API 可触发的行为。</p>
          </div>

          <div className="panel">
            <div className="section-title">
              <Send size={16} />
              <span>Outbound</span>
            </div>
            <p className="muted">使用 Provider 保存的 RuntimeOutboundEmitter 触发主动 facts 流。</p>
            <button className="primary wide" onClick={() => void triggerOutbound()} disabled={busyAction === 'outbound'}>
              <Send size={16} />
              <span>emitOutboundRun</span>
            </button>
          </div>

          <div className="panel">
            <div className="section-title">
              <Pause size={16} />
              <span>二维码授权</span>
            </div>
            <label>
              <span>Channel</span>
              <input value={qrInput.channel} onChange={(event) => setQrInput({ ...qrInput, channel: event.target.value })} />
            </label>
            <label>
              <span>MAC</span>
              <input value={qrInput.mac} onChange={(event) => setQrInput({ ...qrInput, mac: event.target.value })} />
            </label>
            <button className="secondary wide" onClick={() => void runQrAuth()} disabled={busyAction === 'qrcode'}>
              qrcodeAuth.run
            </button>
          </div>
        </section>

        <section className="panel downstream-lab">
          <div className="section-title">
            <Bug size={16} />
            <span>Stage Matrix Lab</span>
          </div>
          <div className="downstream-layout">
            <div className="scenario-list">
              {Object.entries(groupedDownstream).map(([group, scenarios]) => (
                <div key={group} className="scenario-group">
                  <h3>{group}</h3>
                  {scenarios.map((item) => (
                    <button
                      key={item.id}
                      className={selectedDownstreamId === item.id ? 'selected' : ''}
                      onClick={() => setSelectedDownstreamId(item.id)}
                    >
                      <span>{item.title}</span>
                      <small>{item.expected.outcome}</small>
                    </button>
                  ))}
                </div>
              ))}
            </div>
            <div className="payload-preview">
              <div className="expectation">
                <strong>{selectedDownstream?.title ?? '未选择场景'}</strong>
                <span>{selectedDownstream?.description}</span>
                <code>{selectedDownstream?.expected.stage} / {selectedDownstream?.expected.outcome}</code>
              </div>
              <pre>{JSON.stringify(selectedDownstream?.raw ?? {}, null, 2)}</pre>
              <button className="primary wide" onClick={() => void runDownstreamScenario()} disabled={busyAction === 'downstream' || mode !== 'mock-gateway'}>
                运行矩阵场景
              </button>
              {mode !== 'mock-gateway' ? <p className="muted">切换到 Mock 模式，初始化并启动 runtime 后运行矩阵场景。</p> : null}
            </div>
            <div className="tool-error-panel">
              <div className="section-title">
                <Send size={16} />
                <span>Gateway Uplink</span>
              </div>
              <GatewayUplinkSummary result={downstreamResult} />
            </div>
            <div className="tool-error-panel">
              <div className="section-title">
                <ShieldCheck size={16} />
                <span>Tool Error</span>
              </div>
              <ToolErrorSummary result={downstreamResult} />
            </div>
          </div>
        </section>

        <section className="panel json-panel">
          <div className="section-title">
            <FileJson size={16} />
            <span>最近结果</span>
          </div>
          <pre>{JSON.stringify(lastResult ?? snapshot, null, 2)}</pre>
        </section>
      </section>

      <aside className="inspector">
        <section className="status-card">
          <span className={`status-dot ${statusState}`}></span>
          <div>
            <p>Runtime 状态</p>
            <strong>{statusState}</strong>
          </div>
        </section>

        <section className="panel">
          <div className="section-title">
            <Gauge size={16} />
            <span>事件摘要</span>
          </div>
          <div className="metric-row">
            <span>Events</span>
            <strong>{snapshot.events.length}</strong>
          </div>
          <div className="metric-row">
            <span>Provider</span>
            <strong>{eventGroups.provider}</strong>
          </div>
          <div className="metric-row">
            <span>Failures</span>
            <strong>{eventGroups.failures}</strong>
          </div>
        </section>

        <section className="panel event-stream">
          <div className="section-title">
            <TerminalSquare size={16} />
            <span>事件流</span>
          </div>
          {snapshot.events.slice(0, 80).map((event) => (
            <article key={event.id} className="event-row">
              <time>{new Date(event.at).toLocaleTimeString()}</time>
              <strong>{event.type}</strong>
              <p>{event.message}</p>
            </article>
          ))}
        </section>
      </aside>
    </main>
  );
}

function GatewayDownstreamSummary({
  downstreams,
  compact = false,
}: {
  downstreams: LabGatewayDownstreamView[];
  compact?: boolean;
}): React.JSX.Element {
  if (downstreams.length === 0) {
    return <p className="muted">真实或 Mock gateway 下行到达 SDK 后，这里会展示最近的下行摘要。</p>;
  }

  return (
    <div className={compact ? 'downstream-list compact' : 'uplink-list'}>
      {downstreams.slice(0, compact ? 12 : 20).map((downstream) => (
        <article key={downstream.id} className="uplink-card">
          <div>
            <strong>{readDownstreamTitle(downstream)}</strong>
            <span>{readDownstreamRouteSummary(downstream)}</span>
          </div>
          <div className="downstream-meta">
            <span>{downstream.source}</span>
            <span>{downstream.phase}</span>
            <time>{new Date(downstream.at).toLocaleTimeString()}</time>
          </div>
          {compact ? null : <pre>{JSON.stringify(toDownstreamDisplay(downstream), null, 2)}</pre>}
        </article>
      ))}
    </div>
  );
}

function GatewayUplinkSummary({ result }: { result: DownstreamRunResult | undefined }): React.JSX.Element {
  if (!result) {
    return <p className="muted">运行矩阵场景后，这里会展示 SDK 发往 gateway 的全部上行消息。</p>;
  }

  if (result.uplinks.length === 0) {
    return (
      <div className={result.matchedExpectation ? 'result-ok' : 'result-miss'}>
        <strong>{result.matchedExpectation ? '无上行消息，符合预期' : '未捕获到上行消息'}</strong>
        <p>{result.note}</p>
      </div>
    );
  }

  return (
    <div className="uplink-list">
      {result.uplinks.map((uplink, index) => (
        <article key={index} className="uplink-card">
          <div>
            <strong>{readMessageType(uplink)}</strong>
            <span>{readRouteSummary(uplink)}</span>
          </div>
          <pre>{JSON.stringify(uplink, null, 2)}</pre>
        </article>
      ))}
    </div>
  );
}

function ToolErrorSummary({ result }: { result: DownstreamRunResult | undefined }): React.JSX.Element {
  if (!result) {
    return <p className="muted">运行矩阵场景后，这里会展示 SDK 上行的 tool_error。</p>;
  }

  if (result.toolErrors.length === 0) {
    return (
      <div className={result.matchedExpectation ? 'result-ok' : 'result-miss'}>
        <strong>{result.matchedExpectation ? '无 tool_error，符合预期' : '未捕获到 tool_error'}</strong>
        <p>{result.note}</p>
        <pre>{JSON.stringify({ uplinks: result.uplinks, failures: result.failures }, null, 2)}</pre>
      </div>
    );
  }

  return (
    <div className={result.matchedExpectation ? 'result-ok' : 'result-miss'}>
      <strong>{result.matchedExpectation ? '捕获到预期 tool_error' : 'tool_error 与预期不匹配'}</strong>
      {result.toolErrors.map((toolError, index) => (
        <article key={`${toolError.error}-${index}`} className="tool-error-card">
          <b>{toolError.error}</b>
          <span>stage: {toolError.stage}</span>
          <span>toolSessionId: {toolError.toolSessionId ?? '-'}</span>
          <span>welinkSessionId: {toolError.welinkSessionId ?? '-'}</span>
          {toolError.reason ? <span>reason: {toolError.reason}</span> : null}
        </article>
      ))}
      <pre>{JSON.stringify({ uplinks: result.uplinks, failures: result.failures }, null, 2)}</pre>
    </div>
  );
}

function readMessageType(value: unknown): string {
  if (!value || typeof value !== 'object' || !('type' in value)) {
    return 'unknown';
  }
  const messageType = value.type;
  return typeof messageType === 'string' ? messageType : 'unknown';
}

function readDownstreamTitle(downstream: LabGatewayDownstreamView): string {
  const action = downstream.action ?? downstream.command;
  return [downstream.messageType ?? 'downstream', action].filter(Boolean).join(' / ');
}

function readDownstreamRouteSummary(downstream: LabGatewayDownstreamView): string {
  const route = [
    downstream.toolSessionId ? `tool=${downstream.toolSessionId}` : undefined,
    downstream.welinkSessionId ? `welink=${downstream.welinkSessionId}` : undefined,
    downstream.traceId ? `trace=${downstream.traceId}` : undefined,
  ].filter(Boolean);
  return route.length > 0 ? route.join(' / ') : 'route: -';
}

function toDownstreamDisplay(downstream: LabGatewayDownstreamView): Record<string, unknown> {
  return {
    source: downstream.source,
    phase: downstream.phase,
    messageType: downstream.messageType,
    action: downstream.action,
    command: downstream.command,
    toolSessionId: downstream.toolSessionId,
    welinkSessionId: downstream.welinkSessionId,
    traceId: downstream.traceId,
    error: downstream.error,
    code: downstream.code,
    raw: downstream.raw,
  };
}

function readRouteSummary(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return 'route: -';
  }
  const record = value as Record<string, unknown>;
  const route = [
    typeof record.toolSessionId === 'string' ? `tool=${record.toolSessionId}` : undefined,
    typeof record.welinkSessionId === 'string' ? `welink=${record.welinkSessionId}` : undefined,
    typeof record.traceId === 'string' ? `trace=${record.traceId}` : undefined,
  ].filter(Boolean);
  return route.length > 0 ? route.join(' / ') : 'route: -';
}

async function callRuntimeAction(
  action: (typeof runtimeButtons)[number]['id'],
  config: Record<string, string>,
  mode: GatewayMode,
): Promise<RuntimeActionResult> {
  if (action === 'create') {
    const body = mode === 'real-gateway'
      ? {
          toolVersion: config.toolVersion,
          pluginVersion: config.pluginVersion,
        }
      : config;
    return api('/api/runtime/create', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }
  if (action === 'probe') {
    return api('/api/runtime/probe', {
      method: 'POST',
      body: JSON.stringify({ timeoutMs: 3000 }),
    });
  }
  if (action === 'status') {
    return api('/api/runtime/status');
  }
  if (action === 'diagnostics') {
    return api('/api/runtime/diagnostics');
  }
  return api(`/api/runtime/${action}`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
    ...init,
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function readStatusState(status: unknown): string {
  if (!status || typeof status !== 'object' || !('state' in status)) {
    return 'idle';
  }
  const state = status.state;
  return typeof state === 'string' ? state : 'idle';
}

function groupEvents(events: LabEvent[]): { provider: number; failures: number } {
  return events.reduce((groups, event) => {
    if (event.type.startsWith('provider.')) {
      groups.provider += 1;
    }
    if (event.type.includes('error') || event.type.includes('failure')) {
      groups.failures += 1;
    }
    return groups;
  }, { provider: 0, failures: 0 });
}

function groupScenarios(scenarios: DownstreamScenario[]): Record<string, DownstreamScenario[]> {
  return scenarios.reduce<Record<string, DownstreamScenario[]>>((groups, item) => {
    groups[item.group] ??= [];
    groups[item.group].push(item);
    return groups;
  }, {});
}

function normalizeScenarioForCommand(scenario: ProviderScenarioConfig): ProviderScenarioConfig {
  const kinds = scenarioKindsByCommand[scenario.command] ?? ['success'];
  if (kinds.includes(scenario.kind)) {
    return scenario;
  }
  return {
    ...scenario,
    kind: kinds[0] ?? 'success',
  };
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
