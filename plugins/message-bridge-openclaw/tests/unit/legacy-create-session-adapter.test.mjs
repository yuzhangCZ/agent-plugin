import test from "node:test";
import assert from "node:assert/strict";

import { normalizeLegacyCreateSessionPayload } from "../../src/adapters/legacyCreateSessionAdapter.ts";

test("legacy create_session adapter absorbs deprecated sessionId without preserving it in payload", () => {
  const result = normalizeLegacyCreateSessionPayload({
    sessionId: "session-123",
    metadata: { title: "hello" },
  });

  assert.deepEqual(result.payload, {
    metadata: { title: "hello" },
  });
});
