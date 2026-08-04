import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import type { GatewayMode, ProviderScenarioConfig, RuntimeActionResult } from '@agent-plugin/bridge-runtime-sdk-lab-shared';
import { qrcodeAuth } from '@wecode/bridge-runtime-sdk';

import { loadGatewayConfig, type GatewayConfigOverrides } from './config-loader.ts';
import { getDownstreamScenarios } from './downstream-scenarios.ts';
import { DownstreamScenarioRunner } from './downstream-runner.ts';
import { EventStore } from './event-store.ts';
import { LabMockGateway } from './mock-gateway.ts';
import { ManualAgentController } from './manual-agent-controller.ts';
import { RuntimeManager } from './runtime-manager.ts';
import { asRecord, sanitizeForDisplay } from './sanitize.ts';
import { TestProvider } from './test-provider.ts';

const currentDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(currentDir, '../../../../..');
const port = Number(process.env.PORT ?? 4321);
const events = new EventStore();
const manualAgent = new ManualAgentController(events);
const provider = new TestProvider(events, manualAgent);
const manager = new RuntimeManager({ events, provider, getManualAgentSnapshot: () => manualAgent.snapshot() });
const mockGateway = new LabMockGateway(events);
const downstreamRunner = new DownstreamScenarioRunner({
  gateway: mockGateway,
  provider,
  events,
  getFailures: () => manager.getDiagnostics()?.failures ?? [],
});
let currentMode: GatewayMode = 'real-gateway';

const server = createServer(async (req, res) => {
  await route(req, res).catch((error: unknown) => {
    sendJson(res, 500, actionResult('server.error', undefined, error));
  });
});

server.listen(port, () => {
  manager.events.append('server.started', `Runtime host listening on ${port}`, { port });
  console.log(`Bridge Runtime SDK lab host listening on http://localhost:${port}`);
});

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/api/snapshot') {
    sendJson(res, 200, manager.snapshot());
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/events') {
    streamEvents(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/downstreams/clear') {
    sendJson(res, 200, actionResult('downstreams.clear', manager.clearGatewayDownstreams()));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/manual-agent/templates') {
    sendRawJson(res, 200, manualAgent.templates());
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/manual-agent/mode') {
    const body = asRecord(await readJson(req));
    sendJson(res, 200, actionResult('manual_agent.mode', manualAgent.setEnabled(body?.enabled === true)));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/manual-agent/fact') {
    const body = asRecord(await readJson(req));
    sendJson(res, 200, actionResult('manual_agent.fact', manualAgent.submitFact(body?.fact)));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/manual-agent/text-response') {
    const body = asRecord(await readJson(req));
    sendJson(res, 200, actionResult('manual_agent.text_response', manualAgent.submitTextResponse(body?.textDoneFact)));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/manual-agent/outbound/target') {
    const body = asRecord(await readJson(req));
    sendJson(res, 200, actionResult('manual_agent.outbound.target', manualAgent.setOutboundTarget({
      toolSessionId: stringField(body, 'toolSessionId'),
      runId: stringField(body, 'runId'),
      trigger: stringField(body, 'trigger'),
    })));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/manual-agent/outbound/fact') {
    const body = asRecord(await readJson(req));
    sendJson(res, 200, actionResult('manual_agent.outbound.fact', manualAgent.queueOutboundFact(body?.fact)));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/manual-agent/outbound/text-response') {
    const body = asRecord(await readJson(req));
    sendJson(res, 200, actionResult('manual_agent.outbound.text_response', manualAgent.queueOutboundTextResponse(body?.textDoneFact)));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/manual-agent/outbound/clear') {
    sendJson(res, 200, actionResult('manual_agent.outbound.clear', manualAgent.clearOutboundFacts()));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/manual-agent/outbound/send') {
    await provider.emitManualOutboundRun(manualAgent.drainOutboundRun());
    sendJson(res, 200, actionResult('manual_agent.outbound.send', manualAgent.snapshot()));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/manual-agent/terminal') {
    const body = asRecord(await readJson(req));
    const outcome = body?.outcome === 'failed' || body?.outcome === 'aborted' ? body.outcome : 'completed';
    sendJson(res, 200, actionResult('manual_agent.terminal', manualAgent.finishActiveRun({
      outcome,
      message: stringField(body, 'message'),
      code: stringField(body, 'code'),
    })));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/runtime/create') {
    const body = await readJson(req);
    const overrides = toOverrides(body);
    if (currentMode === 'mock-gateway') {
      const mock = await mockGateway.start();
      overrides.url = mock.url;
    }
    const config = await loadGatewayConfig({ workspaceRoot, overrides });
    sendJson(res, 200, actionResult('runtime.create', await manager.create(config)));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/runtime/start') {
    sendJson(res, 200, actionResult('runtime.start', await manager.start()));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/runtime/stop') {
    sendJson(res, 200, actionResult('runtime.stop', await manager.stop()));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/runtime/probe') {
    const body = asRecord(await readJson(req));
    const timeoutMs = typeof body?.timeoutMs === 'number' ? body.timeoutMs : 3000;
    sendJson(res, 200, actionResult('runtime.probe', await manager.probe(timeoutMs)));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/runtime/status') {
    sendJson(res, 200, actionResult('runtime.status', manager.getStatus()));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/runtime/diagnostics') {
    sendJson(res, 200, actionResult('runtime.diagnostics', manager.getDiagnostics()));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/mode') {
    const body = asRecord(await readJson(req));
    const mode = body?.mode === 'mock-gateway' ? 'mock-gateway' : 'real-gateway';
    currentMode = mode;
    if (mode === 'mock-gateway') {
      await mockGateway.start();
    }
    sendJson(res, 200, actionResult('mode.set', await manager.setMode(mode as GatewayMode)));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/mock-gateway/start') {
    sendJson(res, 200, actionResult('mock_gateway.start', await mockGateway.start()));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/downstream/scenarios') {
    sendJson(res, 200, getDownstreamScenarios());
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/downstream/run') {
    const body = asRecord(await readJson(req));
    const scenarioId = stringField(body, 'scenarioId');
    const scenario = getDownstreamScenarios().find((item) => item.id === scenarioId);
    if (!scenario) {
      throw new Error(`Unknown downstream scenario: ${scenarioId ?? 'undefined'}`);
    }
    if (!mockGateway.connected) {
      throw new Error('Mock gateway is not connected. Switch to mock mode, initialize runtime, then start runtime first.');
    }
    sendJson(res, 200, actionResult('downstream.run', await downstreamRunner.run(scenario, body?.raw ?? scenario.raw)));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/provider/scenario') {
    const scenario = toScenario(await readJson(req));
    const provider = manager.provider;
    if (provider instanceof TestProvider) {
      provider.setScenario(scenario);
    }
    sendJson(res, 200, actionResult('provider.scenario', scenario));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/outbound/run') {
    const provider = manager.provider;
    if (!(provider instanceof TestProvider)) {
      throw new Error('Current provider does not support lab outbound trigger');
    }
    sendJson(res, 200, actionResult('outbound.run', await provider.emitOutboundRun()));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/qrcode/run') {
    const body = asRecord(await readJson(req));
    const channel = stringField(body, 'channel') ?? 'opencode';
    const mac = stringField(body, 'mac') ?? `sdk-lab-${process.platform}`;
    const environment = body?.environment === 'uat' ? 'uat' : 'prod';
    const snapshots: unknown[] = [];
    await qrcodeAuth.run({
      channel,
      mac,
      environment,
      policy: {
        refreshOnExpired: false,
        maxRefreshCount: 0,
        pollIntervalMs: 2000,
      },
      onSnapshot(snapshot) {
        snapshots.push(snapshot);
        manager.events.append('qrcode.snapshot', `QR auth snapshot: ${snapshot.type}`, { snapshot });
      },
    });
    sendJson(res, 200, actionResult('qrcode.run', { snapshots }));
    return;
  }

  sendJson(res, 404, actionResult('route.not_found', undefined, new Error(`No route for ${req.method ?? 'GET'} ${url.pathname}`)));
}

function streamEvents(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream',
  });
  for (const event of manager.events.list()) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  const unsubscribe = manager.events.subscribe((event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  req.on('close', unsubscribe);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  setCorsHeaders(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(sanitizeForDisplay(body), null, 2));
}

function sendRawJson(res: ServerResponse, status: number, body: unknown): void {
  setCorsHeaders(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

function actionResult<TPayload>(action: string, payload?: TPayload, error?: unknown): RuntimeActionResult<TPayload> {
  if (error) {
    const code = asRecord(error)?.code;
    return {
      ok: false,
      action,
      error: {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
        code: typeof code === 'string' ? code : undefined,
      },
    };
  }
  return {
    ok: true,
    action,
    payload,
  };
}

function toOverrides(value: unknown): GatewayConfigOverrides {
  const record = asRecord(value);
  return {
    url: stringField(record, 'url'),
    channel: stringField(record, 'channel'),
    toolVersion: stringField(record, 'toolVersion'),
    pluginVersion: stringField(record, 'pluginVersion'),
  };
}

function toScenario(value: unknown): ProviderScenarioConfig {
  const record = asRecord(value);
  return {
    command: stringField(record, 'command') ?? '*',
    kind: toScenarioKind(stringField(record, 'kind')),
    delayMs: numberField(record, 'delayMs'),
  };
}

function stringField(record: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = record?.[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  return value;
}

function numberField(record: Record<string, unknown> | undefined, field: string): number | undefined {
  const value = record?.[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function toScenarioKind(value: string | undefined): ProviderScenarioConfig['kind'] {
  switch (value) {
    case 'offline':
    case 'throw':
    case 'timeout':
    case 'invalid_fact':
    case 'failed_run':
    case 'session_not_found':
    case 'result_reject':
    case 'facts_throw':
    case 'enrich_failure':
    case 'aborted_run':
      return value;
    case 'success':
    default:
      return 'success';
  }
}
