import type { RuntimeObservation } from '../../application/runtime-observation/index.ts';
import type {
  ProviderAbortSessionInput,
  ProviderCloseSessionInput,
  ProviderCreateSessionInput,
  ProviderCreateSessionResult,
  ProviderHealthInput,
  ProviderHealthResult,
  ProviderListSlashCommandsInput,
  ProviderListSlashCommandsResult,
  ProviderPermissionReplyInput,
  ProviderQuestionReplyInput,
  ProviderRun,
  ProviderRunMessageInput,
} from '../../domain/provider.ts';
import type { ProviderCommandHandlers } from './ProviderCommandHandlers.ts';

/**
 * provider handler 观测装饰器。
 */
export class ObservedProviderCommandHandlers implements ProviderCommandHandlers {
  private readonly handlers: ProviderCommandHandlers;
  private readonly observation: RuntimeObservation;

  constructor(handlers: ProviderCommandHandlers, observation: RuntimeObservation) {
    this.handlers = handlers;
    this.observation = observation;
  }

  async queryStatus(input: ProviderHealthInput): Promise<ProviderHealthResult> {
    this.observation.providerCallStarted('queryStatus', input.traceId);
    try {
      const result = await this.handlers.queryStatus(input);
      this.observation.providerCallSucceeded('queryStatus', input.traceId);
      return result;
    } catch (error) {
      this.observation.providerCallFailed('queryStatus', input.traceId, error);
      throw error;
    }
  }

  async createSession(input: ProviderCreateSessionInput): Promise<ProviderCreateSessionResult> {
    this.observation.providerCallStarted('createSession', input.traceId);
    try {
      const result = await this.handlers.createSession(input);
      this.observation.providerCallSucceeded('createSession', input.traceId, {
        toolSessionId: result.toolSessionId,
      });
      return result;
    } catch (error) {
      this.observation.providerCallFailed('createSession', input.traceId, error);
      throw error;
    }
  }

  async listSlashCommands(input: ProviderListSlashCommandsInput): Promise<ProviderListSlashCommandsResult> {
    this.observation.providerCallStarted('listSlashCommands', input.traceId);
    try {
      const result = await this.handlers.listSlashCommands(input);
      this.observation.providerCallSucceeded('listSlashCommands', input.traceId, {
        slashCommandCount: result.slashCommands.length,
        slashCommands: result.slashCommands,
      });
      return result;
    } catch (error) {
      this.observation.providerCallFailed('listSlashCommands', input.traceId, error);
      throw error;
    }
  }

  async startRequestRun(input: ProviderRunMessageInput): Promise<ProviderRun> {
    const context = { toolSessionId: input.toolSessionId, runId: input.runId };
    this.observation.providerCallStarted('startRequestRun', input.traceId, context);
    try {
      const result = await this.handlers.startRequestRun(input);
      this.observation.providerCallSucceeded('startRequestRun', input.traceId, context);
      return result;
    } catch (error) {
      this.observation.providerCallFailed('startRequestRun', input.traceId, error, undefined, context);
      throw error;
    }
  }

  async replyQuestion(input: ProviderQuestionReplyInput): Promise<{ applied: true }> {
    this.observation.providerCallStarted('replyQuestion', input.traceId);
    try {
      const result = await this.handlers.replyQuestion(input);
      this.observation.providerCallSucceeded('replyQuestion', input.traceId);
      return result;
    } catch (error) {
      this.observation.providerCallFailed('replyQuestion', input.traceId, error);
      throw error;
    }
  }

  async replyPermission(input: ProviderPermissionReplyInput): Promise<{ applied: true }> {
    this.observation.providerCallStarted('replyPermission', input.traceId);
    try {
      const result = await this.handlers.replyPermission(input);
      this.observation.providerCallSucceeded('replyPermission', input.traceId);
      return result;
    } catch (error) {
      this.observation.providerCallFailed('replyPermission', input.traceId, error);
      throw error;
    }
  }

  async closeSession(input: ProviderCloseSessionInput): Promise<{ applied: true }> {
    const context = { toolSessionId: input.toolSessionId };
    this.observation.providerCallStarted('closeSession', input.traceId, context);
    try {
      const result = await this.handlers.closeSession(input);
      this.observation.providerCallSucceeded('closeSession', input.traceId, context);
      return result;
    } catch (error) {
      this.observation.providerCallFailed('closeSession', input.traceId, error, undefined, context);
      throw error;
    }
  }

  async abortExecution(input: ProviderAbortSessionInput): Promise<{ applied: true }> {
    const context = { toolSessionId: input.toolSessionId, runIds: input.runIds };
    this.observation.providerCallStarted('abortExecution', input.traceId, context);
    try {
      const result = await this.handlers.abortExecution(input);
      this.observation.providerCallSucceeded('abortExecution', input.traceId, context);
      return result;
    } catch (error) {
      this.observation.providerCallFailed('abortExecution', input.traceId, error, undefined, context);
      throw error;
    }
  }
}
