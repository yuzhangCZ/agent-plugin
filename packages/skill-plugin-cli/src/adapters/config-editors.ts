export function looksLikeJsonObject(content: string) {
  const trimmed = content.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}");
}

function escapeJsonString(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function upsertJsonObjectField(objectBody: string, key: string, escapedValue: string) {
  const existingFieldPattern = new RegExp(`("${key}"\\s*:\\s*")[^"]*(")`, "s");
  if (existingFieldPattern.test(objectBody)) {
    return objectBody.replace(existingFieldPattern, `$1${escapedValue}$2`);
  }

  const trimmedBody = objectBody.replace(/\s*$/su, "");
  const trailingWhitespace = objectBody.slice(trimmedBody.length);
  if (!trimmedBody) {
    return `\n    "${key}": "${escapedValue}"${trailingWhitespace}`;
  }

  const separator = /,\s*$/u.test(trimmedBody) ? "" : ",";
  return `${trimmedBody}${separator}\n    "${key}": "${escapedValue}"${trailingWhitespace}`;
}

export function buildNextBridgeConfig(content: string | null, input: { ak: string; sk: string; url: string }) {
  const escapedAk = escapeJsonString(input.ak);
  const escapedSk = escapeJsonString(input.sk);
  const escapedUrl = escapeJsonString(input.url);

  if (content === null) {
    return `{
  "gateway": {
    "url": "${escapedUrl}",
    "channel": "openx"
  },
  "auth": {
    "ak": "${escapedAk}",
    "sk": "${escapedSk}"
  }
}
`;
  }

  if (!looksLikeJsonObject(content)) {
    throw new Error("bridge config invalid");
  }

  let next = content;
  if (/"auth"\s*:/su.test(next)) {
    next = next.replace(/("auth"\s*:\s*\{)([\s\S]*?)(\n\s*\})/su, (_match, start, objectBody, end) => {
      let nextBody = upsertJsonObjectField(objectBody, "ak", escapedAk);
      nextBody = upsertJsonObjectField(nextBody, "sk", escapedSk);
      return `${start}${nextBody}${end}`;
    });
  } else {
    next = next.replace(/\n\}\s*$/su, `,\n  "auth": {\n    "ak": "${escapedAk}",\n    "sk": "${escapedSk}"\n  }\n}\n`);
  }

  if (/"gateway"\s*:\s*\{/su.test(next)) {
    next = next.replace(/("gateway"\s*:\s*\{)([\s\S]*?)(\n\s*\})/su, (_match, start, objectBody, end) => {
      let nextBody = upsertJsonObjectField(objectBody, "url", escapedUrl);
      nextBody = upsertJsonObjectField(nextBody, "channel", "openx");
      return `${start}${nextBody}${end}`;
    });
  } else {
    next = next.replace(/\{\s*/u, `{\n  "gateway": {\n    "url": "${escapedUrl}",\n    "channel": "openx"\n  },\n  `);
  }

  return next;
}

export function buildNextBridgeConfigWithoutUrl(content: string | null, input: { ak: string; sk: string }) {
  const escapedAk = escapeJsonString(input.ak);
  const escapedSk = escapeJsonString(input.sk);

  if (content === null) {
    return `{
  "gateway": {
    "channel": "openx"
  },
  "auth": {
    "ak": "${escapedAk}",
    "sk": "${escapedSk}"
  }
}
`;
  }

  if (!looksLikeJsonObject(content)) {
    throw new Error("bridge config invalid");
  }

  let next = content;
  if (/"auth"\s*:/su.test(next)) {
    next = next.replace(/("auth"\s*:\s*\{)([\s\S]*?)(\n\s*\})/su, (_match, start, objectBody, end) => {
      let nextBody = upsertJsonObjectField(objectBody, "ak", escapedAk);
      nextBody = upsertJsonObjectField(nextBody, "sk", escapedSk);
      return `${start}${nextBody}${end}`;
    });
  } else {
    next = next.replace(/\n\}\s*$/su, `,\n  "auth": {\n    "ak": "${escapedAk}",\n    "sk": "${escapedSk}"\n  }\n}\n`);
  }

  if (/"gateway"\s*:\s*\{/su.test(next)) {
    next = next.replace(/("gateway"\s*:\s*\{)([\s\S]*?)(\n\s*\})/su, (_match, start, objectBody, end) => {
      const nextBody = upsertJsonObjectField(objectBody, "channel", "openx");
      return `${start}${nextBody}${end}`;
    });
  } else {
    next = next.replace(/\{\s*/u, `{\n  "gateway": {\n    "channel": "openx"\n  },\n  `);
  }

  return next;
}

export function buildNextOpencodeConfig(content: string | null, pluginName: string) {
  if (content === null) {
    return `{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["${pluginName}"]
}
`;
  }

  if (!looksLikeJsonObject(content)) {
    throw new Error("opencode config invalid");
  }
  if (content.includes(`"${pluginName}"`)) {
    return content;
  }
  if (/"plugin"\s*:\s*\[/su.test(content)) {
    if (/"plugin"\s*:\s*\[\s*\]/su.test(content)) {
      return content.replace(/"plugin"\s*:\s*\[\s*\]/su, `"plugin": ["${pluginName}"]`);
    }
    return content.replace(/("plugin"\s*:\s*\[)([\s\S]*?)(\])/su, (_match, start, items, end) => {
      const trimmedItems = items.trimEnd();
      const separator = /\S/u.test(trimmedItems) ? ", " : "";
      return `${start}${trimmedItems}${separator}"${pluginName}"${end}`;
    });
  }
  return content.replace(/\n\}\s*$/su, `,\n  "plugin": ["${pluginName}"]\n}\n`);
}
