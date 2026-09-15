# 大肥鱼养殖基地 v0.2.3

CommandCode / 智谱 BigModel / DeepSeek 多账号统一管理工具，首个开源版本。

## 下载

| 文件 | 大小 | 说明 |
| --- | --- | --- |
| `bigfish-account-farm-Setup-0.2.3.exe` | 78.8 MB | Windows 安装包（NSIS），双击安装，会在桌面和开始菜单创建快捷方式 |
| `bigfish-account-farm-0.2.3-portable.zip` | 110.4 MB | 免安装版，解压后直接运行目录里的 `大肥鱼养殖基地.exe` |

校验值（SHA-256）：

```
97a28567f086c5406eca1cbffa58cfe7d99b4b23056c33874b95426c008fdc4f  bigfish-account-farm-Setup-0.2.3.exe
032872ccabf61ca8ac0c8423041bbd0c3cd21cce5d52b6147e86ed9a8ee1cdaa  bigfish-account-farm-0.2.3-portable.zip
```

安装包未做代码签名，Windows SmartScreen 可能提示"未知发布者"，选「更多信息 → 仍要运行」即可。

**本软件不包含任何账号数据。** 所有账号与凭据只保存在本机 `%APPDATA%\大肥鱼养殖基地\`，不会上传到任何服务器。

## 源码

<https://github.com/384615666/bigfish-account-farm>（AGPL-3.0，美术素材授权见仓库内 `NOTICE.md`）

## 本次亮点

- **三个平台**：CommandCode、智谱 BigModel、DeepSeek 平台隔离管理，互不干扰。
- **三档额度看板**：月剩余 / 周窗口 / 5 小时窗口，含已用、上限、百分比和重置倒计时；详情页带用量趋势迷你图。
- **DeepSeek 余额**：只需官方 API Key 即可直接读余额（CNY / USD、充值 / 赠金、可用状态），不用网页登录。
- **浏览器一键添加**：账号已在浏览器登录时，点书签小工具即可把会话带进软件。
- **会话保活**：启动自动巡检 + 每轮保活自愈，失效会标红提示，到期前一键重登。
- **托盘常驻**：关闭窗口最小化到托盘，后台继续保活 / 刷新。
- **局域网用量页**：可选开启只读用量页，密码登录，方便手机上查看。
- **凭据安全**：会话 Cookie、API Key、账号密码、智谱令牌全部经 Windows DPAPI 加密后落盘。

## 从源码运行

```bash
npm install
npm run build:renderer
npm run start
```

自检：

```bash
npm run selftest   # 主进程模块 + 导入解析 + 会话修复逻辑
npm run smoke      # 无头验证主进程 + 渲染进程 + React 挂载
npm run e2e        # 驱动真实 UI 的端到端检查
```

## 已知限制

- 仅支持 Windows（依赖 DPAPI 加密与 NSIS 打包）。
- `user_...` 开头的智谱 API Key 不能调用网页用量接口（官方返回 `code=1001`），只作为凭据记录备用。
- DeepSeek 今日消费与 Token 用量官方没有仅凭 Key 的接口，详情页提供跳转到官网用量页。
- 会话约 8 天有效，官方不支持远程续期，只能在到期前重新登录一次。

## 许可

代码以 **GNU AGPL-3.0** 发布。应用图标、托盘图标、界面立绘等美术素材不在 AGPL 授权范围内。
