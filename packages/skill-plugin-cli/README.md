# @wecode/skill-plugin-cli

`@wecode/skill-plugin-cli` 是统一的插件安装命令行入口，用于完成宿主插件安装、二维码授权和宿主配置写入。

> 默认二维码授权链路仍使用 `https`，但会跳过服务端证书校验，以兼容企业内网自签证书或未下发系统信任链的部署环境。

## 安装

```bash
npx @wecode/skill-plugin-cli install --host opencode
npx @wecode/skill-plugin-cli install --host openclaw
```

## 常用参数

```bash
skill-plugin-cli install --host opencode --environment prod --registry https://registry.example.com/ --url ws://localhost:8081/ws/agent
```

- `--environment <uat|prod>`：指定授权环境，默认 `prod`
- `--registry <url>`：指定 `@wecode` npm 仓源
- `--url <ws://...|wss://...>`：显式指定 Message Bridge gateway 地址

## 构建

```bash
pnpm --dir packages/skill-plugin-cli run build
pnpm --dir packages/skill-plugin-cli run build:dev
```

- `build`：生成默认发布产物
- `build:dev`：生成便于调试的开发产物
