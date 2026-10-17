# 安全策略

## 支持版本

| 版本 | 是否接收安全修复 |
| --- | --- |
| 2.0.x | 是（当前版本；适配 DSH 0.2.1-rc.2） |
| 1.3.x | 否（请升级；2.0.0 修复了回收站元数据路径覆盖、自动清理绕过策略、还原路径链接/跨盘绕过、批量误报、确认词缺口、workspace 直接改写等问题） |
| < 1.3 | 否 |

## 如何报告漏洞

**请不要在公开 issue、讨论区或社交平台上披露可被利用的细节。**

优先使用 GitHub 的私密漏洞报告：

1. 打开仓库的 **Security** 标签页；
2. 选择 **Report a vulnerability**（私密安全公告）；
3. 写清：受影响版本、复现步骤、影响面，以及你认为的修复方向（可选）。

如果该入口不可用，请先开一个**不含利用细节**的 issue，请维护者提供私下沟通渠道。

我们会在确认问题后尽快回复，并在修复发布后（经你同意）于 CHANGELOG 中致谢。

## 威胁模型

这个插件的职责就是**删除磁盘上的文件**，因此下列问题一律按安全缺陷对待：

- **误删**：删除了非目标会话、删除了目录之外的路径、符号链接/junction/路径穿越导致删到别处。
- **越权**：非本机的、或来自其它站点（跨站）的请求能够触发删除或读取列表。
- **删除正在使用的会话**：导致数据损坏或内容被写句柄重建。
- **删除仍有后台工作的会话**：回合、子代理、后台任务或定时提醒仍在运行时被移走。
- **还原越界**：`meta.json` 被篡改后，还原把文件写回会话根之外的位置。
- **自动清理绕过策略**：只读、禁用彻底删除、受保护会话的回收站内容被自动销毁。
- **元数据放大**：可篡改的回收站元数据被当作真实路径，放大为任意目录删除。
- **不可恢复**：本该进回收站的删除被执行成了不可恢复的删除；或确认规则只在界面生效。

### 设计上的防线（可作为评审基准）

1. 目标是真实会话根下的直接子目录，目录名匹配严格格式，且目录里真的装着会话日志
   （`session*.jsonl[.zstd]`）。会话根默认取 `ctx.sessionPersistence.root`，也可用 `config.sessionsRoot`
   显式覆盖；不再重实现 0.2.1 的 projectKey。
2. 删除默认是**同一卷内的原子 `rename` 到回收站**，条目带 v2 `meta.json`；「彻底删除」需显式调用。
3. **回收站条目目录永远由目录项推导**：`meta.json` 的 `dir`/`entryId` 不能改变实际路径；meta 必须与
   `entryId`/`sessionId` 一致，否则按 orphan 跳过。
4. **所有路径做真实校验**：先词法检查，再 `realpath` + 逐层 `lstat`；拒绝 symlink/junction 祖先、跨盘
   绝对路径、悬空链接目标；还原目标只用 `workspaceSlug + sessionDirName` 重建，`originalPath` 只做一致性校验。
5. 活跃判定使用内核权威读数（`ctx.sessions`），并咨询 `workspace/session-activity`（回合、后台任务、
   子代理、定时任务）；有 workspace 注册表但活动读数失败时 **fail-closed**。单条、批量、命令、排队执行
   共用同一道闸门。
6. 所有写操作优先委托宿主的 `connection.requestRejection`（0.2.1 支持 trustedHosts/TLS/认证）；不可用时
   回退到回环 Host + 同源校验，拒绝 `Sec-Fetch-Site: cross-site`、异源与 `Origin: null`；校验器自身出错
   按拒绝处理。
7. HTTP 接口不使用 `/api` 前缀，避免因"最长前缀匹配"越过内核自身的鉴权。
8. **策略闸门在服务端强制**：`enabled`、`allowPurge`、`allowSubagentDelete`、`protectPinned`、
   `protectArchived`、`protectedSessionIds` 全部由 Host 判定，界面禁用只是提示；策略违规先于参数校验返回。
   单条删除、批量删除、彻底删除、清空回收站、自动清理、列表标记共用同一判定函数
   （`policyBlockForId` / `trashPolicyRejection`）。
9. **自动清理也是删除**：超期清理逐条过策略；只读/禁彻底删除/受保护/子代理/归档/置顶/orphan/不完整/
   损坏条目一律跳过并报告。
10. **确认规则完整服务端强制**：单条 `/purge`、批量 purge、清空回收站都按 `requireTypedConfirmAt` 校验
    确认词；批量动作有 `confirmCount` 证明；清空回收站额外做条数 TOCTOU 校验。
11. **不可归属的东西不销毁**：回收站条目若没有可读且一致的 `meta.json`，既不列出也不清除，只报为
    `orphan`；正常路径不会产生这类残留（meta 在正文之前落盘）。
12. **0.2.1 引用走注册表**：通过 `ctx.workspaceRegistry` 的 detach/attach/archive/pin 更新；不直接改写
    storage-json 的 `workspace.json`（single 布局以内存为权威，外部改写会被覆盖并可能损坏领域）。
13. 所有动作写审计日志；日志有大小上限与轮转，单行有上限，写失败通过 `/list` 暴露。
14. 所有变更操作串行化；路径校验与目标不存在检查在 rename 前复查。

## 数据面

- 插件**不联网**：没有任何出站请求。
- 插件**不读取凭据**：不涉及 `.credentials.yaml`、环境变量里的密钥、浏览器 cookie。
- 只读写：会话根（默认 `<DSH_HOME>/sessions/**`）、`<DSH_HOME>/storages/session_projcache/**`、
  `<DSH_HOME>/storages/workspace.json`（仅无 workspaceRegistry 的兼容回退），以及插件自己的数据目录
  `<DSH_HOME>/session-manager/**`（回收站、排队表、修复队列、审计日志）。
- 回收站里的内容仍然是你的会话正文，只是换了位置；清空回收站才会真正抹掉。

## 不算安全问题的已知边界

- **本地同权限攻击者**：能直接写 `.dsh` 的攻击者本来就能直接删文件；本插件不承诺用 HMAC 防住这种
  同权限攻击。它保证的是"可篡改元数据不会被放大成任意路径删除/写入"。
- **跨进程占用无法探测**：Windows 上内核的会话写租约是"具名内核信号量、无文件痕迹"，第三方插件无法
  可靠探测，也不应去探测。因此"另一个 DSH 实例正在写同一条会话"只能靠「排入重启后删除」规避。
- **0.2.1 workspace 以内存为权威**：直接改 `workspace.json` 不会即时被宿主看见，下一次宿主写入会覆盖。
  插件的 0.2.1 主路径是 `workspaceRegistry`；旧文件回退仅用于没有注册表的组合。
- **回收站不跨卷**：`rename` 要求回收站与会话根在同一磁盘卷；跨卷时返回明确错误，不做复制降级。
- **TOCTOU**：同用户进程在路径检查与 `rename` 之间抢建 junction/symlink 的赛跑无法用普通 Node API
  完全消除；插件会在检查后、rename 前复查，但这属于本地写权限边界。
- **`DSH_HOME` 启动环境**：插件按官方 `@deepseek-ai/dsh-home-paths` 的优先级解析并优先使用
  `sessionPersistence.root`，但宿主进程启动时已被恶意设置的 `DSH_HOME` 属于宿主信任边界，插件无法完全
  修复；可用 `config.dshHome`/`config.sessionsRoot` 显式固定。
- **父会话与子会话**：插件不级联删除子会话；删除父会话时子会话日志会保留为孤立记录。UI 会显示
  `childSessionCount` 警告，确认弹窗中也会提示。
