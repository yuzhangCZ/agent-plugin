import type { ProviderFact } from '../domain/provider.ts';

/**
 * application 层消费的 fact 行为分类。
 * @remarks
 * 这组语义不是 provider protocol 的一部分，而是 runtime application
 * 在校验、投影、观测三个阶段共享的行为判断表。
 */
export interface FactClassification {
  /**
   * 该 fact 是否必须附着在一个已打开、且尚未 closed 的 message 上。
   * 典型场景：text/tool/question 这类消息内容相关 fact。
   */
  requiresOpenMessage: boolean;
  /**
   * session 进入 aborting 后，是否应直接拒绝该 fact。
   * 这里主要用于阻止 abort 过程中继续引入新的活动或新的交互。
   */
  rejectInAbortingSession: boolean;
  /**
   * 在 outbound profile 下，该 fact 是否会把当前事实流标记为 terminal。
   * 当前只用于 message.done 的收口判断。
   */
  marksOutboundTerminal: boolean;
  /**
   * 该 fact 投影出的 event 是否应走 derivedEventProjected 观测口径。
   * 典型场景：message.start/message.done -> step.start/step.done。
   */
  emitsDerivedEvent: boolean;
  /**
   * 该 fact 是否应作为普通 fact 投影，走 uplinkProjected 观测口径。
   * 与 emitsDerivedEvent 并列使用，用来区分 derived event 和普通 uplink。
   */
  projectsFactEvent: boolean;
}

const FACT_CLASSIFICATIONS: Record<ProviderFact['type'], FactClassification> = {
  'message.start': {
    requiresOpenMessage: false,
    rejectInAbortingSession: true,
    marksOutboundTerminal: false,
    emitsDerivedEvent: true,
    projectsFactEvent: false,
  },
  'text.delta': {
    requiresOpenMessage: true,
    rejectInAbortingSession: false,
    marksOutboundTerminal: false,
    emitsDerivedEvent: false,
    projectsFactEvent: true,
  },
  'text.done': {
    requiresOpenMessage: true,
    rejectInAbortingSession: false,
    marksOutboundTerminal: false,
    emitsDerivedEvent: false,
    projectsFactEvent: true,
  },
  'thinking.delta': {
    requiresOpenMessage: true,
    rejectInAbortingSession: false,
    marksOutboundTerminal: false,
    emitsDerivedEvent: false,
    projectsFactEvent: true,
  },
  'thinking.done': {
    requiresOpenMessage: true,
    rejectInAbortingSession: false,
    marksOutboundTerminal: false,
    emitsDerivedEvent: false,
    projectsFactEvent: true,
  },
  'tool.update': {
    requiresOpenMessage: true,
    rejectInAbortingSession: false,
    marksOutboundTerminal: false,
    emitsDerivedEvent: false,
    projectsFactEvent: true,
  },
  'question.ask': {
    requiresOpenMessage: true,
    rejectInAbortingSession: true,
    marksOutboundTerminal: false,
    emitsDerivedEvent: false,
    projectsFactEvent: true,
  },
  'permission.ask': {
    requiresOpenMessage: false,
    rejectInAbortingSession: true,
    marksOutboundTerminal: false,
    emitsDerivedEvent: false,
    projectsFactEvent: true,
  },
  'permission.reply': {
    requiresOpenMessage: false,
    rejectInAbortingSession: false,
    marksOutboundTerminal: false,
    emitsDerivedEvent: false,
    projectsFactEvent: true,
  },
  'message.done': {
    requiresOpenMessage: false,
    rejectInAbortingSession: false,
    marksOutboundTerminal: true,
    emitsDerivedEvent: true,
    projectsFactEvent: false,
  },
  'session.title': {
    requiresOpenMessage: false,
    rejectInAbortingSession: true,
    marksOutboundTerminal: false,
    emitsDerivedEvent: false,
    projectsFactEvent: true,
  },
  'session.error': {
    requiresOpenMessage: false,
    rejectInAbortingSession: false,
    marksOutboundTerminal: false,
    emitsDerivedEvent: false,
    projectsFactEvent: true,
  },
};

/**
 * 统一收敛 application 层对 fact 的行为判断。
 */
export function classifyFact(type: ProviderFact['type']): FactClassification {
  return FACT_CLASSIFICATIONS[type];
}
