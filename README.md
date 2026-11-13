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
    ├── antigravity-provider/                 # [已内置] Antigravity ACP Provider + 客户端内联思考展示 + 4 窗口额度监控
    │   ├── paseo-plugin.json
    │   ├── icon.svg
    │   ├── index.client.tsx
    │   ├── index.server.ts
    │   ├── client/
    │   │   └── inline-thinking.tsx
    │   ├── shared/
    │   │   └── inline-thinking.ts
    │   └── server/
    │       ├── usage.ts
    │       ├── provider.ts
    │       └── internal/
    │           ├── acp-client.ts
    │           ├── background.ts
    │           ├── catalog.ts
    │           ├── diagnostics.ts
    │           ├── plan.ts
    │           ├── rewind.ts
    │           ├── session.ts
    │           ├── subagents.ts
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
3. **补齐宿主侧摘要字段和回退历史**：
   - Paseo 0.14.0 的插件摘要事件校验会丢弃首尾 prompt 字段，通用桥接还将首条摘要固定为 `null`。安装脚本保留经过验证的可选摘要字段，并映射到本地对话导入列表；其他插件仍可使用原有 `description`。
   - 摘要映射、事件校验或回退补丁未匹配时，安装明确失败，避免上游结构变化后静默漏接。Paseo 升级覆盖核心文件后，需要重新执行安装脚本。
4. **安装时自动通过 Paseo 官方编译器预检**：
   - 每次执行 `./install.sh` 时，都会调用目标机器上 Paseo 自带的 `compileDirectoryPlugin` 编译器对每个已安装的 Provider 进行打包与模块边界校验，确保不会因为语法错误导致 Daemon 启动失败。

---

## Antigravity provider

需要 Paseo 0.14.0 或更新版本，以及 Node.js 24.9.0 或更新版本。接入已用本机 agy 1.5.6 验证；额度采集在 POSIX 系统使用 Python 3 的 PTY 模块。

- 从 agy CLI 获取模型目录，从 ACP 会话读取实际模型、模式、思考等级和自定义选择项。
- 支持消息、斜杠命令、图片、文本附件、上传文件路径、MCP 配置、交互权限和取消当前回合。
- 支持会话列表分页、首尾 prompt 摘要、摘要搜索、导入、持久化恢复和有序历史重放。摘要去除注入元数据并限制为 160 个字符；无标题时使用首条 prompt。ACP 没有发送历史时，从本地转录恢复消息、工具结果、退出码和原始时间戳。
- 支持 Antigravity 思考过程直接展开显示（非默认折叠）：通过插件客户端入口 `index.client.tsx` 注册 `addTimelineTransformer` 与 `addTimelineRenderer`，对 Antigravity 主会话及 `agy-child:*` 子代理的 `reasoning` 时间线项默认直接内联展开渲染流式与已完成思考正文（仍支持点击标题手动收起），而其他 Provider（如 Codex、Claude）保持默认折叠。
- 支持上下文压缩（`compaction`）时间线事件展示：实时监控会话及子代理的 `CHECKPOINT`（`step_type = 23`）步骤，覆盖手动 `/compact`、自动上下文压缩、后台续写、ACP `session/load` 重放与本地转录导入，向 Paseo 发送 `loading` -> `completed` 状态、触发方式（`manual` / `auto`）以及压缩前 token 数（`preTokens`）。
- 支持瞬时上游执行错误的自动回退与重试：当 `agy` 因代理池坏出口节点、上游连接抖动或进程异常退出返回瞬时错误（包括仅输出 `Agent execution terminated due to error.` 且在 SQLite `step_type = 17` 记录 `User location is not supported`、`UNAVAILABLE`、`INTERNAL`、`429`/`5xx` 等瞬时故障）时，自动销毁污染的 ACP 进程、按需回滚文件检查点并截断失败回合的会话记录后重新提交提示（可通过 `PASEO_AGY_AUTO_RETRY_MAX` 与 `PASEO_AGY_AUTO_RETRY_DELAY_MS` 配置，默认最多重试 3 次）。已产生不可回退副作用（如 `run_command`、子代理、MCP 调用）或属于额度/鉴权/参数等永久性错误时不自动重试。
- 提供对话、文件和两者同时回退。文件检查点保存在 agy 数据目录的 `paseo-rewind/` 中，可跨进程恢复；对话截断前保留数据库副本。
- 显示四个额度窗口。采集明确使用账户的 home 目录，不继承 daemon 的项目目录。遇到信任确认页不自动批准；启动失败、执行失败和无法识别额度输出分别报错，不把过期缓存显示为当前额度。

### 长任务与运行时

正常提示、工具结算和后台任务等待不设 provider 自定运行时长上限，也不在正常回合完成或模型达到 token 限制时关闭 ACP 进程。后续回合复用同一运行时。工具仍在运行时保持 running，用户可显式取消；等待过程中转录暂时不可用不会触发会话销毁。

`run_command` 明确设置 `IsDaemon: true` 时，常驻服务的启动不要求等待其退出才能开始下一轮；provider 会阻止空闲运行时回收。其他后台任务仍等待实际完成通知及自动续写。`schedule` 的定时唤醒、有限次数 Cron、`TimerCondition` 提前取消和成功的 `manage_task` 终止也参与结算；每次唤醒后重新等待模型续写，不把上一条进度报告视为最后一次唤醒的结果。后台识别依赖 agy 本地转录格式，未知或不完整状态可能继续等待，需要用户取消。

启动、配置、目录查询及显式取消/关闭保留各自的协议等待和资源清理界限。这些界限不作为正常任务的执行时限；文件回退的路径、令牌和备份检查也不删除。

### 诊断日志与后台续写

provider 保留上游 RPC 错误的代码和原始 `data`，向 Paseo 传递错误消息、代码及脱敏后的 `diagnostic`。诊断包括请求方法、请求 ID 和错误详情；回合内失败不再只剩 `Agent execution terminated due to error.`。凭据、请求提示正文和环境字段不写入日志，诊断输出长度有限；分享日志前仍应检查上游错误文本。

诊断使用 `[antigravity]` 前缀，由 Paseo 收集到 `$PASEO_HOME/daemon.log`（默认 `~/.paseo/daemon.log`）。按 `turnId` 和 `conversationId` 关联 `acp.rpc_failed`、`turn.failed`、`turn.interrupt_requested`；可区分原始执行错误、用户催进度触发的中断和随后的新回合错误。

后台状态会分别显示「任务运行中」「任务完成、等待 AGY 自动续写」「AGY 已记录自动续写」和最终完成。续写的思考、工具状态和回答按新增或变化的转录项及时回传，不再等整个自动回合结束才显示。`background.observed` 记录阶段和最后一步，`background.forwarded` 记录前台回传，`background.tool` 记录续写工具状态；没有新记录时不反复刷日志，也不添加固定等待上限或自动重启。检测到失败的模型执行记录时，回合以 `BACKGROUND_CONTINUATION_FAILED` 结算；新提示忽略上一用户回合的后台错误。

如果只有后台任务完成通知，没有后续模型记录，provider 不能据此假称 AGY 已唤醒，也不会盲目提交另一条提示。AGY 1.5.6 的真实测试中，`default` 模式自动续写额外 Shell 出现过阻塞，而自动读文件和 `auto` 模式的 Shell 续写通过；绕过 provider 的原生 ACP 测试也复现了后台 Shell 等待时不发送新的权限请求。provider 无法批准一条 AGY 未发送的请求，不能用自动放宽权限掩盖问题。

### 计划审批与子代理

在 `plan` 模式中，AGY 成功写入当前会话的 `implementation_plan.md`，且显式设置 `ArtifactMetadata.RequestFeedback` 和 `UserFacing` 时，provider 在 Paseo 中发布计划卡片和审批请求。批准后先确认原生会话切换到 `default`，再提交带有获批计划的实施提示；拒绝保留计划模式，不启动实施。模式切换失败不会假称批准成功，新的用户提示会撤销旧请求。待审批计划可从本地转录恢复；通过 Paseo 持久化句柄恢复时，已拒绝的同一计划不重复弹出。

这是基于 AGY 工件反馈的 **provider 自有审批交互**，不是 AGY 原生 ACP 退出计划接口。只显示普通计划文字、普通文件写入或工具权限不会触发该审批。

`invoke_subagent` 返回真实子会话 ID 后，provider 发布父会话拥有的子会话、关联工具卡片，并回传子代理各自的思考、工具、回答和终态。支持嵌套子代理及父会话导入后的子历史恢复。父回合等待子代理完成通知和父模型自动续写，不只等待启动工具返回；显式取消和真实运行时退出会结算仍在运行的子代理。子会话按 `restoration: parent` 恢复，不提供独立发送提示或独立恢复入口，也不会跟随工具结果中的任意日志路径。

### 回退范围与限制

**文件回退会覆盖目标回合之后的工作区改动，包括手动改动。** Git 快照覆盖整个工作树中的非忽略文件，不仅是当前目录；不改动 HEAD 和真实 Git 索引。快照使用临时索引和私有 Git 引用，避免修改原有暂存状态，并防止快照对象被垃圾回收。

非 Git 工作区依赖 ACP 提供的文件路径和修改前内容。无法覆盖的 shell 改动、超过 10 MiB 的文件、读取失败或缺失检查点都会明确拒绝文件回退。安装前已有的历史没有文件检查点，不能追补文件回退。

对话回退和转录恢复依赖 agy 的本地数据格式及默认数据目录；自定义数据路径、其他 CLI 版本和跨平台行为需要另行验证。文件恢复和数据库截断不是跨资源原子事务。

ACP 没有可靠的 steer 接受确认，因此不宣告 `prompt.steer`。也不宣告结构化输出或原生归档；子会话仅宣告父会话拥有的 `session.subsession`，不宣告独立交互。CLI 的 print 模式支持某项功能，不代表 ACP 支持。Full access 自动批准工具权限，但多选项问题仍需明确选择。

### 宿主接口验证范围

| 功能 | 已验证的契约 |
| --- | --- |
| 加载本地对话 | 列表分页、标题、首尾 prompt、时间、摘要搜索、导入后的持久化句柄和历史 |
| 配置与恢复 | 模型、思考等级、自定义选项、运行信息、设置失败、恢复后保留选择 |
| 回合与运行时 | 普通提示、回合完成、取消、进程退出、空闲安全停机判断 |
| 权限与内容 | 精确选择、Full access 下的问题选择、图片和附件传递；MCP 连接配置透传 |
| 计划审批 | 工件反馈条件、计划卡片、批准后模式提交与实施、拒绝、模式切换失败、待审批恢复与拒绝状态保留 |
| 子代理 | 真实子会话、父子关联、独立历史、嵌套、完成与失败、取消、导入恢复及父模型自动续写 |
| 后台任务 | 命令完成、定时唤醒、链式定时器、Cron 次数、条件取消及前台工具排空 |
| 重试、压缩与思考 UI | 瞬时错误自动回退与重试、`compaction` 时间线透传、`clientBundle` 编译与 Antigravity 思考默认内联展开 |
| 未支持的能力 | steer、结构化输出和精确 MCP 预授权不宣告或明确拒绝；子会话不支持独立交互 |

Paseo 的本地归档与 agy 原生归档是不同能力。未宣告原生归档不会阻止 Paseo 归档本地代理。真实 Gemini 3.8 Flash 后台命令及下一轮已验证共用同一个存活 ACP 进程；编译后的 provider 也已验证计划审批后实际写入与读取文件，以及真实子代理的读取结果、独立历史、父工具关联和父模型续写。费用与逐回合 token 明细、跨平台行为和浏览器界面尚未验证，不能据此宣称与 Pi、Claude、Codex 功能完全一致。

### 本地开发检查

```bash
npm ci --ignore-scripts
npm test
npm run typecheck
npm run lint
npm run format:check
```

自动化测试使用受控 ACP 子进程、临时文件系统、Git 仓库和 SQLite 数据库；宿主集成测试编译实际 provider，再通过 Paseo 插件桥接验证字段和行为，不加载个人会话或调用模型 API。默认使用固定开发依赖 Paseo 0.14.0，也已对本机 0.15.3 宿主验证。可通过 `PASEO_TEST_SERVER_ENTRY` 指定目标版本的 `@getpaseo/server` 入口，不替换开发依赖。

`@getpaseo/server` 仅为宿主测试的开发依赖，该固定版本继承了上游依赖的安全公告。测试不启动其 HTTP/MCP 服务，安装脚本也不将该开发依赖部署到运行中的 daemon；宿主安全升级需单独验证。

安装命令会修改 Paseo 的插件目录；加上 `--restart` 会终止运行中的会话，确认后再执行。

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
