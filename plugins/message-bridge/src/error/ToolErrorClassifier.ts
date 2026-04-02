import { TOOL_ERROR_REASON, type ToolErrorReason } from '../contracts/transport-messages.js';
import type { ActionResult } from '../types/index.js';

function normalizeCode(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.trim().toLowerCase();
}

function isSessionNotFoundCode(value: string | undefined): boolean {
  const normalized = normalizeCode(value);
  return normalized === 'session_not_found' || normalized === 'sessionnotfound' || normalized === 'session-not-found';
}

export class ToolErrorClassifier {
  classify(result: ActionResult, action?: string): ToolErrorReason | undefined {
    if (result.success) {
      return undefined;
    }

    if (action !== 'chat') {
      return undefined;
    }

    if (
      result.errorEvidence?.sourceOperation === 'session.get' &&
      isSessionNotFoundCode(result.errorEvidence?.sourceErrorCode)
    ) {
      return TOOL_ERROR_REASON.SESSION_NOT_FOUND;
    }

    return undefined;
  }
}
