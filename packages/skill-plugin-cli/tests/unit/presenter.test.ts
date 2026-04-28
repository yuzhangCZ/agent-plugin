import assert from "node:assert/strict";
import test from "node:test";
import { TerminalCliPresenter } from "../../src/adapters/TerminalCliPresenter.ts";

test("TerminalCliPresenter prints qr lifecycle snapshots", () => {
  const presenter = new TerminalCliPresenter();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    presenter.qrSnapshot({ type: "scanned", qrcode: "qr-1" });
    presenter.qrSnapshot({ type: "expired", qrcode: "qr-1" });
    presenter.qrSnapshot({ type: "failed", qrcode: "qr-1", reasonCode: "network_error" });
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }

  assert.match(stdout.join(""), /已扫码/);
  assert.match(stdout.join(""), /已过期/);
  assert.match(stderr.join(""), /network_error/);
});

test("TerminalCliPresenter renders terminal qrcode for generated snapshot", () => {
  const presenter = new TerminalCliPresenter(undefined, true);
  const stdout: string[] = [];
  const originalStdout = process.stdout.write.bind(process.stdout);

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  try {
    presenter.qrSnapshot({
      type: "qrcode_generated",
      qrcode: "qr-1",
      display: {
        qrcode: "qr-1",
        weUrl: "https://we.example/qr-1",
        pcUrl: "https://pc.example/qr-1",
      },
      expiresAt: "2026-04-28T00:00:00.000Z",
    });
  } finally {
    process.stdout.write = originalStdout;
  }

  const content = stdout.join("");
  assert.match(content, /\u001B\]8;;https:\/\/pc\.example\/qr-1\u0007打开浏览器授权\u001B\]8;;\u0007/);
  assert.match(content, /pcUrl: https:\/\/pc\.example\/qr-1/);
  assert.match(content, /[▀▄█]/);
  assert.doesNotMatch(content, /weUrl: https:\/\/we\.example\/qr-1/);
});

test("TerminalCliPresenter falls back to weUrl text when qrcode rendering fails", () => {
  const presenter = new TerminalCliPresenter(
    () => {
      throw new Error("render failed");
    },
    false,
  );
  const stdout: string[] = [];
  const originalStdout = process.stdout.write.bind(process.stdout);

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  try {
    presenter.qrSnapshot({
      type: "qrcode_generated",
      qrcode: "qr-1",
      display: {
        qrcode: "qr-1",
        weUrl: "https://we.example/qr-1",
        pcUrl: "https://pc.example/qr-1",
      },
      expiresAt: "2026-04-28T00:00:00.000Z",
    });
  } finally {
    process.stdout.write = originalStdout;
  }

  const content = stdout.join("");
  assert.match(content, /weUrl: https:\/\/we\.example\/qr-1/);
  assert.match(content, /pcUrl（可复制打开）: https:\/\/pc\.example\/qr-1/);
  assert.doesNotMatch(content, /\u001B\]8;;/);
});
