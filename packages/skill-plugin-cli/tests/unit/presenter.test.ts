import assert from "node:assert/strict";
import test from "node:test";
import isUnicodeSupported from "is-unicode-supported";
import {
  TerminalCliPresenter,
  chooseQrRenderer,
  renderQrCode,
  type QrRendererChoice,
} from "../../src/adapters/TerminalCliPresenter.ts";

function createPresenter(qrCodeRenderer: (data: string) => string = () => "<二维码渲染块>") {
  return new TerminalCliPresenter(qrCodeRenderer, () => false);
}

function captureIo(run: () => void) {
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
    run();
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }

  return {
    stdout: stdout.join(""),
    stderr: stderr.join(""),
  };
}

test("TerminalCliPresenter renders default success flow for openclaw", () => {
  const presenter = createPresenter();
  const { stdout, stderr } = captureIo(() => {
    presenter.installStarted({ host: "openclaw", packageName: "@wecode/skill-openclaw-plugin" });
    presenter.hostVersionResolved({ host: "openclaw", version: "2026.4.10" });
    presenter.hostConfigPathResolved({ host: "openclaw", primaryConfigPath: "/Users/you/.openclaw/openclaw.json" });
    presenter.pluginInstalled();
    presenter.qrSnapshot({
      type: "qrcode_generated",
      weUrl: "https://we.example/qr-1",
      pcUrl: "https://pc.example/qr-1",
      expiresAt: "2026-04-28T08:00:00.000Z",
    });
    presenter.assistantCreated({
      host: "openclaw",
      primaryConfigPath: "/Users/you/.openclaw/openclaw.json",
      additionalConfigPaths: [],
    });
    presenter.availabilityChecked();
    presenter.completed({
      host: "openclaw",
      availability: {
        nextAction: {
          kind: "restart_gateway",
          manual: true,
          effect: "gateway_config_effective",
          command: "openclaw gateway restart",
        },
      },
    });
  });

  assert.equal(stderr, "");
  assert.equal(
    stdout,
    "[skill-plugin-cli] 正在为 openclaw 安装 @wecode/skill-openclaw-plugin，请稍候\n"
      + "[skill-plugin-cli] openclaw 版本：2026.4.10\n"
      + "[skill-plugin-cli] openclaw 配置路径: /Users/you/.openclaw/openclaw.json\n"
      + "[skill-plugin-cli] 插件安装完成\n"
      + "[skill-plugin-cli] 请使用 WeLink 扫码创建助理\n"
      + "<二维码渲染块>\n"
      + "[skill-plugin-cli] pc WeLink 创建助理地址: https://pc.example/qr-1\n"
      + "[skill-plugin-cli] 二维码有效期至: 2026-04-28 08:00:00 UTC\n"
      + "[skill-plugin-cli] 请在 WeLink 中创建助理\n"
      + "[skill-plugin-cli] 助理创建完成，正在写入 openclaw 连接配置\n"
      + "[skill-plugin-cli] 已完成连接可用性检查\n"
      + "[skill-plugin-cli] 接入完成：openclaw 已完成插件安装、助理创建与 gateway 配置\n"
      + "[skill-plugin-cli] 下一步：请手动重启 openclaw gateway 以使新配置生效\n"
      + "[skill-plugin-cli] 可执行命令：openclaw gateway restart\n",
  );
});

test("TerminalCliPresenter renders qrcode refresh transcript", () => {
  const presenter = createPresenter();
  const { stdout } = captureIo(() => {
    presenter.qrSnapshot({ type: "expired" });
    presenter.qrSnapshot({
      type: "qrcode_generated",
      weUrl: "https://we.example/qr-2",
      pcUrl: "https://pc.example/qr-2",
      expiresAt: "2026-04-28T08:05:00.000Z",
      refresh: { index: 1, max: 3 },
    });
  });

  assert.equal(
    stdout,
    "[skill-plugin-cli] 二维码已过期，正在刷新\n"
      + "\n"
      + "[skill-plugin-cli] ========= 已刷新二维码（第 1/3 次） =========\n"
      + "\n"
      + "<二维码渲染块>\n"
      + "[skill-plugin-cli] pc WeLink 创建助理地址: https://pc.example/qr-2\n"
      + "[skill-plugin-cli] 二维码有效期至: 2026-04-28 08:05:00 UTC\n"
      + "[skill-plugin-cli] 请在 WeLink 中创建助理\n",
  );
});

test("TerminalCliPresenter renders qrcode status snapshots", () => {
  const presenter = createPresenter();
  const { stdout, stderr } = captureIo(() => {
    presenter.qrSnapshot({ type: "scanned" });
    presenter.qrSnapshot({ type: "confirmed" });
    presenter.qrSnapshot({ type: "cancelled", message: "WeLink 创建助理已取消" });
  });

  assert.equal(stderr, "");
  assert.equal(
    stdout,
    "[skill-plugin-cli] 二维码状态：已扫码，请在 WeLink 中创建助理\n"
      + "[skill-plugin-cli] 二维码状态：已确认\n"
      + "[skill-plugin-cli] 二维码状态：已取消\n",
  );
});

test("TerminalCliPresenter renders redacted verbose qrcode snapshots", () => {
  const presenter = createPresenter();
  const { stdout, stderr } = captureIo(() => {
    presenter.qrSnapshotDiagnostic({
      accessToken: "access-token-1",
      credentials: {
        ak: "ak-1",
        sk: "sk-1",
      },
      nested: {
        access_token: "access-token-2",
        authToken: "auth-token-1",
        "qrcode-token": "qrcode-token-2",
        qrcodeToken: "qrcode-token-1",
        refreshToken: "refresh-token-1",
        token: "token-1",
      },
      status: "confirmed",
    });
  });

  assert.equal(stderr, "");
  assert.equal(
    stdout,
    "[skill-plugin-cli][verbose] qrcode snapshot: "
      + "{\"accessToken\":\"<redacted>\",\"credentials\":{\"ak\":\"<redacted>\",\"sk\":\"<redacted>\"},\"nested\":{\"access_token\":\"<redacted>\",\"authToken\":\"<redacted>\",\"qrcode-token\":\"<redacted>\",\"qrcodeToken\":\"<redacted>\",\"refreshToken\":\"<redacted>\",\"token\":\"<redacted>\"},\"status\":\"confirmed\"}\n",
  );
});

test("TerminalCliPresenter renders weUrl fallback when qrcode rendering fails", () => {
  const presenter = createPresenter(() => {
    throw new Error("render failed");
  });
  const { stdout, stderr } = captureIo(() => {
    presenter.qrSnapshot({
      type: "qrcode_generated",
      weUrl: "https://we.example/qr-fallback",
      pcUrl: "https://pc.example/qr-fallback",
      expiresAt: "2026-04-28T08:05:00.000Z",
    });
  });

  assert.equal(stderr, "");
  assert.equal(
    stdout,
    "[skill-plugin-cli] 请使用 WeLink 扫码创建助理\n"
      + "[skill-plugin-cli] weUrl: https://we.example/qr-fallback\n"
      + "[skill-plugin-cli] pc WeLink 创建助理地址: https://pc.example/qr-fallback\n"
      + "[skill-plugin-cli] 二维码有效期至: 2026-04-28 08:05:00 UTC\n"
      + "[skill-plugin-cli] 请在 WeLink 中创建助理\n",
  );
});

test("TerminalCliPresenter renders verbose stage labels with structured context", () => {
  const presenter = createPresenter();
  const { stdout, stderr } = captureIo(() => {
    presenter.stageProgress({ host: "openclaw", stage: "install_plugin", status: "started", packageName: "@wecode/skill-openclaw-plugin" });
    presenter.stageProgress({ host: "openclaw", stage: "check_host_environment", status: "started" });
    presenter.stageProgress({ host: "openclaw", stage: "write_host_configuration", status: "started" });
  });

  assert.equal(stderr, "");
  assert.equal(
    stdout,
    "[skill-plugin-cli][openclaw] 开始：安装插件 @wecode/skill-openclaw-plugin\n"
      + "[skill-plugin-cli][openclaw] 开始：检查 openclaw 环境\n"
      + "[skill-plugin-cli][openclaw] 开始：写入 openclaw 连接配置\n",
  );
});

test("TerminalCliPresenter renders fallback and warning diagnostics", () => {
  const presenter = createPresenter();
  const { stdout } = captureIo(() => {
    presenter.installStrategyResolved({ strategy: "fallback" });
    presenter.fallbackArtifactResolved({
      artifact: {
        installStrategy: "fallback",
        pluginSpec: "/tmp/plugin/package",
        packageName: "@wecode/skill-opencode-plugin",
        packageVersion: "1.2.3",
        localExtractPath: "/tmp/plugin/package",
        localTarballPath: "/tmp/plugin.tgz",
      },
    });
    presenter.fallbackApplied({
      artifact: {
        installStrategy: "fallback",
        pluginSpec: "/tmp/plugin/package",
        packageName: "@wecode/skill-opencode-plugin",
      },
    });
    presenter.warningRaised({ message: "cleanup failed" });
  });

  assert.equal(
    stdout,
    "[skill-plugin-cli] 安装策略：fallback\n"
      + "[skill-plugin-cli] fallback 产物已解析：package=@wecode/skill-opencode-plugin version=1.2.3 tarball=/tmp/plugin.tgz\n"
      + "[skill-plugin-cli] fallback 已写入宿主目标：pluginSpec=/tmp/plugin/package\n"
      + "[skill-plugin-cli][warning] cleanup failed\n",
  );
});



test("TerminalCliPresenter renders reinstall notice in default mode", () => {
  const presenter = createPresenter();
  const { stdout, stderr } = captureIo(() => {
    presenter.reinstallDetected();
  });

  assert.equal(stderr, "");
  assert.equal(stdout, "[skill-plugin-cli] 检测到已安装插件，将执行重装\n");
});

test("TerminalCliPresenter omits optional fallback artifact fields when absent", () => {
  const presenter = createPresenter();
  const { stdout } = captureIo(() => {
    presenter.fallbackArtifactResolved({
      artifact: {
        installStrategy: "fallback",
        pluginSpec: "/tmp/plugin/package",
        packageName: "@wecode/skill-openclaw-plugin",
      },
    });
  });

  assert.equal(stdout, "[skill-plugin-cli] fallback 产物已解析：package=@wecode/skill-openclaw-plugin\n");
});

test("TerminalCliPresenter renders structured qrcode failures", () => {
  const presenter = createPresenter();
  const { stderr } = captureIo(() => {
    presenter.failed({
      kind: "qrcode_error",
      message: "无法连接 WeLink 创建助理服务",
      summary: {
        type: "network_error",
        code: "ECONNREFUSED",
        message: "connect ECONNREFUSED 127.0.0.1:443",
      },
    });
  });

  assert.equal(
    stderr,
    "[skill-plugin-cli] 接入失败：无法连接 WeLink 创建助理服务\n"
      + "[skill-plugin-cli] 错误摘要：network_error, code=ECONNREFUSED, message=connect ECONNREFUSED 127.0.0.1:443\n",
  );
});

test("TerminalCliPresenter renders usage errors with help hint", () => {
  const presenter = createPresenter();
  const { stderr } = captureIo(() => {
    presenter.failed({
      kind: "usage_error",
      message: "--host 必须为 opencode 或 openclaw",
      showHelpHint: true,
    });
  });

  assert.equal(
    stderr,
    "[skill-plugin-cli] 参数错误：--host 必须为 opencode 或 openclaw\n"
      + "[skill-plugin-cli] 可执行 skill-plugin-cli --help 查看用法\n",
  );
});

test("TerminalCliPresenter renders OSC 8 hyperlink when terminal supports hyperlinks", () => {
  const presenter = new TerminalCliPresenter(() => "<二维码渲染块>", () => true);
  const { stdout } = captureIo(() => {
    presenter.qrSnapshot({
      type: "qrcode_generated",
      weUrl: "https://we.example/qr-3",
      pcUrl: "https://pc.example/qr-3",
      expiresAt: "2026-04-28T08:10:00.000Z",
    });
  });

  assert.ok(
    stdout.includes(
      "[skill-plugin-cli] pc WeLink 创建助理地址: \u001B]8;;https://pc.example/qr-3\u001B\\https://pc.example/qr-3\u001B]8;;\u001B\\\n",
    ),
  );
});

test("TerminalCliPresenter renders plain URL when hyperlink support is disabled", () => {
  const presenter = createPresenter();
  const { stdout } = captureIo(() => {
    presenter.qrSnapshot({
      type: "qrcode_generated",
      weUrl: "https://we.example/qr-4",
      pcUrl: "https://pc.example/qr-4",
      expiresAt: "2026-04-28T08:12:00.000Z",
    });
  });

  assert.match(stdout, /\[skill-plugin-cli\] pc WeLink 创建助理地址: https:\/\/pc\.example\/qr-4\n/u);
});

test("chooseQrRenderer returns small branch when probe returns true", () => {
  const choice = chooseQrRenderer(() => true);
  assert.equal(choice.kind, "qrcode-terminal.small");
  assert.equal(choice.reason, "is-unicode-supported=true");
});

test("chooseQrRenderer returns ANSI branch with static reason when probe returns false", () => {
  const choice = chooseQrRenderer(() => false);
  assert.equal(choice.kind, "qrcode-terminal.ansi");
  assert.equal(choice.reason, "is-unicode-supported=false");
});

test("chooseQrRenderer with real is-unicode-supported library returns matching kind on this CI", () => {
  const realDetected = isUnicodeSupported();
  const choice = chooseQrRenderer();
  const expectedKind = realDetected
    ? "qrcode-terminal.small"
    : "qrcode-terminal.ansi";
  assert.equal(
    choice.kind,
    expectedKind,
    `real isUnicodeSupported()=${realDetected} on platform=${process.platform} TERM=${process.env.TERM}; got ${choice.kind}`,
  );
  assert.equal(
    choice.reason,
    realDetected ? "is-unicode-supported=true" : "is-unicode-supported=false",
  );
});

test("renderQrCode (production default) does not throw on real is-unicode-supported", () => {
  const out = renderQrCode("https://example.com/qr-real");
  if (isUnicodeSupported()) {
    assert.ok(
      out.includes("▀") || out.includes("▄") || out.includes("█"),
      "small branch should emit half-block or full-block chars",
    );
  } else {
    assert.ok(
      out.includes(" ") && !out.includes("▀") && !out.includes("▄"),
      "ANSI branch should emit only ANSI codes + space, no half-blocks",
    );
  }
});

test("chooseQrRenderer: documented coverage matrix (injected stub controls outcome)", () => {
  // The real detection happens inside is-unicode-supported; we exercise the
  // chooseQrRenderer wrapper with explicit stubs. Production code passes the
  // real is-unicode-supported default.
  //
  // The `supported: true` cases below reflect what `is-unicode-supported@2.1.0`
  // returns for each terminal — see docs/qrcode-terminal-rendering-solution.md
  // §5.3 for the full list.
  const cases: Array<{ name: string; supported: boolean; expectedKind: QrRendererChoice["kind"] }> = [
    { name: "Windows Terminal", supported: true, expectedKind: "qrcode-terminal.small" },
    { name: "VS Code integrated", supported: true, expectedKind: "qrcode-terminal.small" },
    { name: "ConEmu + cmder 任务", supported: true, expectedKind: "qrcode-terminal.small" },
    { name: "mintty (TERM=xterm-256color)", supported: true, expectedKind: "qrcode-terminal.small" },
    { name: "Alacritty (TERM=alacritty lowercase)", supported: true, expectedKind: "qrcode-terminal.small" },
    { name: "rxvt-unicode", supported: true, expectedKind: "qrcode-terminal.small" },
    { name: "JetBrains-JediTerm", supported: true, expectedKind: "qrcode-terminal.small" },
    { name: "Terminus (TERMINUS_SUBLIME 老版本)", supported: true, expectedKind: "qrcode-terminal.small" },
    { name: "Terminus ≥0.2.27 (TERM_PROGRAM=Terminus-Sublime)", supported: true, expectedKind: "qrcode-terminal.small" },
    { name: "PowerShell 在 WT/ConEmu/VSCode 内启动（父终端传染）", supported: true, expectedKind: "qrcode-terminal.small" },
    { name: "PowerShell 裸启动 (无父终端 env)", supported: false, expectedKind: "qrcode-terminal.ansi" },
    { name: "cmd 1903+ 裸启动 (无 env, 库漏判)", supported: false, expectedKind: "qrcode-terminal.ansi" },
    { name: "ConEmu 原生 (仅 ConEmuPID, 库漏判)", supported: false, expectedKind: "qrcode-terminal.ansi" },
    { name: "WezTerm (TERM_PROGRAM=WezTerm, 库不认)", supported: false, expectedKind: "qrcode-terminal.ansi" },
    { name: "Alacritty (TERM_PROGRAM=Alacritty, 库只认小写 TERM=alacritty)", supported: false, expectedKind: "qrcode-terminal.ansi" },
    { name: "JetBrains WebStorm/IntelliJ/GoLand (库只认 JetBrains-JediTerm)", supported: false, expectedKind: "qrcode-terminal.ansi" },
  ];
  for (const c of cases) {
    const choice = chooseQrRenderer(() => c.supported);
    assert.equal(
      choice.kind,
      c.expectedKind,
      `case "${c.name}": expected ${c.expectedKind}, got ${choice.kind}`,
    );
  }
});

test("qrSnapshot in verbose mode emits renderer diagnostic for the production default", () => {
  const { stdout } = captureIo(() => {
    const presenter = new TerminalCliPresenter(renderQrCode, () => false, true);
    presenter.qrSnapshot({
      type: "qrcode_generated",
      weUrl: "https://example.com/qr-verbose",
      pcUrl: "https://pc.example/qr-verbose",
      expiresAt: "2026-04-28T08:12:00.000Z",
    });
  });

  const expectedKind = isUnicodeSupported()
    ? "qrcode-terminal.small"
    : "qrcode-terminal.ansi";
  assert.match(
    stdout,
    new RegExp(
      `\\[skill-plugin-cli\\]\\[verbose\\] qrcode renderer: ${expectedKind.replace(/\./g, "\\.")} \\([^\\n]*\\)`,
      "u",
    ),
    `expected ${expectedKind} on platform=${process.platform}; got: ${stdout}`,
  );
});

test("qrSnapshot in verbose mode reports custom-injected renderer", () => {
  const { stdout } = captureIo(() => {
    const presenter = new TerminalCliPresenter(() => "<stub>", () => false, true);
    presenter.qrSnapshot({
      type: "qrcode_generated",
      weUrl: "https://example.com/qr-stub",
      pcUrl: "https://pc.example/qr-stub",
      expiresAt: "2026-04-28T08:12:00.000Z",
    });
  });

  assert.match(stdout, /\[skill-plugin-cli\]\[verbose\] qrcode renderer: custom-injected/u);
});

test("qrSnapshot in non-verbose mode does not emit renderer diagnostic", () => {
  const { stdout } = captureIo(() => {
    const presenter = new TerminalCliPresenter(renderQrCode, () => false, false);
    presenter.qrSnapshot({
      type: "qrcode_generated",
      weUrl: "https://example.com/qr-quiet",
      pcUrl: "https://pc.example/qr-quiet",
      expiresAt: "2026-04-28T08:12:00.000Z",
    });
  });

  assert.equal(
    stdout.includes("qrcode renderer:"),
    false,
    "non-verbose mode must not emit renderer diagnostic",
  );
});
