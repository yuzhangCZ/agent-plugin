export type SessionIsolationDiagnosticEvent =
  | {
    kind: 'owned_session_store_corrupt';
    severity: 'warn';
    filePath: string;
    errorMessage: string;
  }
  | {
    kind: 'owned_session_store_invalid_record';
    severity: 'warn';
    filePath: string;
    sessionId: string;
  }
  | {
    kind: 'owned_session_store_backup_created';
    severity: 'warn';
    filePath: string;
    backupPath: string;
  }
  | {
    kind: 'owned_session_store_backup_failed';
    severity: 'error';
    filePath: string;
    errorMessage: string;
  }
  | {
    kind: 'ownership_mutation_failed';
    severity: 'error';
    operation: 'bindOwnedSession' | 'switchAttachedSession' | 'closeOwnedSession' | 'reconcileDeletedSession';
    toolSessionId?: string;
    sessionId?: string;
    errorMessage: string;
  };

/**
 * session-isolation 诊断输出端口。
 * @remarks 诊断事件只用于日志/状态可观测性，不应改变控制面业务结果。
 */
export interface SessionIsolationDiagnosticsPort {
  record(event: SessionIsolationDiagnosticEvent): void;
}
