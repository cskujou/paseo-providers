# Paseo Custom Providers Monorepo (`paseo-providers`)

用于集中开发、维护并跨环境一键部署多个 **Paseo 自定义/增强型 Agent Provider 与 Usage Source 插件** 的多插件仓库（Monorepo）。

## 仓库目录结构

```text
paseo-providers/
├── .gitignore
├── package.json
├── tsconfig.json
├── install.sh                                # 统一管理所有 Provider 的安装、按需部署、状态查看、脚手架生成与卸载还原
├── README.md
├── patches/
│   └── apply-core-patches.mjs                # 自动修补 Paseo 核心（如 Rewind 历史截断修复 + 自动注册新增内置插件 + 编译校验）
├── templates/
│   └── provider-template/                    # 新建自定义 Provider 的标准脚手架模板（./install.sh --new 自动调用）
└── providers/
    ├── antigravity-provider/                 # [已内置] 完整版 Antigravity ACP Provider + 4 窗口额度监控
    │   ├── paseo-plugin.json
    │   ├── icon.svg
    │   ├── index.server.ts
    │   └── server/
    │       ├── usage.ts
    │       ├── provider.ts
    │       └── internal/
    │           ├── acp-client.ts
    │           ├── catalog.ts
    │           ├── rewind.ts
    │           ├── session.ts
    │           └── timeline.ts
    └── <your-next-provider>/                 # 后续新增的任意自定义 Provider
```

---

## 核心特性与设计机制

1. **多 Provider 统一维护与按需部署**：
   - 每个 Provider 独立存放在 `providers/<plugin-id>/` 下，互不干扰。
   - 支持一键部署仓库内所有 Provider（`./install.sh --all --restart`），也支持只部署指定的单个或多个 Provider（`./install.sh antigravity-provider my-other-provider --restart`）。
2. **既能覆盖内置插件，也能直接注入全新内置插件**：
   - 若 `providers/<plugin-id>` 与 Paseo 原生内置插件同名（例如 `antigravity-provider`、`hoplite-provider`、`muse-provider`），安装时会自动备份原版并覆盖。
   - 若 `providers/<plugin-id>` 是你新写的全新插件（例如 `deepseek-provider`），`patches/apply-core-patches.mjs` 会自动将其追加注册进 Paseo 的 `server/plugins/builtin/index.js` (`builtinPlugins` 列表) 中，使其随 Paseo Daemon 启动自动加载，无需手动逐台机器执行 `paseo plugin install`。
3. **安装时自动通过 Paseo 官方编译器预检**：
   - 每次执行 `./install.sh` 时，都会调用目标机器上 Paseo 自带的 `compileDirectoryPlugin` 编译器对每个已安装的 Provider 进行打包与类型边界校验，确保不会因为语法错误导致 Daemon 启动失败。

---

## 常用工作流

### 1. 在新机器/新环境部署

```bash
git clone <你的仓库地址> paseo-providers
cd paseo-providers
chmod +x install.sh

# 部署所有自定义 Provider 并重启 Paseo Daemon
./install.sh --all --restart

# 或者只部署某一个 Provider
./install.sh antigravity-provider --restart
```

### 2. 查看当前仓库内所有 Provider 状态

```bash
./install.sh --list
```

### 3. 一键新建一个新的自定义 Provider（脚手架）

```bash
# 语法: ./install.sh --new <插件目录名> <Provider ID> <CLI可执行文件名>
./install.sh --new my-agent-provider my-agent my-agent-cli
```
执行后会在 `providers/my-agent-provider/` 下自动生成标准 `paseo-plugin.json`、`index.server.ts`、`server/provider.ts` 和 `server/usage.ts` 骨架代码。编写完成后执行：
```bash
./install.sh my-agent-provider --restart
```

### 4. 一键卸载并还原 Paseo 原版状态

```bash
# 还原所有修改（包括 builtin-plugins/、plugin-provider.js 和 builtin/index.js）
./install.sh --uninstall
paseo restart
```
# paseo-providers
