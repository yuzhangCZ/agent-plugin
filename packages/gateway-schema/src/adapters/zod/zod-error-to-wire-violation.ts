import type { ZodError, ZodIssue } from 'zod';
import type { WireContractViolation, WireViolation } from '../../contract/errors/wire-errors.ts';
import { createWireViolation } from '../../contract/errors/wire-errors.ts';

function joinPath(path: readonly (string | number)[]): string {
  if (path.length === 0) {
    return 'type';
  }

  return path.reduce<string>((result, segment) => {
    if (typeof segment === 'number') {
      return `${result}[]`;
    }
    return result ? `${result}.${segment}` : segment;
  }, '');
}

function firstRelevantIssue(error: ZodError): ZodIssue {
  const [issue] = error.issues;
  return issue;
}

interface WireViolationContext {
  stage: WireViolation['stage'];
  messageType?: string;
  action?: string;
  eventType?: string;
  welinkSessionId?: string;
  toolSessionId?: string;
  fieldPrefix?: string;
}

export function zodErrorToWireViolation(
  error: ZodError,
  context: WireViolationContext,
): WireContractViolation {
  const issue = firstRelevantIssue(error);
  const path = joinPath(issue.path.filter((segment): segment is string | number => typeof segment === 'string' || typeof segment === 'number'));
  const field = context.fieldPrefix && path ? `${context.fieldPrefix}.${path}` : path || context.fieldPrefix || 'type';
  const code: WireViolation['code'] = 'invalid_field_value';
  const message = issue.message ? `${field}: ${issue.message}` : `${field} is invalid`;

  return createWireViolation({
    stage: context.stage,
    code,
    field,
    message,
    messageType: context.messageType,
    action: context.action,
    eventType: context.eventType,
    welinkSessionId: context.welinkSessionId,
    toolSessionId: context.toolSessionId,
  });
}
