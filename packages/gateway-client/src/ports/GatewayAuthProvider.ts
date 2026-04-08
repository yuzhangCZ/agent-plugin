export interface AkSkAuthPayload {
  ak: string;
  ts: string;
  nonce: string;
  sign: string;
}

export interface GatewayAuthProvider {
  generateAuthPayload(): AkSkAuthPayload;
}
