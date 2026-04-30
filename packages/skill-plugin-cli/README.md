# @wecode/skill-plugin-cli

`@wecode/skill-plugin-cli` 是统一的插件安装命令行入口，用于完成宿主插件安装、二维码授权和宿主配置写入。

## 安装

```bash
npx @wecode/skill-plugin-cli install --host opencode
npx @wecode/skill-plugin-cli install --host openclaw
npx @wecode/skill-plugin-cli install --host opencode --install-strategy fallback
npx @wecode/skill-plugin-cli install --host openclaw --install-strategy fallback
```

## 常用参数

```bash
skill-plugin-cli install --host opencode --install-strategy host-native --environment prod --registry https://registry.example.com/ --url ws://localhost:8081/ws/agent
```

- `--install-strategy <host-native|fallback>`：安装策略，默认 `host-native`
- `--environment <uat|prod>`：指定授权环境，默认 `prod`
- `--registry <url>`：指定 `@wecode` npm 仓源
- `--url <ws://...|wss://...>`：显式指定 Message Bridge gateway 地址

## 策略语义

- `host-native`：直接调用宿主当前标准插件安装入口
- `fallback`：由 CLI 自行执行 `npm view`、`npm pack`、Node 进程内解包、缓存与发布包校验，再写入宿主目标
- `host-native` 失败后不会自动切到 `fallback`
- `fallback` 失败后不会回退 `host-native`
- 重复安装会自动重装
- `fallback` 运行时依赖 `npm`，不要求宿主系统额外提供 `tar`
- OpenCode fallback 会将受控缓存目录下的本地绝对路径写入 plugin spec
- OpenClaw fallback 会使用本地 `.tgz` 执行 `openclaw plugins install <local-tgz>`

## 构建

```bash
pnpm --dir packages/skill-plugin-cli run build
pnpm --dir packages/skill-plugin-cli run build:dev
```

- `build`：生成默认发布产物
- `build:dev`：生成便于调试的开发产物
