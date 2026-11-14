# Changelog

## 0.2.0

- **自重启**：`dsh_upgrade_restart` 不再只重启桌面外壳。新增 `mode` 参数：
  `auto`（默认，有外壳就重启外壳，没有就重启 web 服务）、`shell`、`cli`。
  cli 模式面向"从终端跑 `dsh web`"的场景，那里没有外壳可重启，直接脱离式拉起
  web 服务本身。
- **可核验的重启证据**：重启前写 `.dsh-upgrade/pending-restart.json`；新进程启动时
  `apply()` 调 `confirmSelfRestart()`，用 `processStartedAt() > requestedAt` 确认
  "就是这次重启把我拉起来的"，写 `.dsh-upgrade/self-restart.json` 并清掉 pending。
  `dsh_upgrade_status` 输出新增 `lastRestart` / `selfRestart`。
- **启动方式改为 WMI 优先**：`Start-Process` 在无控制台的脱会话 PowerShell 里会永久阻塞
  （实测 `cmd /c exit` 83ms 正常，`Start-Process FakeShell.exe` 挂死），改用
  `Invoke-CimMethod Win32_Process Create`（97ms 返回），`cmd /c start` 兜底；
  WMI 调度失败时再退到 `schtasks` 一次性任务。
- **进程识别正则收紧**为外壳自己的写法 `dsh[\\/]lib[\\/]bin\.js"?[ \t]+web(?=[ \t]|$)`：
  原先"命令行里同时出现 dsh/bin.js 和 web"会误杀别的进程（实测误杀过
  subprocess-local runner 的 pwsh 命令）。
- 外壳重启 3 次重试；报告新增 `mode`/`reason`/`startedWeb`/`startedShell`/`cliVersion`/`manifestVersion`。
- 测试 40 → 54 个用例；两种模式都用替身（假 CLI、假外壳 exe）做过端到端演练：
  种一个旧 server → 跑重启脚本 → 旧 pid 消失、新 pid 接管、`answered:true`。
## 0.1.2

- 修复 `dsh_upgrade_restart` 找不到 `ready url=` 的缺陷：原先只看 `shell.log` 最后 40 行，
  而该日志每 10 秒一条 heartbeat（本机已 12 MB / 10 万行），重启后 40 行窗口里根本没有
  `ready` 那一行，于是重启明明成功却被判成 `no-ready-url`。
  现在改为在拉起外壳**之前**记下日志字节长度，之后只读新增的那一小段再匹配。
- 测试 40 个用例（新增"只相信重启之后写入的日志行"）。

## 0.1.1

- `dsh_upgrade_restart` 现在等外壳自己报告真实地址：外壳用 `FindFreePort(3179)` 选端口，
  所以固定轮询 3179 会误判失败；改为从 `%LOCALAPPDATA%\DshDesktop\shell.log` 里读
  `ready url=` 那一行，再确认该 URL 真的应答。
- 重启结束后把证据写进 `.dsh-upgrade/last-restart.json`（`ok`/`url`/`answered`/
  `stoppedWeb`/`stoppedShell`/`at`），供下一次会话核验，新增 `readRestartReport(root)`。
- 测试从 37 增至 39（新增"跟随外壳广告端口"与"写出机器可读证据"两个用例）。

## 0.1.0

- 首个版本。
- `dsh_upgrade_status`：读 registry 全量版本表，报告已装版本、全部 dist-tag、升级目标。
  默认 `newest`，因为本机 `latest` 标签指向的正是已安装的 rc.1，按它判断会误报"已最新"。
- `dsh_upgrade_apply`：下载 → SHA-1/SHA-512 双向校验 → npm install → 重钉依赖 → 双重复验。
  支持 `dryRun`，且 dry-run 保证不写盘。
- `dsh_upgrade_verify`：manifest、独立新进程 `--version`、tarball 哈希三方比对。
- `dsh_upgrade_restart`：经 WMI 在桌面外壳的 Job Object 之外启动重启脚本，先停 web
  服务再停外壳再拉起，避开 `KILL_ON_JOB_CLOSE` 导致的自杀。
- `/upgrade` 斜杠命令。
- `scripts/selfcheck.mjs`：不依赖 DSH 的命令行自检 / 排练 / 升级。
