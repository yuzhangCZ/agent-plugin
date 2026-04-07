import type { DiagnosticDetails } from '../../shared/boundary-types.ts';

export type WireErrorStage =
  | 'message'
  | 'payload'
  | 'event'
  | 'transport'
  | 'adapter'
  | 'invariant'
  | 'usage';

export type WireErrorCode =
  | 'unsupported_message'
  | 'unsupported_action'
  | 'unsupported_event_type'
  | 'missing_required_field'
  | 'invalid_field_type'
  | 'invalid_field_value'
  | 'projection_contract_violation'
  | 'compat_legacy_mapping_failed';

export interface WireViolation {
  stage: WireErrorStage;
  code: WireErrorCode;
  field: string;
  message: string;
  messageType?: string;
  action?: string;
  eventType?: string;
  welinkSessionId?: string;
  toolSessionId?: string;
  details?: DiagnosticDetails;
}

export class WireContractViolation extends Error {
  readonly violation: WireViolation;

  constructor(violation: WireViolation) {
    super(violation.message);
    this.name = 'WireContractViolation';
    this.violation = violation;
  }

  toJSON(): WireViolation {
    return this.violation;
  }
}

export class WireInvariantError extends Error {
  readonly details?: DiagnosticDetails;

  constructor(message: string, details?: DiagnosticDetails) {
    super(message);
    this.name = 'WireInvariantError';
    this.details = details;
  }
}

export class WireUsageError extends Error {
  readonly details?: DiagnosticDetails;

  constructor(message: string, details?: DiagnosticDetails) {
    super(message);
    this.name = 'WireUsageError';
    this.details = details;
  }
}

export function createWireViolation(violation: WireViolation): WireContractViolation {
  return new WireContractViolation(violation);
}
