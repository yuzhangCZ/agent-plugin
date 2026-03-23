import test from "node:test";
import assert from "node:assert/strict";
import { reconcileFinalText } from "../../dist/reconcileFinalText.js";

test("reconcileFinalText keeps accumulated text when final payload is empty", () => {
  const result = reconcileFinalText("hello from block", "");

  assert.deepEqual(result, {
    appendDelta: "",
    finalText: "hello from block",
    finalReconciled: false,
  });
});

test("reconcileFinalText returns final-only text when no block text exists", () => {
  const result = reconcileFinalText("", "hello from final");

  assert.deepEqual(result, {
    appendDelta: "hello from final",
    finalText: "hello from final",
    finalReconciled: false,
  });
});

test("reconcileFinalText appends suffix delta when final extends accumulated prefix", () => {
  const result = reconcileFinalText("hello ", "hello from final");

  assert.deepEqual(result, {
    appendDelta: "from final",
    finalText: "hello from final",
    finalReconciled: false,
  });
});

test("reconcileFinalText keeps no append delta when final equals accumulated", () => {
  const result = reconcileFinalText("hello from final", "hello from final");

  assert.deepEqual(result, {
    appendDelta: "",
    finalText: "hello from final",
    finalReconciled: false,
  });
});

test("reconcileFinalText marks finalReconciled when final mismatches accumulated", () => {
  const result = reconcileFinalText("hello from block", "goodbye from final");

  assert.deepEqual(result, {
    appendDelta: "",
    finalText: "goodbye from final",
    finalReconciled: true,
  });
});

test("reconcileFinalText handles duplicate final payload deterministically", () => {
  const first = reconcileFinalText("hello ", "hello world");
  const second = reconcileFinalText(first.finalText, "hello world");

  assert.deepEqual(second, {
    appendDelta: "",
    finalText: "hello world",
    finalReconciled: false,
  });
});
