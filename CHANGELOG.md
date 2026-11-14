# Changelog

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
