export const INSTALL_STAGES = [
  "用户启动 CLI",
  "解析输入并补齐安装上下文",
  "宿主环境校验",
  "仓源配置",
  "插件安装",
  "插件安装校验",
  "二维码认证",
  "宿主配置接入",
  "结果确认",
  "结束收口",
] as const;

export type InstallStageName = (typeof INSTALL_STAGES)[number];
