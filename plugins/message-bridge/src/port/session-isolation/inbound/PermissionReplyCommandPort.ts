import type { PermissionReplyCommandInput } from '../dto/commands/index.js';
import type { PermissionReplyCommandResult } from '../dto/results/index.js';

export interface PermissionReplyCommandPort {
  execute(input: PermissionReplyCommandInput): Promise<PermissionReplyCommandResult>;
}
