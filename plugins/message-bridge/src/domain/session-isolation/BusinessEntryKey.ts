/** 业务入口三元组，是正式会话隔离语义的稳定主键。 */
export interface BusinessEntryKey {
  businessSessionDomain: string;
  businessSessionType: string;
  businessSessionId: string;
}
