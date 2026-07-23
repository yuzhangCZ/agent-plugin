import type { Hooks as OpenCodeHooks } from '@opencode-ai/plugin';
import type { Event as OpenCodeSdkEvent } from '@opencode-ai/sdk';
import type { Event as OpenCodeSdkV2Event } from '@opencode-ai/sdk/v2';

import type { BridgeEvent } from '../../src/runtime/types.ts';

type Assert<T extends true> = T;
type Extends<T, U> = T extends U ? true : false;
type EventType<T> = T extends { type: infer Type } ? Type : never;

type PluginHookEvent = Parameters<NonNullable<OpenCodeHooks['event']>>[0]['event'];
type OpenCodeHostEvent = PluginHookEvent | OpenCodeSdkEvent | OpenCodeSdkV2Event;
type BridgeEventType = EventType<BridgeEvent>;

type _BridgeEventDoesNotExceedOpenCodeHostEvents = Assert<Extends<BridgeEvent, OpenCodeHostEvent>>;
type _BridgeEventIncludesMessagePartDelta = Assert<Extends<'message.part.delta', BridgeEventType>>;
type _BridgeEventIncludesPermissionAsked = Assert<Extends<'permission.asked', BridgeEventType>>;
type _BridgeEventIncludesPermissionReplied = Assert<Extends<'permission.replied', BridgeEventType>>;
type _BridgeEventIncludesQuestionAsked = Assert<Extends<'question.asked', BridgeEventType>>;
