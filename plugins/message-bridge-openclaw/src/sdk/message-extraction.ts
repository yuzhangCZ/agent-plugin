import { asRecord } from "../utils/type-guards.js";

export function extractAssistantText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (message?.role !== "assistant") {
      continue;
    }

    if (typeof message.content === "string" && message.content.trim().length > 0) {
      return message.content;
    }

    if (!Array.isArray(message.content)) {
      continue;
    }

    const chunks = message.content
      .map((part) => {
        const item = asRecord(part);
        if (!item) {
          return "";
        }
        if (item.type === "text" && typeof item.text === "string") {
          return item.text;
        }
        if (typeof item.content === "string") {
          return item.content;
        }
        return "";
      })
      .filter(Boolean);
    if (chunks.length > 0) {
      return chunks.join("");
    }
  }

  return "";
}
