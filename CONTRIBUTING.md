# 贡献指南

感谢你愿意改进这个插件。它是一个**零依赖、无构建步骤**的 DSH 插件：`index.js` 是 Host 半身，
`client.js` 是浏览器半身，两者都是手写的纯 JavaScript（ESM / 浏览器模块），改完直接生效。

## 环境要求

- 一个可用的 DSH 安装（本插件面向 `0.2.x` 内核开发；桌面端与 `dsh web` 均可）。
- Node.js `>= 20`（用 DSH 自带的 node 也可以，见下）。
- 不需要 `npm install`：仓库没有任何运行时或开发期依赖。

## 本地开发与安装

内核卸载插件时需要重新装载模块世代，所以**改完代码必须重装**才能看到效果：

```bash
# 安装（<profile> 换成你实际用的 profile，桌面端一般是 desktop）
dsh plugin --profile <profile> add "file:<本仓库绝对路径>"

# 改完代码后
dsh plugin --profile <profile> remove dsh-delete-guard
dsh plugin --profile <profile> add "file:<本仓库绝对路径>"
```

两个必须注意的点：

1. **用 `file:`，不要用 `link:`**。桌面端的启动闸门禁止 profile 目录树里出现符号链接/junction，
   `link:` 会产生 junction 并让应用拒绝启动。`file:` 会按 `package.json` 的 `files` 拷贝成真实目录。
2. **浏览器半身要页面重载**。Host 半身可以热挂载，但侧边栏入口属于页面启动时的插件图，
   最稳妥的验证方式是重启应用（或至少重新加载页面）。

DSH 自带 node 的路径（Windows 桌面端）：

```
<安装目录>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe
```

## 测试

```bash
npm test
```

等价于依次运行三套检查，任何一套失败都会让整条命令失败：

| 文件 | 覆盖内容 |
| --- | --- |
| `test/selftest.mjs` | 在**一次性临时目录**里造一个假 `DSH_HOME`，端到端驱动 Host 半身：列举与标题、工作区目录名编码（含非 ASCII）、活跃拒绝、信任围栏、路径守卫、删除→回收站→还原→彻底删除、`workspace.json` 引用摘除与还原、还原目标防篡改、回收站过期清理、排队与重启后处理、fail-closed、斜杠命令、审计日志。**不触碰任何真实数据。** |
| `test/audit.mjs` | 按内核的装载规则静态审计包：manifest 字段、`./client` 出口、`locale/en.json` 元数据入口、patch 行、两个半身的关键约定、中英字典键集合一致、不 import 内核包、无硬编码绝对路径、接口前缀不越过内核鉴权。 |
| `test/sensitive-scan.mjs` | 发布前的敏感信息扫描：绝对用户路径/家目录、邮箱与主机名、常见密钥形态。可用 `DSM_FORBIDDEN=词1,词2` 追加自定义禁词。 |

## 代码约定

- **零依赖**，只用 Node 内置模块；Host 半身不 import 任何 `@deepseek-ai/*` 包
  （profile 安装的插件无法保证解析到内核包）。
- 浏览器半身只允许 `require('react')`；**不得** import 内核 Client 包（它们会变，
  且一个抛异常的组件会让整个插槽条目崩掉）。
- 只用主题 token（`--dsw-alias-*`、`--dsw-radius-*`）着色，不写字面色值。
- 界面文案必须**中英各一份且键集合一致**（`audit` 会检查）。
- 每个注册（路由、插槽、命令、样式标签）都要有对应的清理函数，挂在 `ctx.effect` 上。
- 错误一律显式返回，不要吞掉；删除相关操作必须写审计日志。

## 改动范围与验收

- 涉及**删除语义 / 活跃判定 / 还原校验 / 信任围栏 / 策略闸门 / 批量与确认词**的改动属于高风险改动：
  请同时补测试，并在 PR 描述里说明"为什么仍然不可能误删或越权"。
- 新增用户可见行为时，请更新 `README.md` 与 `CHANGELOG.md` 的 `Unreleased` 段。
- 版本号遵循语义化版本：破坏行为兼容性的改动升 major。

## 提交 Pull Request

1. 先开 issue 说明动机（小的文档/文案修复可以直接提 PR）。
2. 保持提交粒度小、信息清楚；PR 描述里写清"改了什么、怎么验证的"。
3. 确保 `npm test` 全绿，并且 `node test/sensitive-scan.mjs .` 无命中。
4. 不要提交任何个人路径、机器名、凭据或真实会话内容。

## 报告安全问题

请勿在公开 issue 中披露可被利用的细节。
