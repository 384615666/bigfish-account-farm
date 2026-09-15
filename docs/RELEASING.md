# 发布流程（维护者）

给这个项目打一个可下载的发行版，只需要三步：构建 → 传仓库 → 传附件。

## 1. 构建产物

```bash
npm install                 # 首次
npm run tray:icons          # 只有改了立绘才需要
npm run dist                # check:pack + build:renderer + electron-builder --win nsis
```

产物：

- `release\大肥鱼养殖基地 Setup <版本>.exe` —— NSIS 安装包
- `release\win-unpacked\` —— 免安装目录（用来做便携版 zip）

便携版 zip 直接用 `win-unpacked` 打包即可，**打包前记得删掉里面的 `LICENSE.electron.txt`
之外的无关文件不用动，但必须补一份 `使用说明.txt`**（见 `docs/` 下的模板思路）。

## 2. 推送到 GitHub

```bash
git remote add origin https://github.com/384615666/bigfish-account-farm.git
git branch -M main
git push -u origin main
```

仓库只放源码，**不要提交 `release/`**（已在 `.gitignore` 里）。打包产物走 Release 附件。

## 3. 发布 Release

在 GitHub 仓库页面 → Releases → Draft a new release：

- **Tag**：`v0.2.3`（与 `package.json` 的 `version` 一致）
- **Title**：`大肥鱼养殖基地 v0.2.3`
- **说明**：直接粘贴 `docs/RELEASE-NOTES-0.2.3.md` 的内容
- **附件**：上传这两个文件
  - `大肥鱼养殖基地 Setup 0.2.3.exe`
  - `大肥鱼养殖基地-0.2.3-portable.zip`

发布后，README 里 `[Releases](../../releases)` 的链接就会指向下载页。

## 打包前检查清单

- [ ] `npm run selftest && npm run smoke && npm run e2e` 全绿
- [ ] `package.json` 的 `version` 已递增
- [ ] `docs/RELEASE-NOTES-<版本>.md` 已写好
- [ ] 没有把 `data.json` / Cookie / API Key 之类的本机数据带进仓库
  （`git status --ignored` 看一眼，`release/`、`dist-renderer/`、`node_modules/` 应全部在忽略列表里）
- [ ] 安装包未签名是已知情况，Release 说明里要提醒 SmartScreen 提示

## 注意

- `build.nsis.guid` 固定不变，老版本用户装新版本是**覆盖升级**，不会并存两份。
- 应用图标与立绘不在 AGPL 授权范围内，二次分发时要么保留原素材要么换成自己的。

## 提交身份（重要）

GitHub 的 Contributors 是按 **commit 的 author/committer 邮箱**匹配账号的，不是按推送者。邮箱一旦匹配到别人的
GitHub 账号，对方就会出现在你的贡献者列表里。

本仓库历史上踩过这个坑：全局配置里是 `bigfish <bigfish@users.noreply.github.com>`，而 GitHub 上真的存在
用户名 `bigfish`（David Wilhelm，id 34862），于是该项目被算成了他的贡献。已用 `git filter-branch` 重写全部历史修正。

**提交前先确认本地身份**，使用 GitHub 提供的 noreply 邮箱（`<用户ID>+<用户名>@users.noreply.github.com`）：

```bash
git config --global user.name "384615666"
git config --global user.email "45287927+384615666@users.noreply.github.com"
```

改错了要修：

```bash
git filter-branch -f --env-filter '
export GIT_AUTHOR_NAME="384615666"
export GIT_AUTHOR_EMAIL="45287927+384615666@users.noreply.github.com"
export GIT_COMMITTER_NAME="384615666"
export GIT_COMMITTER_EMAIL="45287927+384615666@users.noreply.github.com"
' -- --all
git push --force origin main
git push --force origin refs/tags/<tag>   # tag 也要单独强推
```

注意：GitHub 的贡献者列表有缓存，重写后网页可能要过一段时间（或触发一次统计重算）才会更新；
API `/repos/{owner}/{repo}/contributors` 通常先变对。
