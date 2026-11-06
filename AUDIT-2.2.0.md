# dsh-delete-guard 2.2.0 — DSH 0.2.2-rc.1 兼容审查

审查对象：DeepSeek Harness `0.2.2-rc.1`（`app.asar` 内 `@deepseek-ai/*` 0.2.2-rc.1）。
结论：2.1.0 的删除/还原安全模型不需要重写；0.2.2 的破坏性变化集中在 **Session 身份与 fork 语义**，
2.2.0 只做兼容加固，不放宽任何删除闸门。

## 1. 逐项核对

| 2.2.0 依赖的宿主契约 | 0.2.2-rc.1 实际实现 | 结论 |
| --- | --- | --- |
| `ctx.webServer.register({ kind, path, handler })` | `dsh-host-webserver` 仍按 `(kind, path)` 注册并返回 disposer | 不变 |
| `ctx.commands.register(definition)` | `dsh-commands` 仍校验 `name/description/handler/input.hint`，返回 effect disposer | 不变 |
| `ctx.sessionPersistence.root` | `dsh-session-persistence-jsonl` 构造时 `this.root = resolve(config.root)` | 不变 |
| `sessionPersistence.list()` | 返回 `{ header, formatStatus, revision, sizeBytes, location }[]`；单个坏条目可能让整表 reject | 新增 `stat(id)` 回退 |
| `sessionPersistence.stat(id)` | 只读目标会话，返回 `{ header, revision, sizeBytes, location }` 或 `undefined` | 新增第二身份源 |
| `ctx.workspaceRegistry.list()/archivedSessionIds/pinnedSessionIds` | `dsh-workspace` 仍暴露；workspace 领域版本仍为 2 | 不变 |
| `WorkspaceEntity.detachSession/attachSession` | 仍存在，写入走 domain table | 不变 |
| `workspace/session-activity` waterfall | `dsh-workspace` 与 `dsh-agent` 仍使用 | 不变 |
| Session 目录布局 `root/<projectKey>/<sessionDir>` | `sessionDir()` 仍按 `projectKey(cwd)+encodeSegment(id)`；主会话 id 仍 `session-<uuid>`，子代理可为裸 UUID | 不变 |
| Session 日志 `session.v4.jsonl.zstd` | v4 + 首帧 zstd 头；插件已按首帧解析 | 不变 |
| `ctx.sessions.get(id)/list()` | `SessionStore` 仍提供；live 判定仍以 `get` 为准 | 不变 |
| 客户端 `__ModuleLoader__.load({id, factory})` | `dsh-client-modules` 仍要求同一注册方式 | 不变 |
| 会话行插槽 `sidebar.workspaces.session.row.action` / `.menu.item` | `dsh-client-ui-workspace` 仍声明并渲染，参数仍含 `sessionId/displayTitle` | 不变 |
| 插件 manifest `dsh.bundle.patch` / `dsh.client` | `dsh-app-boot`/`dsh-plugin-manager` 仍读取 | 不变 |
| `engines.dsh` 兼容检查 | `dsh-app-boot` 用 `semver.satisfies(..., { includePrerelease: true })` | 0.2.2 可通过 |

## 2. 0.2.2 的行为变化与处理

### 2.1 普通 fork 不再等于子代理

0.2.2 的 `SessionStore.fork()` 只写入 `{ cwd, isSeeded: true }`，不再写 `parentSession/origin`；
release notes 也明确“普通会话分支独立运行，不再被误识别为子智能体”。

2.1.0 的 `classifySession` 把任何 `parentSession` 都当成子代理，会把旧版 fork 误标成子代理，
并在 `allowSubagentDelete: false` 时误伤合法删除。2.2.0 改为：

- `origin === "subagent"` → 子代理（权威）；
- 有 `parentSession` 且**不是** seeded fork → 旧版子代理；
- seeded 且 `delegationDepth > 0` → 真实子代理；
- 其余 → 主会话。

`childSessionCount` 同样只统计真实子代理。

### 2.2 批量身份读取可能整体失败

0.2.2 的 `list()` 会读取每个 artifact 的 header，并可能因迁移/损坏状态 reject。删除闸门不能因为
“批量索引坏了”就把可验证会话当成 `identity-unknown`，也不能反过来放行。2.2.0 增加：

1. `list()` 命中 → 用索引 header；
2. 未命中且存在 `stat(id)` → 用定向快照 header；
3. 再回退到日志首行（含 v4 zstd 首帧）；
4. 仍无法核验 → `requireVerifiedSession: true` 时拒绝删除。

## 3. 未采用的改动（有意保留）

- **不使用新增的 Session snapshot/subscription API 做删除**：0.2.2 的新 API 是读面/订阅面，
  没有官方删除事务；插件继续用“整目录移动 + 回收站 meta + 启动恢复”，避免依赖未承诺的写语义。
- **不直接改 `workspace.json`**：有 `workspaceRegistry` 时仍走 registry；文件回退只用于没有注册表的组合。
- **不自动迁移未知 Session 格式**：插件按目录整体搬移，格式版本不参与路径决策；身份核验只看
  `id/createdAt/cwd`，不解析事件体。
- **不放宽 `requireVerifiedSession`/`auditRequiredForPurge` 默认值**。

## 4. 验证

- `test/regression-2.2.mjs`：独立 fork、旧版 fork、UUID 子代理、`list()` 失败时 `stat()` 回退、
  日志首帧回退、活跃会话保护。
- `test/regression-2.1.mjs`、`test/selftest.mjs`、`test/client-runtime.mjs`、`test/audit.mjs`、
  `test/sensitive-scan.mjs` 全部通过。
- 实际安装：`dsh plugin` / 插件管理器装载 `2.2.0`，`apply` 审计日志记录
  `version: 2.2.0`、`sessionsRootSource: sessionPersistence`。
