import { createHmac, randomUUID } from 'node:crypto';

import type { GatewayAuthProvider } from '../ports/GatewayAuthProvider.ts';
import type { AkSkAuthPayload } from '../ports/GatewayAuthProvider.ts';

export type { AkSkAuthPayload } from '../ports/GatewayAuthProvider.ts';
export type { GatewayAuthProvider } from '../ports/GatewayAuthProvider.ts';

export class DefaultAkSkAuth implements GatewayAuthProvider {
  private readonly accessKey: string;
  private readonly secretKey: string;

  constructor(accessKey: string, secretKey: string) {
    this.accessKey = accessKey;
    this.secretKey = secretKey;
  }

  generateAuthPayload(): AkSkAuthPayload {
    const ts = Math.floor(Date.now() / 1000).toString();
    const nonce = randomUUID();
    const sign = createHmac('sha256', this.secretKey)
      .update(`${this.accessKey}${ts}${nonce}`)
      .digest('base64');

    return {
      ak: this.accessKey,
      ts,
      nonce,
      sign,
    };
  }
}

export function createAkSkAuthProvider(accessKey: string, secretKey: string): GatewayAuthProvider {
  return new DefaultAkSkAuth(accessKey, secretKey);
}

export function buildAuthSubprotocol(payload: AkSkAuthPayload): string {
  return `auth.${Buffer.from(JSON.stringify(payload), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')}`;
}
