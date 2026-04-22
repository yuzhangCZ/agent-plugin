/**
 * AK/SK 鉴权载荷结构。
 */
export interface AkSkAuthPayload {
  ak: string;
  ts: string;
  nonce: string;
  sign: string;
}

/**
 * 鉴权载荷提供器端口。
 */
export interface GatewayAuthProvider {
  generateAuthPayload(): AkSkAuthPayload;
}
