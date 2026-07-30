import type { JsonValue } from '../../shared/boundary-types.ts';

export interface PlatformExtParam {
  [key: string]: unknown;
  businessSessionDomain?: string;
  businessSessionType?: string;
  businessSessionId?: string;
  allowedSlashCommands?: string[];
}

export interface DownstreamExtParameters {
  [key: string]: unknown;
  businessExtParam?: JsonValue;
  platformExtParam?: PlatformExtParam;
}

export type UpstreamExtParameters = Record<string, unknown>;
