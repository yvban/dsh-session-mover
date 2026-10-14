# dsh-session-mover

> 把 DSH 会话从一个工作区安全搬到另一个工作区，**保留可续聊的完整历史**。
> Move DSH sessions between workspaces safely — frame-level zstd header rewrite, byte-level verification.

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：在 **设置 → 会话迁移** 里选目标工作区、选会话、点一下，就把会话搬过去，归属即时更新、无需重启。

## 为什么需要它

DSH 的会话日志是**多帧 zstd**，并且有一条硬性约定：**第 1 个帧必须只包含 header 那一行**，其余每帧独立可解码（带 checksum）。DSH 读取时用 `assertZstdHeaderFrame` 校验，不满足就抛 `SessionPersistenceCorruptionError`，而会话枚举会**静默跳过**这条日志 —— 表现就是：

> 迁移完成后，那个对话在侧边栏里**彻底消失**（文件其实完好）。

手工改 header 时最容易踩的两个坑：

1. **把整份日志一次性重压**。改完 `cwd` 后重压全文，会把「头部帧 + 上千个事件帧」塌缩成单个帧，正好触发上面那条校验。
2. **硬编码日志文件名**。文件名带格式世代号：v0 叫 `session.jsonl.zstd`，vN(N>0) 叫 `session.vN.jsonl.zstd`。硬编码 v0 名字的实现，在较新的 DSH 上会**一个会话都定位不到**（实测 0/31）。

本插件按帧处理、按目录里实际存在的世代解析文件名，从根上避开这两个问题。

## 功能

| 能力 | 说明 |
|---|---|
| **迁移会话** | 设置 → 会话迁移：选目标工作区 → 选会话 → 迁移 |
| **按标题认会话** | 列表显示会话**标题**（与侧边栏同源），并标出它当前属于哪个分组；支持按标题 / 路径 / ID 过滤 |
| **帧级改写** | 只重压第 1 帧（header，写入新 `cwd`），**body 帧字节原样保留** |
| **字节级校验** | 帧数不变 + 每个 body 帧逐字节比对 + 头部 id/cwd 核对；不做全量解压，大日志也不吃内存 |
| **整目录备份** | 迁移前把整个会话目录 + `manifest.json` 备份到 `<DSH_HOME>/storages/session-mover-backup/<id>/<时间戳>/` |
| **拒绝覆盖** | 目标工作区已有同 id 会话时直接拒绝，不动原会话 |
| **事务性** | 先写临时文件并校验，通过后才 `rename`；任何一步失败都会清掉半成品 |
| **归属热更新** | 通过官方实体 API（`WorkspaceEntity.attachSession / detachSession`）更新分组，**无需重启** |
| **帧结构修复** | 已经被"整份重压"搞坏、在界面里消失的会话，可以就地修复（修复前自动备份） |

### 标题从哪来

标题有两个来源，按"快 → 准"的顺序取；取不到只是不显示，**绝不影响迁移**：

1. **投影缓存**（快）：`<DSH_HOME>/storages/session_projcache/sessions/<id>.json` 里的
   `record.rows.title.val`。本机实测覆盖 22/31 个会话。缓存只是显示提示，可能滞后于日志。
2. **`sessionQuery.readTitleSnapshots()`**（准）：官方公开服务，从日志里折叠标题事件。
   **只对缓存里没有标题的会话调用**，避免每次打开面板都全量读日志。

分组列来自 `workspaceRegistry.list()` 的成员关系；没有归属的显示为「未分组」。

## 安装

```powershell
# 有 git（标准写法）
dsh plugin --profile <你的 profile> add github:yvban/dsh-session-mover#main

# 没有 git：pnpm 解析 github: 依赖需要 git，可以改用归档 tarball 的 URL
dsh plugin --profile <你的 profile> add https://github.com/yvban/dsh-session-mover/archive/refs/heads/main.tar.gz
```

`<你的 profile>` 通常是 `web`；桌面版是 `desktop`。如果 PATH 里没有 `dsh`，用应用自带的 CLI：

```powershell
& '<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add github:yvban/dsh-session-mover#main
```

装完**重启 DSH**（客户端面板在启动时加载），然后打开 **设置 → 会话迁移**。

## 使用

1. **目标工作区**：下拉里选一个已注册的工作区。
2. **选中会话**：列表按创建时间倒序，每行显示标题 / 当前分组 / 原始 `cwd` / 体积 / 会话 ID。
   - `打开中` 的会话不能迁移（日志被写句柄占着）。
   - 标了 `帧结构异常` 的会话先用「修复帧结构」，修完**重启 DSH** 就会重新出现。
3. **迁移选中会话**：完成后归属即时生效，不用重启。

## HTTP 接口（面板用的就是这三个）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/plugins/dsh-session-mover/state` | 工作区清单 + 会话清单（含 `readable` / `live` / `title` / 分组） |
| POST | `/plugins/dsh-session-mover/migrate` | `{ sessionId, targetWorkspaceId }` |
| POST | `/plugins/dsh-session-mover/repair` | `{ sessionId }` |

两个 POST 需要 `x-dsh-session-mover: session-mover` 头，并通过 Host 的本机同源校验；跨站请求会被拒。

## 已知边界

- **正在 DSH 里打开的会话不能迁移**（日志被写句柄占着），返回 409。请先关掉那个会话。
- **热更新归属只用到一个非公开方法**：`workspaceRegistry.indexHeader()`。`attachSession` 会用
  内存里启动时缓存的头部索引校验 `cwd`，文件搬走后该索引过期，必须先刷新它。这一点无法用公开
  API 替代。若该方法在某版本不存在，插件会自动退回"直写 `workspace.json`"并提示需要重启；
  再不行就只搬文件，重启后手动把会话拖进目标分组。
- 迁移**不会**改动 `defaultWorkspaceId`，也不会动别的会话。
- 只用 Node 内置模块，无第三方运行时依赖。

## 开发与测试

```powershell
node --check lib/migrate.js
node --check lib/index.js
node --check lib/client.js
node tests/unit.mjs        # 12 项
node tests/host.test.mjs   # 10 项
```

覆盖内容：

- 路径编码（`projectKey` / `encodeSegment`）与真实 `sessions` 目录名**逐字一致**（含中文路径）；
- 合成多帧 fixture 的完整迁移：header 改写、**body 帧逐字节不变**、旧目录删除、备份与 manifest；
- 世代感知定位：v0 与 vN 两种命名都能定位并**沿用同名**迁移；文件名世代与 `header.version` 不一致时判定为不可读；
- 单帧塌缩（历史上导致会话消失的那个 bug）的**检测与修复**，修复后内容零丢失且幂等；
- no-overwrite、迁移到同工作区的 no-op、日志位置与头部 `cwd` 不符时拒绝；
- host 集成测试：用模拟 ctx 真实跑通 `apply()` → 路由注册 → 鉴权（跨站 403、缺确认头 403）→
  迁移成功（`attach`/`detach`/`indexHeader` 调用与文件落位都有断言）→ 打开中的会话 409 → 修复入口；
- 标题优先级：缓存命中直接用，缓存缺失才查 `sessionQuery`，并断言**命中过的不会重复查**；
- **归属更新必须被证实**：模拟上游 `attachSession` 静默无效（成员被 canonical-cwd 过滤丢掉）时，
  插件必须报 `disk` 而不是 `hot`，并如实说明需要重启——避免"报成功但侧边栏没有"；
- **真实 DSH 会话根目录的只读回归**（本机 31/31 可定位、可读；没有真实目录时自动跳过）。

## License

[MIT](LICENSE)
