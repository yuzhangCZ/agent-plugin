export interface PlatformExtParam {
  [key: string]: unknown;
  businessSessionDomain?: string;
  businessSessionType?: string;
  businessSessionId?: string;
  allowedSlashCommands?: string[];
}

export type ExtParameters = Record<string, unknown> | null;
