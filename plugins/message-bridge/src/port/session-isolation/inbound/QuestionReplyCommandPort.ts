import type { QuestionReplyCommandInput } from '../dto/commands/index.js';
import type { QuestionReplyCommandResult } from '../dto/results/index.js';

export interface QuestionReplyCommandPort {
  execute(input: QuestionReplyCommandInput): Promise<QuestionReplyCommandResult>;
}
