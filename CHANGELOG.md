# Changelog

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
