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
    ├── antigravity-provider/                 # [已内置] Antigravity ACP Provider + 4 窗口额度监控
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
    │           ├── timeline.ts
    │           └── transcript-history.ts
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
   - 每次执行 `./install.sh` 时，都会调用目标机器上 Paseo 自带的 `compileDirectoryPlugin` 编译器对每个已安装的 Provider 进行打包与模块边界校验，确保不会因为语法错误导致 Daemon 启动失败。

---

## Antigravity provider

需要 Paseo 0.14.0 或更新版本，以及 Node.js 24.9.0 或更新版本。接入已用本机 agy 1.5.6 验证；额度采集在 POSIX 系统使用 Python 3 的 PTY 模块。

- 从 agy CLI 获取模型目录，从 ACP 会话读取实际模型、模式、思考等级和自定义选择项。
- 支持消息、斜杠命令、图片、文本附件、上传文件路径、MCP 配置、交互权限和取消当前回合。
- 支持会话列表分页、导入、持久化恢复和有序历史重放。ACP 没有发送历史时，读取本地转录文件。
- 提供对话、文件和两者同时回退。文件检查点保存在 agy 数据目录的 `paseo-rewind/` 中，可跨进程恢复；对话截断前保留数据库副本。
- 显示四个额度窗口。刷新失败时报错，不把过期缓存显示为当前额度。

### 回退范围与限制

**文件回退会覆盖目标回合之后的工作区改动，包括手动改动。** Git 快照覆盖整个工作树中的非忽略文件，不仅是当前目录；不改动 HEAD 和真实 Git 索引。快照使用临时索引和私有 Git 引用，避免修改原有暂存状态，并防止快照对象被垃圾回收。

非 Git 工作区依赖 ACP 提供的文件路径和修改前内容。无法覆盖的 shell 改动、超过 10 MiB 的文件、读取失败或缺失检查点都会明确拒绝文件回退。安装前已有的历史没有文件检查点，不能追补文件回退。

对话回退和转录恢复依赖 agy 的本地数据格式及默认数据目录；自定义数据路径、其他 CLI 版本和跨平台行为需要另行验证。文件恢复和数据库截断不是跨资源原子事务。

ACP 没有可靠的 steer 接受确认，因此不宣告 `prompt.steer`。也不宣告结构化输出、原生归档或独立子会话能力；CLI 的 print 模式支持某项功能，不代表 ACP 支持。Full access 自动批准工具权限，但多选项问题仍需明确选择。

### 本地开发检查

```bash
npm ci --ignore-scripts
npm test
npm run typecheck
npm run lint
npm run format:check
```

测试使用受控 ACP 子进程、临时文件系统、Git 仓库和 SQLite 数据库，不加载个人会话或调用模型 API。安装命令会修改 Paseo 的插件目录；加上 `--restart` 会终止运行中的会话，确认后再执行。

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
