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
`dsh_upgrade_status` / `dsh_upgrade_apply` / `dsh_upgrade_verify` / `dsh_upgrade_restart`。

## 四个工具

| 工具 | 作用 | 是否改盘 |
| --- | --- | --- |
| `dsh_upgrade_status` | 报告已装版本、registry 全部 dist-tag、升级目标、是否有新版 | 否 |
| `dsh_upgrade_apply` | 下载 → 校验哈希 → npm install → 重钉依赖 → 验证 | 是（`dryRun` 时否） |
| `dsh_upgrade_verify` | 比对 manifest / 新进程 `--version` / tarball 哈希 | 否 |
| `dsh_upgrade_restart` | 重启桌面外壳，让新版本加载 | 是 |

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

顺序也是固定下来的：先停 web 服务 → 再停外壳 → 拉起外壳 → 轮询端口恢复。

## 配置

`cordis.patch.yml` 里可改：

```yaml
channel: newest            # newest | latest | next | alpha | 具体版本号
registry: ''               # 空 = 用 .npmrc 里的配置
root: ''                   # 空 = 自动探测（当前进程的 bin.js 往上找）
autoRestart: false         # apply 成功后是否自动重启
restartDelaySeconds: 6     # 重启前等待，留出把结果返回给调用方的时间
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

## 测试

```powershell
npm test     # node --test test/  —— 37 个用例，覆盖版本比较、参数校验、registry 选版、重启脚本
```

## License

MIT
