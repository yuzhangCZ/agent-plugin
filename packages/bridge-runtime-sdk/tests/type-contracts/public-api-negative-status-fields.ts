import type { BridgeRuntime } from '../../src/index.ts';

declare const runtime: BridgeRuntime;

const status = runtime.getStatus();

void status.failure;
void status.code;
void status.phase;
