# Changelog

本项目的所有值得记录的改动都写在这里。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [2.0.0] - 2026-10-17

适配 DeepSeek Harness `0.2.1-rc.2`，并完成一次针对删除/还原/清理链路的对抗式安全审查。
本次版本包含行为变更（默认不再静默执行排队删除），因此按语义化版本升 major。

### Security

- **回收站元数据不能改变删除路径**：`trashEntries()` 不再把 `meta` 展开覆盖 `entryId/dir`；条目目录永远由
  回收站目录项推导。meta 必须与 `entryId`/`sessionId` 一致，否则按 orphan 保守跳过。修复“篡改 meta 让自动清理
  删除其它目录”（严重）。
- **自动清理遵守全部策略**：超期清理逐条经过 `trashPolicyRejection`，`enabled:false`、`allowPurge:false`、
  `protectedSessionIds`、子代理保护、归档/置顶保护、orphan、不完整/损坏条目一律跳过并报告。
- **还原/删除路径真实校验**：词法检查 + `realpath` + 逐层 `lstat`；拒绝 symlink/junction 祖先、跨盘绝对路径、
  悬空链接目标；还原目标只用 `workspaceSlug + sessionDirName` 重建，`originalPath` 只做一致性校验。
- **批量接口不再误报失败**：响应使用独立的 `succeeded` 计数，`ok` 保持布尔；修复 `{ok:true,...result}` 被数字
  `ok` 覆盖导致客户端必然抛错的问题。
- **后台任务检查覆盖所有删除路径**：单条、批量、斜杠命令、排队执行统一经过 `workspace/session-activity`；
  有 workspace 注册表但活动读数失败时 fail-closed。
- **确认规则完整服务端强制**：单条 `/purge` 也接收并校验确认词；批量按阈值、清空回收站永远要求确认词。
- **workspace 引用改用注册表**：0.2.1 下通过 `ctx.workspaceRegistry` 的 detach/attach/archive/pin 更新；
  不再直接改写 storage-json 的 `workspace.json`（外部改写会被内存权威覆盖并可能损坏领域）。无注册表时才走
  定向、带备份、写后结构校验的旧版回退；删除 `stripIdDeep` 的整树深度遍历。
- **排队删除默认不静默执行**：`processPendingOnStartup` 默认 `false`；启动仅报告 `deferred`，用户确认后执行。
  执行前校验会话 cwd/createdAt 身份，防止同 id 重建后误删。
- **审计日志轮转**：默认 5 MiB × 3 份，单行上限 64 KiB，写入失败通过 `/list` 暴露；被拒绝的破坏性请求也写审计。
- 路径/根目录解析与 `@deepseek-ai/dsh-home-paths` 对齐（显式配置 > 非空 DSH_HOME > `~/.dsh`，支持 `~` 展开）；
  会话根优先取 `ctx.sessionPersistence.root`。

### Changed

- 默认排队行为变更（见上）；需要旧行为请显式设置 `processPendingOnStartup: true`。
- 0.2.1 的 `workspace/session-activity`、`sessionPersistence.root`、`workspaceRegistry` 成为主路径；
  0.2.0 文件回退仅保留兼容，不在 `engines.dsh` 支持声明内。
- 全部变更操作串行化，避免异步化后 delete/restore/purge 并发交错。
- 批量响应字段、`/list` 能力/警告/日志/清理报告、`/process-pending`、`/repair-refs` 为前端新增接口。
- 日志中不再写入完整批量结果数组，改为计数与截断摘要。

### Added

- `lib/paths.js`：可单测的 DSH_HOME/路径段/真实路径/链接安全检查。
- `meta.json` v2：`sessionDirName/workspaceSlug/sessionsRoot/wasArchived/wasPinned/refsPending`。
- 回收站启动恢复（不完整条目补全/空条目清理/损坏标记）。
- 引用修复队列 `repair.json` 与 `refsPending` 重试；恢复归档/置顶状态。
- `test/paths.mjs`；扩展 `selftest` 覆盖 meta 篡改、策略化清理、junction/跨盘、批量响应、活动检查、
  服务端确认、0.2.1 根目录、workspace 注册表、排队默认、日志轮转等回归。

### Compatibility

- `engines.dsh: ">=0.2.1-rc.2 <0.3.0"`；`dsh.manifestVersion: 1`。
- 客户端仍只依赖 `react`，槽位入口/主题 token 与 0.2.1 兼容。

## [1.3.1] - 2026-10-04

### Fixed

- **会话行的两个入口与宿主风格不一致**：行内悬停按钮此前用的是 28px 描边文字按钮、24 viewBox 的图标，
  菜单项也是自己拼的样式，与同一插槽里的 archive / pin / rename 明显不同。现在两个入口都按内核
  设计系统的原样度量重做：
  - 悬停按钮 → 内核会话行 `.iconButton`：16×16、`--dsw-radius-xs`、tertiary 色、**hover 只变色不加背景**、
    图标 14px，外面套一个自实现的 Tooltip（`side=bottom` / `align=end` / `delayMs=500` / `gap=8`，
    度量与内核 `Tooltip` 一致，含 `--dsw-alias-tooltip-bg` 气泡与 150ms 淡入）。
  - 菜单项 → 内核 `MenuItemButton` 结构：`itemWrap > button[role=menuitem] > itemIcon + itemLabel`、
    `min-height:34px`、`padding:6px 8px`、`gap:6px`、13/20、`--dsw-radius-md`、图标 14px 用
    `--dsw-alias-menu-icon`、危险行 error 色 + `--dsw-alias-interactive-bg-hover-danger`。
  - **图标改为设计系统原件**：`IconTrashOutlineRegular` / `IconWarningOutlineRegular` /
    `IconCloseOutlineRegular` 的路径逐字复制（16 viewBox、1px 描边、`currentColor`）。
  - 顺带修掉一个真实的交互 bug：内核是通过 `hookContext` 把菜单开合钩子交给条目的，形状是
    `[open, setOpen]`；此前按"函数"调用，异常被静默吞掉，菜单点完不会关。
- **确认弹窗改为宿主原生形态**：按 `Modal` + `RiskConfirmation` 的度量重做（mask、`--dsw-radius-panel`、
  `bg-layer-2`、`elevation-prominent`、header 22/14/12/24、标题 16/24 w500、footer `min-width` 72/136）。
  不可恢复的操作改用 warning 图标（18px、error 色）+ 文案表达危险，确认按钮用 `primary`——与
  `RiskConfirmation` 一致，而不是自创的红色实心按钮（设计系统里根本没有 danger 按钮变体）。

- **插件列表图标改为设计系统的"艺术图标"规范**：设置里的插件卡片用的是**实心 + 蓝色渐变**的图形
  （内建插件的 `icon.svg` 都是 36×36、无底板块、单一线性渐变、细节用 `stroke="#FFFFFF"`），
  此前本插件给的是 24 viewBox 的灰色 1px 线稿，因此在列表里明显偏"轻"。
  现在 `icon.svg` 按同一规范重画：36×36、`#7AC2FF → #4A65E8` 渐变、填充式垃圾桶（圆角盖 + 提手镂空 +
  两道白色竖槽），图形居中（上下边距 6/6，与内建图标一致）。
  自查过程中还发现并修掉了两个几何缺陷：盖子与桶身之间有 1.2px 缝隙（会"盖身分离"）、整体偏高 2 个单位。
### Added

- 静态审计新增 9 条**设计一致性**断言（行按钮 / 气泡 / 菜单项 / 弹窗 / 图标路径），把上表的度量钉住，
  防止以后改回自创样式。

### Changed

- **项目更名为 `dsh-delete-guard`**：`dsh-session-manager`、`dsh-session-trash`、`dsh-safe-delete`、
  `dsh-session-recycle-bin` 等名字在 npm 上已被同赛道插件占用，因此本插件按「**受控删除 / 会话治理**」
  的定位改名为 **`dsh-delete-guard`**（GitHub 仓库与 npm 包同名）。包名、`cordis.patch.yml` 的
  `name`（浏览器半身绑定字段）、API 路由前缀、客户端模块 id、文档与安装命令已一并更新。
  对外定位也据此重写：核心卖点是**可配置的删除策略 + 分级确认 + 审计日志**，而不只是"有回收站"。

## [1.3.0] - 2026-10-04

对**防护机制本身**做了一次对抗式审查，修掉三个真实漏洞与三处逻辑不一致。版本号按语义化版本升 minor：
清空回收站的行为语义发生了变化（由"整目录删除"变为"逐条过策略"）。

### Fixed

- **清空回收站绕过了逐条策略**：以前 `purge-all` 直接删掉整个回收站目录，因此
  `protectedSessionIds` / `allowSubagentDelete` 保护的条目、以及"策略事后收紧"后才被保护的条目，
  都会被它一并抹掉——与单条彻底删除的语义矛盾。现在它与单条删除**共用同一个判定函数**，
  受保护与无法归属的条目一律跳过，并在结果与界面里如实报告跳过数量。
- **排队项会变成僵尸任务**：因策略而永久删不掉的排队项（重启后删除）以前会一直留在队列里，
  每次启动都白跑一遍并再失败一次。现在这类永久失败会被丢弃，并在启动报告里标为 `dropped` 与原因；
  只剩"这次不行、下次可能行"的原因（活跃 / 读不到活跃状态）才会继续排队。
- **排队本身没有过策略闸门**：`/queue` 以前只校验 id 格式，现在与删除共用策略判定，
  从源头避免往队列里塞永远删不掉的条目（含只读模式）。

### Changed

- **进回收站改为"先写 meta 再搬正文"**：条目在任何时刻都可归属、可做策略判定。此前若在"搬完正文、
  还没写 meta"之间崩溃，会留下一个"有正文却无人认领"的目录——既不能还原，也无法判断它是否受保护。
  现在 meta 先落盘（带 `complete: false`），搬完再标记 `complete: true`；失败回滚时会连同空条目目录一起清掉。
- **无法归属的残留不会被销毁**：没有可读 `meta.json` 的条目既不列出、也不参与清空（保守），
  只报为 `orphan`；列表会给出 `purgeBlockedReason`，界面据此禁用按钮并说明原因。
- **只读模式下的批量请求改为顶层 403**：此前会返回"逐条都失败"的 200 响应，掩盖了"整体被策略禁止"这一事实。
- 策略判定集中到一个函数（`policyBlockForId` / `trashPolicyRejection`）与一张文案表（`POLICY_MESSAGES`），
  单条、批量、清空、列表标记共用，杜绝语义分叉。

### Added

- 界面：回收站条目显示「受保护」标记与具体原因；清空回收站前若会跳过条目，弹窗会写明跳过数量，
  完成后如实提示"已清空 N 条，跳过 M 条"。
- 测试：新增 21 项断言覆盖上述全部路径（受保护条目、孤儿残留、只读批量、排队闸门、僵尸队列、meta 归属），
  并把"策略判定只有一个函数""meta 先于正文""永久失败被丢弃"写进静态审计，防止回归。

## [1.2.0] - 2026-10-04

### Added

- **批量操作**：勾选任意条（或当前筛选结果）→ 批量移入回收站 / 批量还原 / 批量彻底删除；
  逐条独立结算，被拦下的条目不影响其它条目，结果逐条可追溯。
- **多个入口**：除侧边栏面板外，新增会话行**悬停按钮**与**右键菜单项**
  （`sidebar.workspaces.session.row.action` / `sidebar.workspaces.session.menu.item`）；
  两者只把目标交给面板确认，不自行删除，保证只有一个确认界面与一套安全语义。
- **策略与范围控制**（`cordis.patch.yml` 的 `config`，服务端强制）：`enabled`（只读模式）、
  `allowPurge`、`allowSubagentDelete`、`protectPinned`、`protectArchived`、`protectedSessionIds`、
  `maxBatchSize`、`requireTypedConfirmAt`、`purgeConfirmWord`、`trashKeepDays`。
  界面顶部以标签显示当前生效的策略，不可删的行会显示具体原因。
- **分级安全确认**（依据 GitLab Pajamas · Destructive actions）：可还原的操作不加摩擦（只弹清单确认）；
  不可恢复的操作使用弹窗 + 危险按钮 + 明确写出后果；达到阈值时要求输入确认词，清空回收站无论几条都要求。
- **分类 / 排序 / 折叠**：按主会话 / 子代理 / 已归档 / 已置顶 / 不可删分类；按更新时间 / 大小 /
  标题 / 工作区排序；分组可折叠且状态在本地记忆。
- 界面底部显示会话根目录、插件数据目录与审计日志路径；`/list` 下发 `policy` 与 `counts`。

### Changed

- **策略违规先于参数校验返回**：配置禁止彻底删除时报 `403 purge-disabled`，不再被"条数过期(409)"掩盖。
- 批量请求必须携带 `confirmCount` 且与实际条数一致；清空回收站还要求条数与界面显示一致（TOCTOU 防护）。
- 斜杠命令新增 `delete-batch`；`purge-all` 必须带上确认词。
- 单条删除改为统一的确认弹窗（可还原的操作不应有过高摩擦）。

### Fixed

- 确认弹窗里的确认词此前只在界面校验、没有回传给操作，现在会随请求提交并由服务端校验。

## [1.1.0] - 2026-10-04

### Added

- **子代理会话**（目录名为裸 uuid）现在也会被列出与删除，并标注「子代理」。
- 「目录里必须真的装着会话日志」的判定：会话根下出现非会话目录时，插件既不列出也不删除。
- 界面按**工作区分组**，新增筛选框（标题 / 工作区 / 会话 id）与「复制会话 id」按钮。
- 斜杠命令 `/sessions`：`list`、`trash`、`delete <sessionId>`、`queue <sessionId>`、
  `unqueue <sessionId>`、`restore <entryId>`、`purge <entryId>`、`purge-all`。
- 回收站按保留期**自动清理**（配置项 `trashKeepDays`，默认 30 天）。
- `test/sensitive-scan.mjs`：开源发布前的敏感信息扫描器（绝对用户路径、身份信息、密钥形态）。

### Changed

- **活跃判定改为 fail-closed**：内核会话读数不可用时不再放行删除，而是拒绝并让界面显示
  「无法判定」，只提供「排入重启后删除」。宁可拒绝，不可误删。
- **还原前强校验**：重新验证条目 `meta.json` 记录的原路径确实落在会话根目录内、目录名等于
  会话 id、投影缓存路径落在缓存目录内；任一条不满足就拒绝还原（元数据可能被外部改动）。
- 删除时一并移动投影缓存的 `<id>.json.bak.*` 残留，还原时一并放回。
- 界面：错误状态给出可重试入口、`Esc` 取消二次确认、通知 4 秒后自动消失、
  请求可中断（组件卸载时 abort）、按钮补 `aria-label`、汇总行显示会话数与总占用、
  面板可见时每 30 秒**静默刷新**一次列表（让「使用中」标记与其它窗口的删除动作跟上）。
- 测试拆分为 `test/selftest.mjs`（端到端）、`test/audit.mjs`（静态清单审计）、
  `test/sensitive-scan.mjs`（敏感信息扫描），由 `npm test` 一次跑完。
- 工作区目录名编码改为按内核 `projectKey` 规则完整实现（非 ASCII 码元转 `~XXXX`），
  非 ASCII 工作区路径现在也能正确归属。

### Fixed

- 无（1.0.0 未发布，无历史缺陷需要修复）。

## [1.0.0] - 2026-10-04

### Added

- 侧边栏「会话管理」页面：按工作区列出全部会话，删除**单条**会话而不影响其它会话。
- 删除默认移入**回收站**（同卷原子 `rename`），可还原、可彻底删除、可清空。
- **正在使用**的会话拒绝删除，并提供「排入重启后删除」通道。
- 引用一并处理：深度摘除 `workspace.json` 里的会话引用（数组删元素、标量置空、
  以 id 为键的映射整条删除），改写前留备份、改写后回读校验。
- HTTP 接口带信任围栏（回环 Host + 同源，拒绝跨站），不使用 `/api` 前缀。
- 审计日志 `<DSH_HOME>/session-manager/log.jsonl`。

[Unreleased]: https://github.com/shibamalaomushi/dsh-delete-guard/compare/v1.3.1...HEAD
[1.3.1]: https://github.com/shibamalaomushi/dsh-delete-guard/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/shibamalaomushi/dsh-delete-guard/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/shibamalaomushi/dsh-delete-guard/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/shibamalaomushi/dsh-delete-guard/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/shibamalaomushi/dsh-delete-guard/releases/tag/v1.0.0
