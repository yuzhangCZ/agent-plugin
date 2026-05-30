# Changelog

## Unreleased

### Changed

- Breaking: Gateway register payload 中的业务渠道字段从 `register.toolType` 更名为 `register.channel`；插件继续以 `gateway.channel` 作为配置来源，不再发送或兼容 `toolType`。
