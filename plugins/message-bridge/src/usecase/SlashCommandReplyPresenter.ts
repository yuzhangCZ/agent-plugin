import type {
  SlashCommand,
  SlashCommandFailure,
  SlashCommandReplyPresenter,
  SlashCommandResult,
} from '../port/SlashCommandControlPlanePort.js';

/** 统一组装 slash command 的中文回包文案。 */
export class DefaultSlashCommandReplyPresenter implements SlashCommandReplyPresenter {
  presentSuccess(result: SlashCommandResult): string {
    switch (result.kind) {
      case 'new':
        return this.joinInline([
          '已切换到新会话',
          this.wrapCode(result.session.id),
          result.session.title,
        ]);
      case 'sessions':
        if (result.sessions.length === 0) {
          return '当前范围内没有可切换的会话';
        }
        return [
          '可切换会话列表',
          '',
          ...result.sessions.map((session) => this.renderSessionListItem(session, result.activeSessionId)),
        ].join('\n');
      case 'session':
        return this.joinInline([
          '已切换会话',
          this.wrapCode(result.session.id),
          result.session.title,
        ]);
      case 'models':
        if (result.models.length === 0) {
          return '当前没有可用模型';
        }
        return [
          '可用模型列表',
          '',
          ...result.models.map((model) => `- ${this.wrapCode(`${model.providerId}/${model.modelId}`)}`),
        ].join('\n');
      case 'model':
        return `后续请求将使用该模型 ${result.modelOverride.providerId}/${result.modelOverride.modelId}`;
      default:
        return this.assertNever(result);
    }
  }

  presentFailure(command: SlashCommand, error: SlashCommandFailure): string {
    const reason = this.presentFailureReason(error);

    switch (command.kind) {
      case 'new':
        return `新建会话失败 ${reason}`;
      case 'sessions':
        return `查询会话列表失败, ${reason}`;
      case 'session':
        return `切换会话失败, ${reason}`;
      case 'models':
        return `查询模型列表失败, ${reason}`;
      case 'model':
        return `设置模型失败,${reason}`;
      default:
        return this.assertNever(command);
    }
  }

  /** 统一失败策略：只允许白名单原因进入用户可见文案。 */
  private presentFailureReason(error: SlashCommandFailure): string {
    switch (error.reasonKey ?? error.code) {
      case 'target_session_out_of_scope':
      case 'session_out_of_scope':
        return '目标会话不在当前 project/workspace 可切换范围内';
      case 'target_model_unavailable':
      case 'model_not_found':
        return '目标模型不存在或当前宿主不可用';
      case 'current_session_unavailable':
      case 'session_not_found':
        return '当前没有可用会话';
      case 'unsupported_command':
      case 'invalid_command':
        return '命令不受支持';
      case 'host_unavailable':
      case 'sdk_unreachable':
      default:
        return '当前宿主不可用';
    }
  }

  private renderSessionListItem(
    session: Extract<SlashCommandResult, { kind: 'sessions' }>['sessions'][number],
    activeSessionId?: string,
  ): string {
    const suffix = session.id === activeSessionId ? '（当前）' : '';
    return this.joinInline([
      '-',
      this.wrapCode(session.id),
      session.title ? `${session.title}${suffix}` : suffix || undefined,
    ]);
  }

  private wrapCode(value: string): string {
    return `\`${value.replace(/`/g, '\\`').replace(/\n/g, ' ')}\``;
  }

  private joinInline(parts: Array<string | undefined>): string {
    return parts.filter((part) => part && part.trim()).join(' ');
  }

  private assertNever(value: never): never {
    throw new Error(`Unhandled slash command presenter value: ${JSON.stringify(value)}`);
  }
}
