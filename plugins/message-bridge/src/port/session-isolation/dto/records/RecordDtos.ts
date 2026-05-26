export interface HostSessionRecord {
  id: string;
  title?: string;
  projectID?: string;
  workspaceID?: string;
  directory?: string;
}

export interface OwnedSessionRecord {
  akScopeKey: string;
  entryKey: string;
  sessionId: string;
  controlled: boolean;
  permissionProfile: 'default' | 'dialog_only';
}

export interface AnchorBindingRecord {
  toolSessionId: string;
  sessionId?: string;
  state: 'anchor_only' | 'attached' | 'closed';
}

export interface AttachOwnerRecord {
  sessionId: string;
  toolSessionId: string;
}
