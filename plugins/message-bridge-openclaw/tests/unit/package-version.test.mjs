import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { resolveRegisterMetadata } from "../../src/runtime/RegisterMetadata.ts";
import { resolvePackageVersion } from "../../src/runtime/packageVersion.ts";

const ORIGINAL_PACKAGE_VERSION = globalThis.__MB_PACKAGE_VERSION__;

function restoreInjectedPackageVersion() {
  if (typeof ORIGINAL_PACKAGE_VERSION === "undefined") {
    delete globalThis.__MB_PACKAGE_VERSION__;
    return;
  }

  globalThis.__MB_PACKAGE_VERSION__ = ORIGINAL_PACKAGE_VERSION;
}

afterEach(() => {
  restoreInjectedPackageVersion();
});

test("returns injected package version when available", () => {
  globalThis.__MB_PACKAGE_VERSION__ = "0.1.0-test";
  assert.equal(resolvePackageVersion(), "0.1.0-test");
});

test("falls back to unknown when package version is not injected", () => {
  delete globalThis.__MB_PACKAGE_VERSION__;
  assert.equal(resolvePackageVersion(), "unknown");
});

test("register metadata does not treat package version as toolVersion", () => {
  globalThis.__MB_PACKAGE_VERSION__ = "package-version-should-not-be-used";
  const metadata = resolveRegisterMetadata(
    {
      info() {},
      warn() {},
      error() {},
    },
  );

  assert.notEqual(metadata.toolVersion, "package-version-should-not-be-used");
});
