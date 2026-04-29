import assert from "node:assert/strict";
import test from "node:test";
import { TerminalCliPresenter } from "../../src/adapters/TerminalCliPresenter.ts";

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
  const presenter = new TerminalCliPresenter(() => "<二维码渲染块>");
  const { stdout, stderr } = captureIo(() => {
    presenter.installStarted({ host: "openclaw", packageName: "@wecode/skill-openclaw-plugin" });
    presenter.hostVersionResolved({
      host: "openclaw",
      version: "2026.4.10",
    });
    presenter.hostConfigPathResolved({
      host: "openclaw",
      primaryConfigPath: "/Users/you/.openclaw/openclaw.json",
    });
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
  const presenter = new TerminalCliPresenter(() => "<二维码渲染块>");
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

test("TerminalCliPresenter renders weUrl fallback when qrcode rendering fails", () => {
  const presenter = new TerminalCliPresenter(() => {
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
  assert.doesNotMatch(stdout, /二维码渲染失败/);
});

test("TerminalCliPresenter renders structured qrcode failures", () => {
  const presenter = new TerminalCliPresenter(() => "<二维码渲染块>");
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

test("TerminalCliPresenter renders auth_service_error summary fields in order", () => {
  const presenter = new TerminalCliPresenter(() => "<二维码渲染块>");
  const { stderr } = captureIo(() => {
    presenter.failed({
      kind: "qrcode_error",
      message: "WeLink 创建助理服务异常",
      summary: {
        type: "auth_service_error",
        businessCode: "A1001",
        error: "INVALID_TENANT",
        message: "tenant not found",
        httpStatus: 502,
      },
    });
  });

  assert.equal(
    stderr,
    "[skill-plugin-cli] 接入失败：WeLink 创建助理服务异常\n"
      + "[skill-plugin-cli] 错误摘要：businessCode=A1001, error=INVALID_TENANT, message=tenant not found, httpStatus=502\n",
  );
});

test("TerminalCliPresenter trims auth_service_error missing fields", () => {
  const presenter = new TerminalCliPresenter(() => "<二维码渲染块>");
  const { stderr } = captureIo(() => {
    presenter.failed({
      kind: "qrcode_error",
      message: "WeLink 创建助理服务异常",
      summary: {
        type: "auth_service_error",
        message: "tenant not found",
      },
    });
  });

  assert.equal(
    stderr,
    "[skill-plugin-cli] 接入失败：WeLink 创建助理服务异常\n"
      + "[skill-plugin-cli] 错误摘要：message=tenant not found\n",
  );
});

test("TerminalCliPresenter falls back to bare auth_service_error summary", () => {
  const presenter = new TerminalCliPresenter(() => "<二维码渲染块>");
  const { stderr } = captureIo(() => {
    presenter.failed({
      kind: "qrcode_error",
      message: "WeLink 创建助理服务异常",
      summary: {
        type: "auth_service_error",
      },
    });
  });

  assert.equal(
    stderr,
    "[skill-plugin-cli] 接入失败：WeLink 创建助理服务异常\n"
      + "[skill-plugin-cli] 错误摘要：auth_service_error\n",
  );
});

test("TerminalCliPresenter renders verbose stage labels with structured context", () => {
  const presenter = new TerminalCliPresenter(() => "<二维码渲染块>");
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

test("TerminalCliPresenter renders usage errors with help hint", () => {
  const presenter = new TerminalCliPresenter(() => "<二维码渲染块>");
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
