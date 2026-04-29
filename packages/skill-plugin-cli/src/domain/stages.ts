export const INSTALL_STAGE_KEYS = [
  "parse_install_args",
  "check_host_environment",
  "prepare_npm_registry",
  "install_plugin",
  "verify_plugin_installation",
  "create_welink_assistant",
  "write_host_configuration",
  "check_connection_availability",
] as const;

export type InstallStageKey = (typeof INSTALL_STAGE_KEYS)[number];

export const INSTALL_STAGE_LABELS: Record<InstallStageKey, string> = {
  parse_install_args: "解析安装参数",
  check_host_environment: "检查宿主环境",
  prepare_npm_registry: "准备 npm 仓源配置",
  install_plugin: "安装插件",
  verify_plugin_installation: "校验插件安装结果",
  create_welink_assistant: "执行 WeLink 创建助理",
  write_host_configuration: "写入宿主连接配置",
  check_connection_availability: "检查连接可用性",
};
