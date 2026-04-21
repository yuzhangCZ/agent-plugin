import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { validateGatewayUplinkBusinessMessage, UPSTREAM_MESSAGE_TYPE } from "../../src/gateway-wire/transport.ts";

const bridgeSourcePath = fileURLToPath(new URL("../../src/OpenClawGatewayBridge.ts", import.meta.url));

test("shared upstream validator rejects malformed tool_event envelopes", () => {
  const result = validateGatewayUplinkBusinessMessage({
    type: UPSTREAM_MESSAGE_TYPE.TOOL_EVENT,
    toolSessionId: "tool-invalid",
    event: {
      family: "opencode",
      type: "question.asked",
      properties: {
        sessionID: "tool-invalid",
        questions: [
          {
            question: 123,
          },
        ],
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.violation.code, "missing_required_field");
  assert.equal(result.error.violation.field, "properties.questions[].question");
});

test("OpenClawGatewayBridge validates upstream messages before every send path", async () => {
  const source = await readFile(bridgeSourcePath, "utf8");

  assert.match(source, /createBridgeRuntime/);
  assert.doesNotMatch(source, /OpenClawGatewaySink/);
});
