import test from "node:test";
import assert from "node:assert/strict";

import { normalizeLegacyCreateSessionPayload } from "../../src/adapters/legacyCreateSessionAdapter.ts";

test("legacy create_session adapter keeps current sessionId compatibility isolated", () => {
  const result = normalizeLegacyCreateSessionPayload({
    sessionId: "session-123",
    metadata: { title: "hello" },
  });

  assert.equal(result.requestedSessionId, "session-123");
  assert.deepEqual(result.payload, {
    sessionId: "session-123",
    metadata: { title: "hello" },
  });
});

