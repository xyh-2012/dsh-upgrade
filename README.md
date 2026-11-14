# dsh-upgrade

把本机 DSH 升级到**最新已发布版本**，并验证新版本确实已在磁盘上生效。

## 为什么需要它

本机安装是 npm 树，`package.json` 里把 CLI 钉成 `file:deepseek-ai-dsh-<ver>.tgz`：

```json
"dependencies": { "@deepseek-ai/dsh": "file:deepseek-ai-dsh-0.2.2-rc.1.tgz" }
```

这意味着 `npm i @deepseek-ai/dsh@latest` **升不动**，而且 registry 的 `latest`
标签可能落后于真正的最新构建。实测（2026-11-14）：

| dist-tag | version |
| --- | --- |
| `latest` | `0.2.2-rc.1` ← 本机装的就是这个 |
| `next` | `0.2.2-rc.3` ← 真正最新 |

`latest` 指向的正是已安装版本，所以"按 latest 升级"会得出"已是最新"的错误结论。
本插件因此默认走 `newest`（全部已发布版本里的最大值），而不是 `latest`。

## 安装

```powershell
# 在 DSH 里（需要审批）
plugin_manager  action=install_bundle  target=C:\dsh\plugins\dsh-upgrade
```

装完的验收信号是 `application: applied`，可用 `cordis_inspect_query` 查 `Tool` 列表看到
`dsh_upgrade_status` / `dsh_upgrade_apply` / `dsh_upgrade_verify` / `dsh_upgrade_restart` /
`dsh_upgrade_status_all`。

## 五个工具

| 工具 | 作用 | 是否改盘 |
| --- | --- | --- |
| `dsh_upgrade_status` | 报告已装版本、registry 全部 dist-tag、升级目标、是否有新版 | 否 |
| `dsh_upgrade_apply` | 下载 → 校验哈希 → npm install → 重钉依赖 → 验证 | 是（`dryRun` 时否） |
| `dsh_upgrade_verify` | 比对 manifest / 新进程 `--version` / tarball 哈希 | 否 |
| `dsh_upgrade_restart` | 重启外壳或 web 服务（`mode` 可选 `auto`/`shell`/`cli`），让新版本加载 | 是 |
| `dsh_upgrade_status_all` | 一次报多个安装根目录的版本，不扫盘 | 否 |

还有一个人类入口：`/upgrade` 斜杠命令，等价于 apply + restart。

## 升级做了什么

1. **probe** — 读 registry 全量版本表，`newest` 取最大值；同时报告所有 dist-tag。
2. **download** — 下载 tarball 到安装根目录；已有同版本文件时先校验，通过则复用。
3. **verify-hash** — `shasum`（SHA-1 hex）与 `integrity`（SHA-512 base64）双向校验。
4. **backup** — 把 `package.json` / `package-lock.json` 复制到
   `<root>\.dsh-upgrade\backups\<时间戳>\`。
5. **install** — `node <npm-cli.js> install <tarball> --no-audit --no-fund`。
6. **pin** — 把依赖串改写为 `file:deepseek-ai-dsh-<ver>.tgz`。
7. **verify** — 读 manifest 版本，并**起一个全新 node 进程**跑 `--version`（运行中的进程还持有旧代码，只有新进程能证明磁盘上的版本）。

每一步都记录到 `.dsh-upgrade/last-run.json`，失败时也写，便于事后判断走到哪一步。

## 关于重启

桌面外壳 `DshDesktop.exe` 把 web 服务放在带 `JOB_OBJECT_LIMIT_KILL_ON_CLOSE` 的
Job Object 里，且 Job 没有设 breakaway 标志 —— 外壳一死，web 服务必死；而升级进程
自己就跑在这个 web 服务里，直接重启等于自杀。

`dsh_upgrade_restart` 因此用 `Invoke-CimMethod Win32_Process Create` 把重启脚本交给
`WmiPrvSE.exe` 持有：该进程不在 Job 内，能活到外壳被杀之后，再去重启整个外壳。
WMI 不可用时退回 `schtasks` 一次性任务。

**自重启**：不需要手动关窗口再打开。插件会

1. 先把「打算重启」写进 `.dsh-upgrade/pending-restart.json`；
2. 脚本把旧 web 服务与外壳停掉，再把新版拉起来；
3. 新版进程启动时，`apply()` 调 `confirmSelfRestart()` 比对
   `processStartedAt() > requestedAt`，确认「就是这次重启把我拉起来的」，
   写 `.dsh-upgrade/self-restart.json` 并清掉 pending 标记。

重启方式由 `mode` 决定：

| mode | 行为 |
| --- | --- |
| `auto`（默认） | 有 `DshDesktop.exe` 就跑外壳模式，否则跑 cli 模式 |
| `shell` | 停掉外壳，重新拉起外壳，由外壳再起 web 服务 |
| `cli` | 不碰外壳，只把 `node <root>/node_modules/@deepseek-ai/dsh/lib/bin.js web` 脱离式拉起 |

cli 模式是为「从终端跑 `dsh web`」的场景准备的：那里没有外壳可重启，直接重启
web 服务本身。两种模式都用同一个 `ready url=` 判据核对结果。

顺序也是固定下来的：先停 web 服务 → 再停外壳（仅 shell 模式）→ 拉起 → **读外壳自己
报告的地址**（`%LOCALAPPDATA%\DshDesktop\shell.log` 的 `ready url=` 行）→ 确认该 URL 应答。
外壳用 `FindFreePort(3179)` 选端口，所以不能硬等 3179。

结束后把证据写进 `.dsh-upgrade/last-restart.json`：

```json
{"ok":true,"reason":"completed","mode":"shell","url":"http://127.0.0.1:3179/","answered":true,
 "requestedPort":3179,"stoppedWeb":[14108],"stoppedShell":[13584],"startedWeb":0,"startedShell":1,
 "startedAt":"...","at":"..."}
```

下一次会话可以用 `readRestartReport(root)` / `readSelfRestart(root)`，或直接读这两个文件，
核实上次重启到底成没成。

## 配置

`cordis.patch.yml` 里可改：

```yaml
channel: newest            # newest | latest | next | alpha | 具体版本号
registry: ''               # 空 = 用 .npmrc 里的配置
root: ''                   # 空 = 自动探测（当前进程的 bin.js 往上找）
autoRestart: false         # apply 成功后是否自动重启
restartDelaySeconds: 6     # 重启前等待，留出把结果返回给调用方的时间
restartMode: auto          # auto | shell | cli
```

## 命令行自检

不依赖 DSH 也能跑：

```powershell
cd C:\dsh\plugins\dsh-upgrade
node scripts/selfcheck.mjs --allow-outdated   # 只看不装
node scripts/selfcheck.mjs --apply --dry-run  # 排练，确认不写盘
node scripts/selfcheck.mjs --apply            # 真升级
```

## 踩过的坑

- **`npm` 是 `.cmd` 垫片**，Node 从 v18.20 起拒绝直接 spawn `.cmd`。这里绕开垫片，直接
  `node <npm-cli.js>`，无 shell、无引号问题、退出码可信。
- **SRI `integrity` 是 base64，不是 hex**。第一版按 hex 比对 SHA-512，导致校验永远失败。
  `shasum` 才是 hex（SHA-1）。
- **dry-run 曾经会改盘**：早期版本在 `npm --dry-run` 之后仍然执行了重新钉版本，把
  `package.json` 悄悄指向新 tarball。现在 dry-run 在 pin 之前就返回。
- **`koffi.node` 被运行中的进程锁定**，但没有任何 `@deepseek-ai/*` 包依赖它，npm 升级时
  不会碰它，因此无需特殊处理。
- 不要从 profile 的 `node_modules` 解析 `@deepseek-ai/dsh-tools`：那会遮蔽 CLI 内建的
  base layer，agent loop 的私有 scheduler 符号丢失，每次工具调用都报
  `Cannot read properties of undefined (reading 'prepare')`。所以 `lib/sdk.js` 是自包含的。
- **`Start-Process` 在无控制台的脱会话 PowerShell 里会永久阻塞**：从 WMI 起的脚本里
  `Start-Process -FilePath <控制台程序>` 直接不返回（实测 `cmd /c exit` 只要 83ms，
  而 `Start-Process FakeShell.exe` 挂死）。因此重启脚本用
  `Invoke-CimMethod Win32_Process Create` 起进程（97ms 返回），`cmd /c start` 仅作兜底。
- **沙箱子进程写不了 `%LOCALAPPDATA%`**：演练时伪造的外壳往里写日志直接
  `UnauthorizedAccessException`。演练产物一律放工作区内；真外壳写自己的目录没问题。
- **不要用 `Start-Process -ArgumentList` 传含空格的路径**：引号会丢，报
  `Win32Exception: 系统找不到指定的文件`。

## 测试

```powershell
npm test     # node --test test/  —— 54 个用例，覆盖版本比较、参数校验、registry 选版、重启脚本
```

## License

MIT
