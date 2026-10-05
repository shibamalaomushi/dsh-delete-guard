# dsh-delete-guard

[![CI](https://github.com/shibamalaomushi/dsh-delete-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/shibamalaomushi/dsh-delete-guard/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)


给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）用的**会话管理**插件：
在 Web 界面里**删除单条或批量删除会话**。

> Harness 自带的能力只有「归档」，归档不改动会话正文。本插件默认把删除变成
> **可还原**的操作，并把"能删什么、删到什么程度"变成**显式配置 + 服务端强制**的策略。

```
侧边栏 → 会话管理
├── 安全策略     只读模式 / 禁止彻底删除 / 子代理受保护 / 回收站保留 30 天 / 批量上限 50 条 …
├── 工具条       分类（全部·主会话·子代理·已归档·已置顶·不可删）· 筛选 · 排序 · 全选当前结果
├── 批量条       已选 N 条 · 共 X MB            [移入回收站]  [取消选择]
├── 会话         按工作区分组（可折叠，折叠状态本地记忆）；每行：勾选 · 标题 · 标记 · 大小/时间/id
│                [删除]（可还原，一次确认）  或  使用中 → [排入重启后删除] · [id] 复制
├── 回收站       勾选后 [批量还原] / [批量彻底删除]；[清空回收站]
└── 待删除       排队中的会话，可取消排队
```

## 与同类插件的差异

DSH 生态里已经有不少会话管理与回收站类插件。
（下表依据各插件在 npm 上的公开描述整理。）

| 能力 | 本插件 | 常见的会话管理 / 回收站插件 |
| --- | --- | --- |
| 删除默认进回收站、随时还原 | ✅ | 部分有 |
| 回收站保留期与自动清理（`trashKeepDays`） | ✅ | 少见 |
| **可配置的删除策略，服务端强制（10 项）** | ✅ 只读模式、禁止彻底删除、子代理保护、置顶/归档保护、永不删除名单、批量上限、确认阈值、确认词 | **基本没有** |
| 分级安全确认（按严重度加摩擦） | ✅ 可还原的操作不加摩擦；不可恢复的要求输入确认词 | 一般是固定的二次确认 |
| 全程审计日志 | ✅ `<DSH_HOME>/session-manager/log.jsonl` | 少见 |
| 批量与多入口 | ✅ 侧边栏面板 / 会话行悬停 / 右键菜单 / `/sessions` 命令 | 部分有 |
| 活跃会话保护 | ✅ 正在使用的会话拒绝删除，可排入重启后删除 | 部分有 |
| 不联网、不读任何凭据 | ✅ | — |


## 三个入口，同一套闸门

| 入口 | 位置 | 行为 |
| --- | --- | --- |
| **面板** | 侧边栏「会话管理」 | 分类 / 筛选 / 排序 / 批量 / 回收站，功能最全 |
| **会话行悬停按钮** | 侧边栏会话行 | 点一下 → 打开面板并对该条弹出确认 |
| **会话行右键菜单** | 侧边栏会话行菜单 | 同上（`删除会话…`） |
| **斜杠命令** | 输入框 | `/sessions list \| trash \| delete <id> \| delete-batch <id1,id2> \| queue \| unqueue \| restore \| purge \| purge-all PURGE` |

行内两个入口**只把目标交给面板确认，不自行删除**：这样只有一个确认界面、一套安全语义，
也不会在别人的列表里留下"删了但行还在"的残影。

## 功能

- **批量删除**：勾选任意条（或被筛出的全部）→ 移入回收站；逐条独立结算，被拦下的条目不会拖垮其它条目，
  结果里能看到每条的成功/失败原因。
- **分级安全确认**（依据 [GitLab Pajamas · Destructive actions](https://design-gitlab-com-gitlab-org-gitlab-services-f6beaf2fb7fd4cad76.gitlab.io/patterns/destructive-actions/)）：
  - 可还原的操作（移入回收站）→ **不加摩擦**，只弹出"将影响哪些"的清单确认（低严重度）。
  - 不可恢复的操作（彻底删除）→ 弹窗 + **危险按钮**，并明确写出"不可恢复"。
  - 且会连带删除附加资源（正文 + 投影缓存 + 侧边栏引用）→ 条数达到阈值时**要求输入确认词**
    （默认 `PURGE`，可配）。
  - 清空回收站属于最高严重度 → **无论几条都必须输入确认词**。
- **策略与范围控制**（服务端强制，见下表）：只读模式、禁止彻底删除、子代理会话可否删除、
  置顶/归档是否算受保护类别、永不删除的 id 名单、单次批量上限、确认词阈值与确认词本身。
- **分类与筛选**：按主会话 / 子代理 / 已归档 / 已置顶 / 不可删分类；按标题、工作区或 id 筛选；
  按更新时间 / 大小 / 标题 / 工作区排序；每行与每组都能折叠（折叠状态记在本地）。
- **使用中的会话拒绝删除**，给出两条出路：切换到别的会话，或**排入重启后删除**（下次启动自动进回收站）。
- **回收站**：可还原、可彻底删除、可清空；按保留期自动清理（默认 30 天）。
- **可追溯**：所有动作写审计日志；界面底部直接显示会话根目录、插件数据目录与审计日志路径。
- 中英双语界面，只用 `--dsw-*` 主题 token 着色，随明暗主题。

## 安全模型

1. **只删目标那些**：会话 id 需匹配严格格式，且必须是 `<DSH_HOME>/sessions/<工作区>/` 下的直接子目录；
   目录里**必须真的装着会话日志**（`session*.jsonl[.zstd]`）——会话根下若出现非会话目录，既不列出也拒绝删除。
2. **默认进回收站**：同一磁盘卷内的原子 `rename`，条目带 `meta.json` 记录原路径，随时可还原。
3. **还原目标强校验**：还原前重新验证 `meta.json` 里记录的原路径确实落在会话根目录内、目录名等于会话 id、
   投影缓存路径落在缓存目录内；任一条不满足就拒绝（元数据可能被外部改动）。
4. **活跃判定用内核权威数据**：`ctx.sessions.get/list`，并额外咨询内核自己的 `workspace/session-activity`
   waterfall（回合 / 后台任务 / 子代理 / 定时任务）；**判不出来时一律拒绝删除**（fail-closed）。
5. **策略闸门服务端强制**：界面禁用只是提示，真正的拒绝发生在 Host；策略违规**先于参数校验**返回，
   不会被"条数过期"之类的错误掩盖。**单条删除、批量删除、彻底删除、清空回收站、列表标记共用同一套
   判定函数**，所以不存在"某条路径漏判"；清空回收站会跳过受保护与无法归属的条目并如实报告跳过数量
   （不会为了"清空"而销毁受保护的数据）。
6. **批量请求有数量证明**：批量删除/彻底删除要求 `confirmCount` 与实际条数一致；清空回收站还要求
   条数与界面显示一致（防止"界面看到 2 条、实际已变成 30 条"的 TOCTOU），并要求输入确认词。
   **排队（重启后删除）同样过策略闸门**；因策略而永久失败的排队项会在下次启动被丢弃，并在启动报告里
   标明 `dropped` 与原因，不会变成每次启动都白跑一遍的僵尸任务。
7. **引用一并清理**：`<DSH_HOME>/storages/workspace.json` 里这些会话的引用被深度摘除（数组删元素、
   标量置空、以 id 为键的映射整条删除，不依赖字段名）；改写前留 `.bak`，改写后回读校验。
8. **不做格式耦合**：整目录移动，`session.v4.jsonl.zstd` 还是将来的 `vN`、压缩还是明文都一样处理。
9. **HTTP 接口带信任围栏**：只接受回环 Host + 同源请求，拒绝 `Sec-Fetch-Site: cross-site` 与异源 `Origin`；
   校验器自身出错一律 fail-closed；宿主 `connection` 栅栏可用时额外委托它。接口不使用 `/api` 前缀，
   避免因"最长前缀匹配"越过内核自身的鉴权。
10. **全程审计**：所有动作（含被拒的批量请求）写 `<DSH_HOME>/session-manager/log.jsonl`。

## 策略配置

在 profile 的 `cordis.patch.yml` 里给这一行加 `config`（全部可选，下面是默认值）：

```yaml
- id: dsh-delete-guard
  config:
    enabled: true               # false = 只读：面板仍可看，但任何删除都被拒绝
    allowPurge: true            # false = 禁止彻底删除（回收站只能还原，不能清空）
    allowSubagentDelete: true   # false = 子代理会话不可删
    protectPinned: false        # true = 已置顶的会话不可删（需先取消置顶）
    protectArchived: false      # true = 已归档的会话不可删（需先取消归档）
    protectedSessionIds: []     # 永不删除的会话 id 名单
    maxBatchSize: 50            # 单次批量操作上限
    requireTypedConfirmAt: 3    # 彻底删除达到几条时开始要求输入确认词
    purgeConfirmWord: PURGE     # 确认词本身
    trashKeepDays: 30           # 回收站保留天数；0 表示永不自动清理
```

界面顶部的「安全策略」一排标签就是当前生效的策略（例如开了只读模式会显示红色 `只读模式`）。

## 动了哪些文件

| 路径 | 作用 |
| --- | --- |
| `<DSH_HOME>/sessions/<工作区>/<会话id>/` | 会话正文（整目录移动 / 还原） |
| `<DSH_HOME>/storages/session_projcache/sessions/<会话id>.json`（及 `.bak.*`） | 投影缓存（一并移动；删掉会按需重建） |
| `<DSH_HOME>/storages/workspace.json` | 侧边栏引用（摘除 / 还原） |
| `<DSH_HOME>/session-manager/` | 插件自己的回收站、排队表、审计日志（目录名沿用 `session-manager`：改名或升级都不会丢数据） |

除此之外不读写任何位置；插件不联网、不读取任何凭据。

## 安装

**方式一：Release 的单文件包**

```bash
dsh plugin --profile <profile> add "https://github.com/shibamalaomushi/dsh-delete-guard/releases/download/v1.3.1/dsh-delete-guard-1.3.1.tgz"
```

**方式二：从 tag 的源码快照**

```bash
dsh plugin --profile <profile> add "https://codeload.github.com/shibamalaomushi/dsh-delete-guard/tar.gz/refs/tags/v1.3.1"
```

**方式三：从本地目录**

```bash
dsh plugin --profile <profile> add "file:<本目录绝对路径>"
```

> 注意用 `file:`，**不要用 `link:`**：`link:` 会产生 Junction/符号链接，桌面版会拒绝加载。

三种方式装出来都是**真实目录**，装完**重启一次应用**——内核在启动时装载插件的模块世代
与浏览器半身。上面的路径里 `<profile>` 换成你使用的 profile 名（桌面版通常是 `desktop`）。

> 从 `.tgz` 或 tag 快照安装时，包里只含运行所需文件（`index.js`、`client.js`、`locale/`、
> `icon.svg`、`cordis.patch.yml`、`README.md`、`LICENSE`）；`test/` 与文档只在 git 仓库里，
> 想跑自测请克隆仓库。

## 卸载

```bash
dsh plugin --profile <profile> remove dsh-delete-guard
```

卸载只移除插件本身；`<DSH_HOME>/session-manager/` 是插件数据目录（回收站与日志），按需自行删除。

## 已知边界

- **活跃判定的时效**：`ctx.sessions` 反映当前进程。内核不提供该读数时界面会显示「无法判定」，
  删除退化为"排入重启后删除"——刻意保守。
- **跨进程占用无法探测**：Windows 上内核的会话写租约是"具名内核信号量、无文件痕迹"（内核文档明确如此），
  第三方插件无法可靠探测，也不应去探测。因此"另一个 DSH 实例正在写同一条会话"只能靠排队到重启后执行规避。
- **内核的记账可能被它自己写回**：`workspace.json` 的 `sessionIds` 由内核在内存中持有并在下次变更时整体落盘，
  插件摘除的悬空 id 可能被写回。内核读列表时会按实际存在的会话过滤，因此不影响正确性。
- **回收站不跨卷**：`rename` 要求回收站与会话根在同一磁盘卷（默认都在 `<DSH_HOME>` 下）。
- **无法归属的回收站残留不会被自动清除**：条目目录里若没有可读的 `meta.json`（例如异常断电、或外部改动），
  插件既不列出、也不参与"清空回收站"（保守：不销毁无法归属的东西），只会在结果里报为 `orphan`。
  真要清理请手动删除 `<DSH_HOME>/session-manager/trash/<条目目录>`。
  新版已把 `meta.json` 提前到正文之前落盘，因此**正常路径不会再产生**这类残留。
- **行内入口不改内核列表**：悬停按钮/右键菜单只打开面板确认；删除后侧边栏行由内核自己刷新。
- **界面文案随系统语言**：只内置 `zh` 与 `en`。

## 兼容性

- 面向 DSH `0.2.0` 系列内核开发与验证（`dsh-base` + `dsh-web-app` 组合）。
- 插件只使用 Node 内置模块与内核公开服务（`webServer`、`sessions`，可选 `commands`、`connection`），
  不 import 任何 `@deepseek-ai/*` 包，因此对内核版本升级不敏感。
- 浏览器半身遵循内核 Client 插件约定：`__ModuleLoader__` 惰性工厂、`sidebar.panellist` + root 作用域
  `main` 键控插槽、`sidebar.workspaces.session.row.action` / `.menu.item` 会话行插槽、只使用 `--dsw-*`
  主题 token、不 import 内核 Client 包。

## 设计依据

- 破坏性操作的摩擦分级：低严重度（可还原）不加摩擦（尤其批量场景）；中/高严重度用弹窗 + 危险按钮；会连带删除附加资源时
  要求输入对象名确认。
- 弹窗行为对齐宿主：`role="dialog"` + `aria-modal`、`Esc` 关闭、点击遮罩关闭、打开时聚焦（有确认词则聚焦输入框）。
- **视觉只使用主题 token**，并且按内核设计系统的原样度量实现，不 import 任何内核 Client 包：

  | 位置 | 对齐依据（内核产物） | 采用的度量 |
  | --- | --- | --- |
  | 会话行悬停按钮 | `dsh-client-ui-workspace` 的 `.iconButton`（archive / pin 用的是同一套） | 16×16 盒子、`--dsw-radius-xs`、`--dsw-alias-label-tertiary` → hover `--dsw-alias-label-primary`（**只变色、不加背景**）、图标 14px |
  | 悬停气泡 | `dsh-client-ui-primitives` 的 `Tooltip` | `position: fixed`、`side=bottom` + `align=end`、`delayMs=500`、`gap=8`、`--dsw-alias-tooltip-bg`、`3px 7px`、`--dsw-radius-sm`、13/20 |
  | 会话行菜单项 | 同一插槽的 `MenuItemButton`（rename / fork / archive 用的是同一套） | `itemWrap > button[role=menuitem] > itemIcon + itemLabel`、`min-height:34px`、`padding:6px 8px`、`gap:6px`、13/20、`--dsw-radius-md`、图标 14px 用 `--dsw-alias-menu-icon`、危险行用 error 色 + `--dsw-alias-interactive-bg-hover-danger` |
  | 确认弹窗 | `Modal` + `RiskConfirmation` | `--dsw-alias-bg-mask-1` 遮罩、`--dsw-radius-panel`、`--dsw-alias-bg-layer-2`、`--dsw-elevation-prominent`、宽 380（带清单时 440）、header `22px 14px 12px 24px`、标题 16/24 w500、正文 14/22、footer 右对齐 `gap:8px`、取消/确认 `min-width: 72 / 136`、warning 图标 18px 用 error 色 |
  | 图标 | `IconTrashOutlineRegular` / `IconWarningOutlineRegular` / `IconCloseOutlineRegular` | 16 viewBox、1px 描边、`currentColor`，路径逐字复制 |
  | 插件列表图标（icon.svg） | 内建插件的 icon.svg（如 dsh-experimental-auto-review / dsh-experimental-voice-input-bundle） | 36×36、无底板块、**填充式图形 + 单一蓝色线性渐变**、细节用白色描边、图形居中（上下边距 6/6） |

- **一处有意的偏离**：设计系统的 `Button` 没有 danger 变体（危险语义由 `RiskConfirmation` 的 warning 承担），
  所以确认弹窗里的确认按钮用 `primary`、由 warning 图标承担危险提示——与内核一致；列表里的「彻底删除」
  按钮用 error 色文字 + 危险 hover 填充（与内核菜单的危险行同源）。
  所有这些类名都是插件自己的（`dsm-` 前缀），只引用 `--dsw-*` / `--dsh-*` 变量，不依赖内核私有 API。

## 开发与测试

```bash
npm test     # = node test/selftest.mjs && node test/audit.mjs . && node test/sensitive-scan.mjs .
```

- `test/selftest.mjs`：在**一次性假 DSH_HOME** 上端到端驱动 Host 半身，覆盖列举与标题、工作区目录名编码
  （含非 ASCII）、子代理会话、诱饵目录、活跃拒绝、信任围栏、路径守卫、删除→回收站→还原→彻底删除、
  引用摘除与还原、还原目标防篡改、回收站过期清理、排队与重启后处理、fail-closed、斜杠命令、**批量三种操作**、
  **策略闸门（只读 / 禁彻底删除 / 子代理 / 置顶 / 归档 / 名单 / 批量上限）**、**确认词与 TOCTOU**、审计日志。
  不触碰任何真实数据。
- `test/audit.mjs`：按内核装载规则静态审计包（manifest、`./client` 出口、locale 元数据、patch 行、
  半身约定、入口数量、字典键集合一致、无内核包 import、无硬编码绝对路径、接口前缀不越过内核鉴权）。
- `test/sensitive-scan.mjs`：发布前的敏感信息扫描（绝对用户路径/家目录、邮箱、主机名、密钥形态，
  可用 `DSM_FORBIDDEN=词1,词2` 追加禁用词）。

## 许可证

MIT，见 [LICENSE](LICENSE)。
