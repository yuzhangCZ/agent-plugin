import { randomUUID } from 'crypto';
import type { GatewayClientState } from '@agent-plugin/gateway-client';
import { AGENT_ID_PREFIX } from '../types/index.js';

export interface StateManager {
  isReady(): boolean;
  getAgentId(): string | null;
  getState(): GatewayClientState;
  setState(state: GatewayClientState): void;
  generateAndBindAgentId(): string;
  resetForReconnect(): string;
}

export class DefaultStateManager implements StateManager {
  private state: GatewayClientState = 'DISCONNECTED';
  private agentId: string | null = null;

  isReady(): boolean {
    return this.state === 'READY';
  }

  getAgentId(): string | null {
    return this.agentId;
  }

  getState(): GatewayClientState {
    return this.state;
  }

  setState(state: GatewayClientState): void {
    this.state = state;
  }

  generateAndBindAgentId(): string {
    const id = `${AGENT_ID_PREFIX}${randomUUID()}`;
    this.agentId = id;
    return id;
  }

  resetForReconnect(): string {
    return this.generateAndBindAgentId();
  }
}
