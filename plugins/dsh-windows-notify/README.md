# dsh-windows-notify

DeepSeek Harness 的 Windows 原生通知插件。任务完成后在桌面右下角弹出系统 Toast，显示应用名、图标、会话标题和结果摘要；通知内可以直接输入内容并点“回复”，回复走 Harness 现有的 `sessionController.prompt` 消息入口；点击通知正文会激活应用并打开对应会话。

> 仅支持 Windows。通知外观完全由 Windows Action Center 绘制，不使用 HTML 浮层或自绘窗口。

## 兼容性检查结果

| 项目 | 实际值 |
|---|---|
| 应用 | DeepSeek Harness Desktop `0.2.1-rc.2` |
| 桌面框架 | Electron `44.7.0`（主进程 ESM，`app.asar`） |
| Host | 独立 Node 24 子进程（`@deepseek-ai/dsh-desktop-host`），插件 Host 半部在这里运行 |
| Web UI | React + Cordis Client 插件，运行在 `dsh-app://app/` 页面 |
| Windows | 本机 Windows 11 25H2（10.0.26200）；Electron 44 需要 Windows 10 22H2 及以上 |
| 打包 | NSIS 当前用户安装（`DeepSeek Harness.exe` + `resources/app.asar`），无 MSIX/包身份 |
| 通知方案 | Win32 桌面 Toast：AUMID + 开始菜单快捷方式 + `INotificationActivationCallback` COM 本地服务器 |

因为应用是未打包（无 Package Identity）的 Electron 应用，不能用 Windows App SDK 的 `AppNotificationManager` 直接获得文本输入/回复回调（还会引入 .NET/WinAppSDK 运行时）。这里采用系统自带的 WinRT Toast API + 一个很小的 C# COM 激活器；PowerShell 只负责生成并调用 Toast，外观仍是 Windows 系统通知。

## 实现结构

```text
plugin-index/plugins/dsh-windows-notify/
├─ package.json                 # 组合包 + dsh.client
├─ cordis.patch.yml             # 插入 windows-notify 行
├─ lib/index.js                 # Host：监听回合完成、令牌、回复、打开会话、冷启动 spool
├─ lib/client.js                # Client：上报前台/可见状态，轮询待打开会话
├─ lib/show-toast.ps1           # WinRT Toast（系统通知 UI，含输入框和回复按钮）
├─ lib/dsh-toast.exe            # COM 本地服务器 + 注册/诊断命令行（预编译）
├─ lib/dsh-toast.cs             # 激活器源码（不参与运行时，便于审计/重编译）
├─ icon.svg / icon.png          # 插件展示图标与开发回退通知图标
├─ locale/en.json, zh.json
├─ dsh-index.json
└─ README.md
```

### 通知与回复链路

1. `agent/status` 从 `running` 变为 `idle` 后，Host 读取该会话最后一个 `turn/end`；只有 `completed` / `max-tokens` 才通知，跳过 subagent 和 aborted/error。
2. 标题取 `sessionTitle`（没有则用工作目录名），摘要取该回合最后一条 assistant 文本，去掉 Markdown、压缩空白并截断。
3. Host 生成随机 token，把 `token -> sessionId` 写入用户私有状态文件，然后调用 `show-toast.ps1`；token 是 Toast 参数里唯一的内容，**不包含 session id、标题、摘要或回复文本**。
4. Toast XML：`ToastGeneric`、应用图标、标题、摘要、`<input id="reply">`（占位“输入回复…”）和“回复”按钮（`hint-inputId="reply"`）。正文和按钮都走 COM 前台激活。
5. 点击“回复”：COM 激活器读取 `UserInput["reply"]`，通过 `127.0.0.1` 上带随机密钥的桥接 POST 给 Host；Host 校验 token 后调用 `ctx.sessionController.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text }] })`，这就是 Web 客户端使用的同一消息入口。
6. 点击正文：激活器 POST `action=open`，然后启动 `dsh://open` 激活/聚焦应用；Host 把待打开会话放入队列，Client 轮询到后调用 `ctx.uiWorkspace.openSession(sessionId)`。
7. 前台/后台/最小化：Client 每 5 秒上报 `{focused, visible}`。窗口在前台且可见时默认不弹通知；切到后台或最小化后弹。窗口是否聚焦由页面 `document.hasFocus()` / `document.visibilityState` 决定。
8. 进程未运行：激活器写 `pending/*.pending` spool 文件并启动应用；Host 启动后扫描 spool，重新执行回复或打开。重复回复按 token 去重（内存 + 状态文件），桥接返回 409 时激活器视为已处理，不会重复发送。
9. 系统通知被禁用：`show-toast.ps1` 先读 `ToastNotifier.Setting`；只有 `Enabled` 才显示。非 `Enabled` 会返回 `ok:false` 和具体 setting，Host 记录警告且不会报告成功。首次从未显示过 Toast 的桌面 AUMID 可能返回空 Setting，这是 Windows 的正常状态；此时会尝试 `Show`，成功后 Setting 变为 `Enabled`。

### 应用身份

- AUMID：`com.deepseek.dsh.notify`
- CLSID：`7d3c2a64-9f1b-4e58-9c7a-3b5e1d2f8a60`
- 开始菜单快捷方式：`%APPDATA%\Microsoft\Windows\Start Menu\Programs\DeepSeek Harness\Notifications.lnk`
- 注册表（HKCU）：
  - `Software\Classes\AppUserModelId\com.deepseek.dsh.notify`（DisplayName、IconUri、CustomActivator）
  - `Software\Classes\CLSID\{7d3c2a64-...}\LocalServer32` 指向部署后的 `dsh-toast.exe`

使用独立 AUMID 而不是应用自身的 `com.deepseek.dsh`，避免覆盖 Electron 自己的通知激活器。代价是 Windows 通知设置里可能出现第二个“DeepSeek Harness”通知条目；开始菜单里会出现 `DeepSeek Harness\Notifications` 快捷方式（用于让桌面 Toast 找到 AUMID 和激活器）。

## 提示音

任务完成的通知音可以选音效，也可以静音。配置写在 profile 的 `cordis.patch.yml`（`C:\Users\<你>\.dsh\profiles\<profile>\cordis.patch.yml`）：

```yaml
- id: windows-notify
  name: dsh-windows-notify
  config:
    sound: true
    soundEffect: mail   # default | none | im | mail | reminder | sms | generic
```

| 值 | 效果 |
|---|---|
| `default` | 使用 Windows 为「通知」配置的系统声音（默认行为） |
| `none` | 静音 |
| `im` | `Notification.IM` |
| `mail` | `Notification.Mail` |
| `reminder` | `Notification.Reminder` |
| `sms` | `Notification.SMS` |
| `generic` | `Notification.Default` |

- `sound: false` 等价于 `soundEffect: none`；`sound: mail` 这种直接写字符串的写法也兼容。
- 音效通过 Toast XML 的 `<audio src="ms-winsoundevent:…"/>` 播放，只影响本插件的通知，不改变系统「声音」方案或其他应用。
- 未知的 `soundEffect` 值回退到 `default`。
- 修改后重启 DeepSeek Harness（或使用菜单里的「重启应用与 Host」）生效；`show-toast.ps1` 会在 Host 启动时重新部署到 `%LOCALAPPDATA%\DeepSeekHarness\desktop-notify\bin\`。

## 安装

在 DSH 的插件管理中安装本文件夹，或使用插件市场索引。安装后 Host 会自动：

1. 把 `dsh-toast.exe`、`show-toast.ps1`、回退图标复制到  
   `%LOCALAPPDATA%\DeepSeekHarness\desktop-notify\bin\`（避免从受限工作区/只读 profile 直接执行）；
2. 运行 `dsh-toast.exe --register ...`，写入 HKCU 并创建开始菜单快捷方式；
3. 探测系统通知设置，写 `diagnostics.json`。

> **安装后请重启一次 DeepSeek Harness（或使用菜单里的“重启应用与 Host”）**。Desktop 主进程只在 Host 启动时收集一次 Client 注入表；插件在运行中安装时，Host 侧（通知、回复、注册）已经生效，但 Client 侧（前台状态上报、点击正文打开会话）要等一次应用/Host 重启（至少刷新页面）后才会加载。若只重载页面而没有重新收集注入，`presence` 会一直是 0，通知仍会弹，但点击正文不会自动切会话。

这样即使插件源码位于受限工作区，激活器和 PowerShell 也在用户目录下以 Host 的完整性级别运行。

### 如果自动注册失败

`diagnostics.json` 会记录具体错误（例如 HKCU 写入被拒绝，说明 Host 跑在低完整性/AppContainer 中）。在普通用户终端（不是受限沙箱）执行一次：

```powershell
$bin = "$env:LOCALAPPDATA\DeepSeekHarness\desktop-notify\bin"
& "$bin\dsh-toast.exe" --register `
  "com.deepseek.dsh.notify" `
  "C:\Users\<你>\AppData\Local\Programs\DeepSeek Harness\resources\icon.png" `
  "C:\Users\<你>\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe" `
  "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\DeepSeek Harness\Notifications.lnk"
& "$bin\dsh-toast.exe" --status
```

然后重启 DSH 或在插件管理里禁用/启用一次本插件。

## 运行与打包

本插件不需要构建步骤，安装即可运行。`dsh-toast.exe` 是预编译的 .NET Framework 4.8（Windows 自带）控制台程序，源码在 `lib/dsh-toast.cs`。重新编译：

```powershell
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" `
  /nologo /target:exe /platform:anycpu /optimize+ `
  /out:lib\dsh-toast.exe /r:System.dll /r:System.Core.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll lib\dsh-toast.cs
```

发布到插件索引时，整个 `plugins/dsh-windows-notify/` 文件夹即可直接安装；`package.json` 的 `files` 已列出运行所需文件。`icon.svg`/`icon.png` 为自制图标。

## 验证步骤

1. **通知展示**：在 DSH 里发一个需要一会儿的任务，切到别的窗口/最小化，等任务完成。右下角应出现 Windows 原生 Toast，包含应用图标、会话标题、摘要、输入框（占位“输入回复…”）和“回复”按钮。
2. **直接回复**：在 Toast 输入框输入内容，点“回复”。DSH 对应会话应收到一条用户消息；重复点击/重复激活不会重复发送。
3. **点击跳转**：点击通知正文，DSH 应被激活到前台并打开对应会话。
4. **前台抑制**：窗口保持前台聚焦时完成任务，不应弹通知；切后台/最小化后再完成任务会弹。
5. **禁用系统通知**：Windows 设置 → 系统 → 通知，关闭本应用或全局通知；再次完成任务。`diagnostics.json` / `/status` 的 `lastDelivery.ok` 应为 `false`，日志说明 setting，不会误报成功。
6. **进程未运行**：退出 DSH 后点击 Action Center 里仍保留的旧通知正文或“回复”。本次实现会 spool 并在下次启动时处理；注意这依赖 Action Center 保留通知和 COM 激活器正常工作。
7. **诊断**：`%LOCALAPPDATA%\DeepSeekHarness\desktop-notify\diagnostics.json` 有注册/设置/最近一次投递结果；`activator.log` 有激活器日志（不记录回复正文）。

## 已实测 / 未实测（本次环境）

已实测：

- 插件安装、Host/Client 半部启用，Host bridge 在 `127.0.0.1` 随机端口监听；
- `dsh-toast.exe --register/--status` 写入 HKCU、创建开始菜单快捷方式，`ToastNotifier.Setting` 为 `Enabled`；
- 带输入框/回复按钮的 Toast XML 被 Windows 接受（`Show` 成功，历史记录计数增加）；
- 修正了桌面 AUMID 首次显示时 `Setting` 为空的正常情况；
- Host 的 `diagnostics.json`、桥接密钥、令牌/状态文件结构；
- 插件代码 `node --check`、C# 编译。

未实测（受当前自动化/无交互浏览器环境限制）：

- 截图中没有捕获到通知横幅（Windows 接受 `Show` 但本会话的桌面/通知横幅可能被 Focus Assist/自动化桌面抑制）；
- 真实点击“回复”按钮后 COM 激活器读取输入并写入会话的完整链路（COM 服务器注册已完成，但未做人工点击）；
- 点击正文后浏览器端 `uiWorkspace.openSession` 的实际切换效果；
- 进程完全退出后点击旧 Toast 的冷启动 spool 全链路。
- 系统通知被全局关闭时的真实 UI 表现（只验证了代码分支和 `Setting` 判定逻辑）。

这些场景建议在正常登录的交互式 Windows 桌面上，按上面的验证步骤人工确认一次。

## 限制与故障排查

- **必须写 HKCU/开始菜单**：这是 Windows 桌面 Toast + 文本输入回调的硬性要求。Host 若运行在低完整性/AppContainer（某些沙箱或受限启动方式），自动注册会失败；按“如果自动注册失败”一节在普通终端执行一次。
- **Host 在低完整性时无法显示通知**：WinRT `CreateToastNotifier` 会报“process has no package identity”。插件会记录失败，不会假装成功；需要以正常用户完整性启动 DSH。
- **Focus Assist/专注助手**：`Setting` 仍可能是 `Enabled`，但横幅被专注助手抑制。可在 Windows 通知设置中允许本应用或关闭专注助手。
- **前台抑制**：默认窗口在前台且可见时不弹通知，这是为了避免重复打扰；需要始终弹可把 profile patch 的 `config.notifyWhenFocused` 设为 `true`（本插件未声明 Config UI，直接改 `cordis.patch.yml` 中 `windows-notify` 行的 `config`）。
- **通知条目/快捷方式**：使用独立 AUMID，通知设置中可能有两个“DeepSeek Harness”条目；开始菜单多一个 `Notifications` 快捷方式。这是应用身份要求，不是 UI 模拟。
- **回复失败**：会话被删除、归档或 Host 正忙时，`sessionController.prompt` 可能拒绝；日志会记录，不会重复发送。会话存在时会走正常队列。
- **卸载**：插件管理里移除后，运行 `%LOCALAPPDATA%\DeepSeekHarness\desktop-notify\bin\dsh-toast.exe --unregister` 删除 HKCU 注册和快捷方式；也可手动删除 `%LOCALAPPDATA%\DeepSeekHarness\desktop-notify`。
- **隐私**：Toast 参数只有随机 token；sessionId、标题、摘要、回复文本不进入 Toast 启动参数。`state.json` 只存 token 与 sessionId；`bridge.ini` 含每次进程随机密钥；目录在用户 `LOCALAPPDATA` 下。
