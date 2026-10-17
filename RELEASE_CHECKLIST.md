# 发布清单（推送到 GitHub 之前逐项确认）

这份清单供维护者发布时逐项确认；贡献者与使用者也可以据此了解发布流程、验证方式与质量门禁。**不要在没做完第 1–3 步的情况下公开仓库**。
下面每条命令都在 Windows / PowerShell 与 Linux / bash 下等价；`dsh` 指 DeepSeek Harness CLI。

## 1. 替换占位符

本仓库的账号字段**已经填好**（`shibamalaomushi`）：`package.json` 的 `author` / `repository` / `homepage` /
`bugs`、`README.md` 与 `RELEASE_CHECKLIST.md` 里的安装命令、`CHANGELOG.md` 的 6 条链接、`LICENSE` 的版权行。
换账号或换版本号时按下表确认一遍即可：

| 位置 | 需要确认的内容 |
| --- | --- |
| `package.json` | `author` / `repository` / `homepage` / `bugs` 指向本仓库与你的账号 |
| `README.md` | 安装命令里的账号名与实际 Release 一致（`<profile>` 保持占位，因人而异） |
| `CHANGELOG.md` | 链接里的账号名（6 处）与 compare 范围 |
| `CODE_OF_CONDUCT.md` | 举报通道可用（默认只用 GitHub 私密通道，不写个人邮箱） |
| `LICENSE` | 版权行是你的账号或名字（**不要**写第三方或工具名） |

一次性查一遍还有没有漏：

```bash
grep -rn "<owner>\|<profile>\|维护者联系方式\|OWNER" . --exclude-dir=.git --exclude="*.tgz"
```

## 2. 版权与许可确认

- 确认你同意以 `LICENSE` 中的 MIT 条款发布（若要换协议，同时改 `package.json` 的 `license`）。
- 确认仓库里没有来自他处的、许可不兼容的代码或素材（图标 `icon.svg` 为本项目自绘）。

## 3. 敏感信息扫描（必须为 0 命中）

```bash
node test/sensitive-scan.mjs .

# 再带上你自己的用户名、机器名、真实目录名等词根跑一遍
DSM_FORBIDDEN="你的用户名,你的机器名,你的私有目录名" node test/sensitive-scan.mjs .
```

> 注意：`CHANGELOG.md` 的 2.0.0 段落里**刻意保留了一处旧包名**（更名说明），这是文档而非泄漏；
> 因此自定义禁词里**不要**加入旧名，否则扫描会固定命中这一行。

扫描器会检查：各平台的绝对用户路径与家目录、邮箱、Windows 默认主机名（`DESKTOP-` 加 7 位
大写字母数字）、私钥头、GitHub/Slack/OpenAI/AWS 的 token 形态，以及你追加的自定义禁词。

另外**人工确认**（扫描器只看文本）：

- 有没有把真实会话标题、工作区路径、调试日志、截图一并提交；
- `git status` 里有没有 `.dsh` 之类的运行时目录；
- 有没有 `.tgz` / `node_modules/` 之类的构建产物被误提交（`.gitignore` 已覆盖）。

## 4. 测试全绿

```bash
npm test
```

应看到三套检查依次通过：`selftest`（端到端，在临时目录里跑）、`audit`（静态清单审计）、
`sensitive-scan`（敏感信息扫描）。当前基线：**131 通过 / 57 通过 / 0 命中**。

## 5. 版本与变更记录

- `package.json` 的 `version` 与 `CHANGELOG.md` 的最新条目一致；
- `CHANGELOG.md` 的日期改成实际发布日期，并清空 `Unreleased` 段（或保留新条目）。

## 6. 打出分发用的单文件包

Release 资源用 pnpm 的打包格式（`.tgz`），装的时候不需要 `git`、不需要构建：

```bash
pnpm pack                     # 产出 dsh-delete-guard-<版本>.tgz（约 65 KB）

# 校验和（贴进 Release 说明，方便他人核对）
Get-FileHash dsh-delete-guard-*.tgz -Algorithm SHA256      # Windows
sha256sum dsh-delete-guard-*.tgz                          # Linux / macOS

# 看一眼包内容：应为 9 个文件（package.json / index.js / client.js /
# locale/{zh,en}.json / cordis.patch.yml / icon.svg / README.md / LICENSE）
tar -tzf dsh-delete-guard-*.tgz
```

包内容由 `package.json` 的 `files` 决定；`README.md` 与 `LICENSE` 由打包器自动带上，
`test/` 与仓库文档只在 git 仓库里。**`.tgz` 是构建产物，不要提交**（`.gitignore` 已忽略）。

## 7. 建仓与打标签

```bash
git init
git add -A
git commit -m "feat: dsh-delete-guard 2.0.0"
git branch -M main
git remote add origin https://github.com/shibamalaomushi/dsh-delete-guard.git   # 也可用 SSH 地址
git push -u origin main

git tag -a v2.0.0 -m "dsh-delete-guard 2.0.0"
git push origin v2.0.0
```

> **标签必须有**：安装方式二、以及 Release 资源的 URL 都依赖 tag（`v<版本>`，与 `package.json`
> 的 `version` 一致）。打错标签要删远端再重打：`git push origin :refs/tags/v2.0.0`。

## 8. 创建 Release（上传单文件包）

在 GitHub 上：**Releases → Draft a new release** →

1. **Choose a tag**：选 `v2.0.0`（就是第 7 步推上去的那个）；
2. **Release title**：`v2.0.0`；
3. **Describe this release**：把 `CHANGELOG.md` 里该版本的条目贴进来，并补上下面的说明；
4. **Attach binaries**：把 `dsh-delete-guard-2.0.0.tgz` 拖上去；
5. **Publish release**。

Release 说明建议包含：

```markdown
一行安装（需要 DeepSeek Harness 0.2.0 及以上）：

    dsh plugin --profile desktop add "https://github.com/shibamalaomushi/dsh-delete-guard/releases/download/v2.0.0/dsh-delete-guard-2.0.0.tgz"

装完重启一次应用。SHA256: <把第 6 步的校验和贴在这里>
升级：内核不自动更新第三方插件，先 remove 再 add 一次即可（回收站与日志不受影响）。
```

## 9. 验证两种安装路径

**用一个没装过该插件的 profile 试**（`shibamalaomushi`、版本号换成实际值）：

```bash
# 主路径：Release 单文件包（推荐）
dsh plugin --profile <profile> add "https://github.com/shibamalaomushi/dsh-delete-guard/releases/download/v2.0.0/dsh-delete-guard-2.0.0.tgz"

# 备路径：tag 的源码快照
dsh plugin --profile <profile> add "https://codeload.github.com/shibamalaomushi/dsh-delete-guard/tar.gz/refs/tags/v2.0.0"
```

两种方式都应装成**真实目录**（不是 Junction）——可用 `dsh plugin --profile <profile> list` 或直接看
`<DSH_HOME>/profiles/<profile>/node_modules/dsh-delete-guard` 是否 `LinkType` 为空。
重启应用后确认侧边栏出现「会话管理」并能列出会话。

> 如果你的环境**没有 git**，请务必用上面两条 URL 方式；`github:owner/repo` 形式依赖 `git` 命令。

## 10. 仓库设置

- **About**：填一句描述与 topics（建议 `dsh`、`dsh-plugin`、`deepseek-harness`、`session`、`session-manager`）。
- 开启 **Issues**；`.github/ISSUE_TEMPLATE/` 下的两个模板会被 GitHub 自动识别。
- 开启 **Private vulnerability reporting**（Settings → Security），让 `SECURITY.md` 的通道可用。
- 确认 **Actions** 已启用（`.github/workflows/ci.yml` 会在 Node 20/22/24 与 ubuntu/windows 上跑测试）。
- 可选：为 `main` 加分支保护，要求 CI 通过后再合并。

## 11. 发版之后

- 在仓库首页确认 README 的安装命令能直接复制使用（`shibamalaomushi` 若残留，第一次使用者会失败）；
- 关注 Issues 模板收集到的环境信息；
- 下一版把 `CHANGELOG.md` 的 `Unreleased` 换成 `## [x.y.z] - 日期`，并补齐 compare 链接。

## 12. 发布到 npm（可选，但强烈建议：DSH 应用内搜索靠它）

官方插件管理器只通过 npm registry（`registry.npmjs.org`，回退 `registry.npmmirror.com`）解析包名，
所以**只有发布到 npm，别人才能在 DSH 的「插件」页里搜到并一键安装**；同时各社区市场/目录大多也索引 npm。

```bash
# 1) 先删掉 package.json 里的 "private": true（否则 npm 拒绝发布）
# 2) 核对将要发布的内容（应只有运行所需文件 + README/LICENSE）
pnpm pack && tar -tzf dsh-delete-guard-*.tgz
# 3) 登录并发布（首次需 npm 账号，建议开启 2FA）
npm login
npm publish --access public
# 4) 验证
npm view dsh-delete-guard version
#    再验证应用内安装路径
dsh plugin --profile <profile> add npm:dsh-delete-guard
```

发布后补两件事：

- README 顶部加 npm 版本徽章：
  `[![npm](https://img.shields.io/npm/v/dsh-delete-guard)](https://www.npmjs.com/package/dsh-delete-guard)`；
- 确认国内镜像已同步（`registry.npmmirror.com/dsh-delete-guard` 能返回版本号，通常几分钟内自动同步）。

> 版本号一旦发布不可覆盖：改内容必须**升版本**再发布（`npm version patch|minor` 后再 publish）。
