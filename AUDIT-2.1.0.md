# dsh-delete-guard 2.0.0 审查与 2.1.0 修复报告

审查对象：`dsh-delete-guard-2.0.0`（`index.js` SHA-256 `DB4CC93F…FE4968`，`client.js` 80,339 B，
`lib/paths.js` 6,143 B）。修复版本：2.1.0。

结论：25 项服务端/策略/持久性问题全部**成立**（其中 R21/R22 是条件性/加固类，R24 是保证不足而非已证实丢数据）；
12 项交互问题全部**成立**（U12 是 Host API 限制）。2.1.0 已修复 R01–R25、U01–U11，并为 U12 记录上游方案。

## 一、服务端/策略（R01–R25）

| ID | 判定 | 2.0.0 证据与影响 | 2.1.0 修复 |
| --- | --- | --- | --- |
| R01 | 成立（跨进程窗口条件性） | `moveToTrash` 先 `assertDeletable`/`await assertNoActivity`，随后直接 rename；等待期间新回合开始会移走活跃目录。Windows 常因打开句柄失败而回滚，但不是保证。 | 异步后重新 `findSessionDir`/指纹校验、复查 liveness；rename 后再查 live/activity，已活跃则回滚正文并返回 409。跨进程互斥仍只能由宿主保证。 |
| R02 | 成立 | registry 的 pinned/archived getter 抛错时回退 workspace.json；文件损坏/缺失得到空集合，`protectPinned/protectArchived` 静默失效。 | 记录 `pinnedKnown/archivedKnown`；保护开启且状态未知返回 `protection-unknown`；meta 持久化 `wasXKnown`。 |
| R03 | 成立 | `bool()` 只接受 boolean，`enabled:"false"`/`allowPurge:"false"`→true，`protectPinned:"true"`→false；`int()` 还会把 null→0。 | 严格类型/范围校验，错误进入 `configErrors`；所有变更 503 `config-invalid`，列表仍可查看错误。 |
| R04 | 成立（触发条件性） | `recoverTrash` 对 `complete:false` 且无 payload 的条目，只要顶层是 meta/projection 就 `rmSync`；不检查只读/allowPurge/protection，也不看 projection 内容。 | 恢复不再递归删除；空/不完整条目只标记保留，损坏/不完整清理必须显式 force + 确认词。 |
| R05 | 成立 | payload 已搬但 meta 未 complete 时只补 `complete:true`；不重建 projectionFiles，不重试 detach；崩溃后缓存/引用丢失。 | meta v3 阶段；恢复扫描 payload/projection、补全清单、置 `refsPending` 并由启动重试；新增 `restoring-payload` 意图。 |
| R06 | 成立 | `moveProjectionFiles` 只在全部成功后返回 names；第二个文件失败时 `projections` 仍为 `[]`，回滚不改已搬文件，随后 `rmSync(entryDir)` 永久删掉它们。 | 调用方共享 `progress.moved`；失败时扫描 entry/projection 全量回滚，目标冲突保留副本，只有确认全部恢复才删除空条目。 |
| R07 | 成立 | 还原时目标已存在只 warning 跳过，随后无条件删除整个条目，冲突副本丢失。 | 返回 conflicts/missing/remaining；`partial:true`，保留条目为 `restored-payload`，支持重试/显式清理。 |
| R08 | 成立（低概率） | `normalizeMeta` 静默 `slice(0,32)`；移动端无上限；还原后删除条目。 | 移除静默截断；移动前检查 512 并明确 413；还原扫描目录补全，超限保留剩余。 |
| R09 | 成立 | `assertBatch` 只在 confirmCount 非 undefined 时校验；批量删除/purge 可省略。 | 破坏性批量接口强制 `confirmCount`；缺失返回 `confirm-required`。 |
| R10 | 成立 | 清空/process-pending 只绑定数量；A 还原、B 入站后数量不变会误删 B。 | 清空提交 `entryIds` 精确集合，排队执行提交 `sessionIds` 精确集合；集合变化返回 `stale`。 |
| R11 | 成立 | `Number(null)===0`，排队 null createdAt 变 0；header 可读后比较失败被 dropped。 | 只接受安全正整数，否则 null；保留 `identity-unknown`，不再默认 0。 |
| R12 | 成立 | 索引读取失败得到空 map，`processPending` 的 header 比较被直接跳过。 | 索引/日志 header 都拿不到时保留并报告 `identity-unknown`；绝不跳过比较删除。 |
| R13 | 成立 | 原工作区不存在时不 warning，`warnings.length===0` 返回成功，未入修复队列。 | 缺工作区/方法不可用返回 `workspace-missing`/`attach-unavailable`，`refs:false` 并入修复队列。 |
| R14 | 成立 | 启动先 sweep 再 retry refs；sweep 不跳过 refsPending，超期后丢失修复依据。 | 启动先 `retryPendingAttaches`/`retryPendingRefs` 再 sweep；自动清理跳过 refsPending。 |
| R15 | 成立 | pending/repair 损坏被读成 [] 后覆盖；容量 `slice` 丢尾部；repair 去重只按 kind+sessionId。 | 损坏隔离 `.corrupt-*` 且失败拒绝覆盖；容量满报错不截断；去重含 operationId；损坏文件保留旧内容。 |
| R16 | 成立 | payload 已提交后 `writePending`/`appendRepair` 抛错返回匿名 500，无 entryId；重试 404。 | 提交后失败返回 `committed:true`/`entryId`/`warnings`/`failures`；还原同理；pending/repair 失败不再是匿名 500。 |
| R17 | 成立 | meta 保存 sessionsRoot 但还原只用当前 root；切换后静默写入新根。 | 根不同默认 409 `root-changed`；`relocate:true` 才迁移到当前根并给警告。 |
| R18 | 成立 | `looksLikeSessionDir` 只看文件名；同名子目录、无 header 目录也会被列/删；`unverified` 仅展示。 | 要求普通文件；索引/日志 header 核验 id/createdAt/cwd；`requireVerifiedSession:true` 时拒绝未验证目录；还原也核对 payload header 与删除时身份。 |
| R19 | 成立（绕过条件性） | 列表用 header 判子代理，策略用 id 前缀；`session-` 子代理在 `allowSubagentDelete:false` 下仍可删。 | 列表/策略/回收站 meta 共用 header 分类；`session-` 子代理也被保护。 |
| R20 | 成立 | purge 只看启动时写入的 `broken`；payload 后来消失仍可删，stale broken 又永久阻止。 | 操作时重新 `inspectTrashEntry`；普通 purge 拒绝 broken/incomplete/refsPending；强制清理必须确认词；字段/损坏分开。 |
| R21 | 成立（加固） | TRASH/PROJ 根只做词法 join；`assertNoSymlinkAncestors` 不检查根最终组件；清理/回滚直接递归 rm。 | HOME/DATA/TRASH/投影根/workspace.json 规范化并拒绝链接；projection/rollback 前复查；同一权限本地竞态仍属边界。 |
| R22 | 成立（条件性） | 无 connection 时只校验 Host/Origin，不校验 socket.remoteAddress；远程可伪造 Host。 | 回退模式要求 TCP 对端回环，再叠加 Host/Origin；拒绝事件写审计。 |
| R23 | 成立 | log 吞错；认证拒绝/命令失败/逐项批量结果缺失；日志失败不阻止删除。 | 记录拒绝/命令/逐项结果；默认 `auditRequiredForPurge:true`，purge/清空/sweep 在 intent 写入失败时拒绝；可还原操作不被审计故障阻塞。 |
| R24 | 成立（保证不足） | fsync 错误全吞、rename 后无目录 fsync、无完整事务恢复；不能声称整个流程原子。 | 区分平台不支持与真实 I/O 错误；文件+目录 fsync 尽力而为；事务阶段+启动恢复；文档明确 Windows/断电边界。 |
| R25 | 成立 | 列表同步扫描、每个会话 `childCount` O(n²)、`liveness` 每次 list、批量重复扫描。 | 单次扫描/活跃度快照、childCount 预计算、批量 scanHint、有索引时跳过字节遍历、客户端轮询 60s；同步全量扫描仍是边界。 |

### 附加发现

- **只读不是只读**：2.0.0 的 restore/unqueue/repair/recover 仍写盘。2.1.0 全部 `assertEnabled`，只读时阻止。
- **自伤 broken**：还原崩溃会产生永久不可 purge 条目。2.1.0 引入 `restoring-payload`/`restored-payload`、payload-at-target 识别和 force purge。
- **entryId 竞态**：lstat 后 mkdir 非原子。2.1.0 用非递归 mkdir 原子 claim，并在 claim 后检查 payload。
- **回滚假成功**：2.0.0 只看“没抛异常”。2.1.0 验证 payload/投影实际位置，冲突则保留条目。
- **引用静默跳过**：detach/attach 方法缺失/工作区消失会 pending+warning，不再误报。
- **UNC 前缀**：`\\?\UNC\` 之前被剥成相对路径；已修复并加单测。
- **跨卷删除**：2.0.0 返回 500；2.1.0 返回 409 `cross-device`（不隐式复制）。
- **单条 purge 确认词**：仍按 `requireTypedConfirmAt` 阈值（设计如此）；批量/清空强制，强制清理始终要求确认词。
- **同一会话 id 的指纹**：队列校验 createdAt/cwd，回收站 meta 记录 sessionCreatedAt/cwd；清空绑定 entryId 集合。

## 二、交互与体验（U01–U12）

| ID | 判定 | 2.0.0 证据 | 2.1.0 修复 |
| --- | --- | --- | --- |
| U01 | 成立 | 首次 loading 渲染时 consume 清空 armRequest，列表未加载，提示“请在弹窗确认”但无弹窗。 | 请求保留到 ready；TTL 2 分钟；找不到/受保护/过期分别提示；只在成功打开确认后清除。 |
| U02 | 成立（范围较窄） | 首次 loading 渲染在 `blockedLabel` 声明前返回，effect 闭包永久 TDZ；bus 吞异常。 | `blockedLabel` 提前定义；effect 用最新 ref，异常显示提示不再吞掉。 |
| U03 | 成立 | `/list` 无请求序号，旧响应可覆盖新快照。 | `loadSeq` 只应用最新响应。 |
| U04 | 成立 | 批量 200 但全失败仍绿色“已删除 0 条”；逐项原因丢弃。 | 成功/失败/部分结果分级；逐项 details；保留失败选择；“仅重试失败项”。 |
| U05 | 成立 | 回收站 checkbox 与 `purgeableTrash` 绑定，禁止 purge 的条目无法批量还原。 | 选择与 purge 资格解耦；可还原条目可勾选，批量还原与批量 purge 各自过滤。 |
| U06 | 成立 | 遮罩是子元素，root 的 target 判断永不命中；无焦点圈定/恢复；无 max-height。 | 遮罩点击关闭、Tab/Shift+Tab 圈定、关闭恢复焦点、小屏滚动、busy 禁用关闭。 |
| U07 | 成立 | 列表有 childSessionCount，确认框不提子会话孤立。 | 确认描述显示将保留的子会话数量。 |
| U08 | 成立 | 活动 409 只显示错误；free-liveness 行没有 queue 按钮。 | 错误 notice 提供“排入待删除”动作，并显示活动类型。 |
| U09 | 成立 | repairs/sweep/startup/capabilities 未展示；orphan 不可见；无诊断导出。 | 异常条目、修复队列、上次清理、启动恢复、脱敏诊断导出与 repair-refs 按钮。 |
| U10 | 成立 | 全选可超过 maxBatchSize；搜索变化后隐藏选择仍参与批量。 | 全选按上限截断；显示已选/可见/隐藏；超限禁用并提示。 |
| U11 | 成立 | 队列文案暗示自动删除；服务端错误固定中文；有效配置未反映。 | 文案由 processPendingOnStartup 驱动；错误按 code 本地化；策略条显示只读/purge/排队/审计状态。 |
| U12 | 成立（Host 限制） | 自定义 Host 命令描述符无 icon 字段；client contribution 不能与 Host 命令同名。 | Host API 仍不能直接给 `/sessions` 加 icon；2.1.0 用纯视觉的菜单行装饰器（MutationObserver 找到 Host 渲染的 `/sessions` 行并插入 14px 垃圾篓图标），保留全部子命令；上游支持 icon 字段后可删除装饰器。 |

## 三、验证

使用 DSH 自带 Node v24.21.0：

```text
test/selftest.mjs        57 passed / 0 failed
test/paths.mjs           26 passed / 0 failed
test/regression-2.1.mjs  51 passed / 0 failed
test/client-runtime.mjs   7 passed / 0 failed
test/audit.mjs           80 passed / 0 failed
test/sensitive-scan.mjs  no sensitive data found
```

回归测试包含：活动竞态回滚、保护状态未知、严格配置、恢复不删除、投影部分回滚、投影冲突、投影上限、
精确确认集合、createdAt=null、身份不可读、工作区消失、refsPending 清理顺序、损坏存储隔离、提交后失败、
根切换、文件类型/header 身份、session- 子代理、payload 缺失强制清理、junction 根、非回环对端、强审计。

## 四、仍然存在的边界

1. **跨进程活跃竞态**：只有宿主能提供写租约/打开协调；插件把窗口缩到 rename 前后并支持回滚，不能证明互斥。
2. **同权限本地攻击者**：能直接改 `.dsh` 的进程本来就能删文件；插件保证元数据不能放大为任意路径。
3. **Windows 断电持久化**：目录 fsync 不支持；事务阶段+恢复是尽力而为。
4. **同步全量扫描**：已消除 O(n²) 和重复扫描，但超大 profile 仍会阻塞事件循环。
5. **队列身份未知**：历史队列无 createdAt/cwd 时保留，需要人工取消/确认。
6. **U12 图标**：Host 命令描述符仍无 icon 字段；当前用纯视觉装饰器补齐 `/sessions` 行图标，不改变命令行为。上游增加 icon/face registry 后可移除该装饰器。
