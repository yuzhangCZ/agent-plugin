// 这里保留 unknown：这些类型只用于协议边界和诊断上下文，进入领域模型前必须完成收窄。
export type UnknownBoundaryInput = unknown;

// 这里保留 unknown：仅用于异常诊断附加信息，不属于正式业务协议字段。
export type DiagnosticDetails = Readonly<Record<string, unknown>>;

// 这里保留 unknown：仅用于边界层读取原始对象，进入领域层前必须通过 guard 转成显式字段。
export type PlainObject = Record<string, unknown>;

export type JsonScalar = string | number | boolean | null;

export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonArray = JsonValue[];

export type JsonValue = JsonScalar | JsonObject | JsonArray;
