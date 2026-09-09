# 0.78 产品 / 运营 / QA 只读部署

本文描述两层边界：本地开发环境使用完整读写能力；对外提供给产品、运营和 QA 的
0.78 实例使用 `product-qa-readonly` 应用策略。该 profile 只在 CloudCLI 服务端拒绝
代码、Git、Shell 和配置写入；代码无法单独把一个可写的 checkout 变成操作系统级只读。
只有完成“操作系统边界”和验收章节后，0.78 才能对外宣称为双层只读部署；若现有进程
仍以个人账号运行或业务 checkout 可写，只能称为“应用层受限”。

## 实施状态与证据边界

这份文档同时是代码能力说明和 0.78 的部署目标，**不是远程主机已更新的证明**。本次
改造只修改了本地 CloudCLI checkout；在发布记录明确写出 release commit、启动时间、
重启结果和验收证据之前，不得据此宣称 `192.168.0.78:3090` 已经使用
`product-qa-readonly`，也不得假设该主机已经具备操作系统级只读。正在运行的旧进程不会
自动读取新代码或新环境变量。

上线前至少要同时取得两类证据：

1. 应用层：重启后的 `GET /api/deployment-policy` 返回目标 profile，真实 DingTalk
   Bearer token 的能力检查和 WebSocket 检查符合本文预期。
2. 主机层：服务以专用非管理员账号/容器运行，代码和业务快照是只读挂载，只有 state
   目录可写，并完成“OS 级验收”。缺少任一类证据时，状态应写成“未部署”或“应用层受限”，
   而不是“只读已上线”。

## 0.78 服务配置

在 systemd、容器 secret 或其他部署管理器中设置变量（不要把真实 secret、密码、Webhook 或登录态写入仓库）：

```bash
CLOUDCLI_DEPLOYMENT_PROFILE=product-qa-readonly
CLOUDCLI_REQUIRE_DINGTALK_AUTH=true
CLOUDCLI_DINGTALK_CREDENTIALS_FILE=/run/secrets/cloudcli-dingtalk.json
CLOUDCLI_DINGTALK_PUBLIC_ORIGIN=https://<actual-cloudcli-origin>
CLOUDCLI_IDENTITY_REGISTRY_PATH=/srv/cloudcli/config/identities.json
CLOUDCLI_IDENTITY_REGISTRY_REQUIRED=1
CLOUDCLI_IDENTITY_RUNTIME_MAP_PATH=/srv/cloudcli/secrets/identity-runtime-map.json
CLOUDCLI_SHARED_GIT_IDENTITY_ID=vcs-shared-github-jyzhao
# Keep empty until the first verified owner bootstrap is complete.
CLOUDCLI_SETTINGS_ADMIN_USER_IDS=
CLOUDCLI_IDENTITY_STARTUP_APPROVED=0

# Provider transcript/config state is separate from the service account home.
# COMIC_* values are read by CloudCLI's history/auth synchronizers; the
# CLOUDCLI_READONLY_* values below are applied to provider child processes.
# All paths must be absolute, service-owned paths and must not be request inputs.
COMIC_CODEX_HOME=/srv/cloudcli/state/provider-ro/codex
COMIC_CLAUDE_CONFIG_DIR=/srv/cloudcli/state/provider-ro/claude
CLOUDCLI_READONLY_HOME=/srv/cloudcli/state/provider-ro
CLOUDCLI_READONLY_CODEX_HOME=/srv/cloudcli/state/provider-ro/codex
CLOUDCLI_READONLY_CLAUDE_CONFIG_DIR=/srv/cloudcli/state/provider-ro/claude

# 代码快照和已登记项目的只读根目录
WORKSPACES_ROOT=/srv/cloudcli/projects-ro

# 数据库由服务账号单独拥有并可写
DATABASE_PATH=/srv/cloudcli/state/auth.db
# 资产目录默认位于服务账号的 ~/.cloudcli/assets；请通过服务账号的
# home/container mount 将它放到受限的 state 盘，不要让它落在代码目录。
```

`CLOUDCLI_DINGTALK_CREDENTIALS_FILE` 应为服务账号可读、权限严格 `0600` 的文件；其中的
`clientSecret`、会话 secret 和 allowlist 只通过 secret 管理器注入。
`CLOUDCLI_SETTINGS_ADMIN_USER_IDS` 只填写已经在身份注册表中 `verified` 的管理员数值 user id。
`CLOUDCLI_READONLY_*` 只影响 provider 子进程，不会改变 CloudCLI 主进程的 `$HOME`、历史
同步器或附件目录；`COMIC_CODEX_HOME` / `COMIC_CLAUDE_CONFIG_DIR` 才是服务端读取 Codex/
Claude 会话与配置的隔离路径。附件目录仍由主进程的 `$HOME/.cloudcli/assets` 决定，因此
必须通过服务账号 home 或容器挂载把它放入 state。

`product-qa-readonly` 是能力边界，不会根据部门或岗位名称自动决定谁能登录。若 0.78 只服务
产品、运营和 QA，部署凭据文件的全局/组织级 `allowedUsers` 也必须只包含这批人的稳定
`unionid:` / `openid:` 标识，并从两个组织的列表中移除开发同学；仍留在 allowlist 的开发账号
也只能获得只读能力，但依然能够登录。临时使用 `name:` 兼容旧配置时要注意同名风险，完成
首次登录绑定后应尽快改成稳定 subject。身份 registry 负责“这个 subject 是谁”和审计归因，
OAuth allowlist 负责“这个人能否进入 0.78”，两者不能互相替代。

服务重启后策略才会重新解析。启动日志和 `GET /api/deployment-policy` 可以确认 profile；该接口只返回能力名称和值，不返回凭据。

路由工厂应在创建时捕获这份启动策略；独立挂载的 Browser MCP fallback 也只使用一次性快照，不能在每个请求重新读取 `process.env`。生产组合根仍应显式注入同一份 startup policy/guard；否则 alternate mount 只能视为待验收配置，不能宣称与主 `/api` 边界一致。

在当前 0.78 试点中，入口是 `http://192.168.0.78:3090/`，仅限可信 LAN 使用；禁止公网暴露、端口
转发或把 HTTP cookie 当作生产安全边界。正式多人使用前应改为 HTTPS 或等效安全隧道，并重新完成
OAuth、receipt 和日报验收。

该地址仅作为验收/部署目标记录；除非发布记录另有明确证据，不能把它理解为本轮代码已经
部署或重启完成。

## 能做什么

- 浏览登记的项目、文件、Git 状态、差异、历史和会话。
- 创建、重命名、归档会话（会话列表目前是部署范围共享的元数据），上传图片或普通附件。`skill.read`、
  `mcp.read` 和 `memory.read` 是能力模型中的读取边界；Skill/MCP 的现有 catalog 读取接口可在
  部署显式提供时使用，但当前没有独立的共享 Memory API，能力名本身不保证有内容可读。读取
  catalog 不会启动其中的命令。只读 Provider turn 不会自动加载项目/本地设置中的 Skill、MCP 或
  hooks；需要共享上下文时应通过受信任的项目文件或部署配置显式提供，不能把“可读 catalog”理解为
  “可执行集成”。
- 通过受控的 Provider 对话分析代码；只读部署的 Claude 使用 plan 模式和只读工具白名单，
  Codex 使用 read-only sandbox 且关闭网络。Cursor/OpenCode 当前没有可证明的只读运行时
  契约，在此 profile 中不会启动。
- 读取已由外部流程放入 state 的 QA artifacts（如有）。CloudCLI 当前没有内置测试包构建、
  模拟器执行或 QA runner；`qa.run` 只是预留 capability 名称，不能据此承诺会自动跑测试或
  生成报告。

Claude 的只读工具白名单明确排除并拒绝 `WebFetch`/`WebSearch`。Provider 仍需要访问其配置的
模型 endpoint（除非接入本地模型）；如果部署要求除模型调用外也完全无网络，仍必须在容器/
防火墙层禁止出网，不能只依赖 `plan` 模式。

## 明确禁止

0.78 不允许修改项目文件或工作区、创建/合并/删除 worktree、Git
init/stage/commit/checkout/fetch/pull/push、交互式 Terminal/PTTY、任意 shell、Agent API、
插件执行或管理、Browser MCP 副作用、Provider/MCP/密钥配置写入，以及通过计划任务触发
Agent。

`terminal.readonly=true` 和 `qa.run=true` 目前只是能力模型中的预留名称；当前实现没有
“只读 PTY”或内置 QA runner。Shell WebSocket 一律要求 `terminal.interactive`，因此在
`product-qa-readonly` 中会在创建 PTY 前被拒绝。

分享链接的创建和撤销只属于会话元数据能力；若部署显式关闭 `session.write`，这两项也会
被拒绝。附件目录和数据库可写；QA artifacts 目录只是供外部测试流程使用的预留 state，
不代表 CloudCLI 当前会自动写入它，更不代表项目代码目录可写。

### 项目管理写入口对照

项目路由的 HTTP 方法不能单独代表“只读”。下表列出当前实现中的副作用和能力要求；
`product-qa-readonly` 会在进入 handler、Git 子进程或文件操作前拒绝这些请求。

| 路由 | 实际副作用 | 所需能力 | 只读 profile |
| --- | --- | --- | --- |
| `POST /api/projects/create-project` | 创建目录并登记项目 | `project.mutate` + `file.write` + `repo.write` | `403 DEPLOYMENT_CAPABILITY_DENIED` |
| `GET /api/projects/clone-progress` | 旧版 EventSource 传输，仍会启动 `git clone` 并登记项目 | `project.mutate` + `file.write` + `repo.write` + `git.fetch`；managed/DingTalk 部署还须 verified actor | `403 DEPLOYMENT_CAPABILITY_DENIED` |
| `POST /api/projects/clone-progress` | 新版 SSE 传输，启动 `git clone` 并登记项目 | 同上 | `403 DEPLOYMENT_CAPABILITY_DENIED` |
| `PUT /api/projects/:projectId/rename`、`POST .../toggle-star`、`POST .../restore` | 更新项目元数据 | `project.mutate` | `403 DEPLOYMENT_CAPABILITY_DENIED` |
| `POST /api/projects/migrate-legacy-stars` | 写入项目星标元数据 | `project.mutate` | `403 DEPLOYMENT_CAPABILITY_DENIED` |
| `DELETE /api/projects/:projectId`（无 `force` 或 `force=false`） | 软归档项目记录 | `project.mutate` | `403 DEPLOYMENT_CAPABILITY_DENIED` |
| `DELETE /api/projects/:projectId?force=true` | 删除项目/会话记录并移除 Claude transcript 文件 | `project.mutate` + `file.write` | `403 DEPLOYMENT_CAPABILITY_DENIED` |

`GET /api/projects/clone-progress` 只是兼容旧客户端，不能因为是 GET 就视为查询。GET
除旧客户端认证所需的 `token` 查询参数外，业务参数只能携带已存储凭据的标识（如
`githubTokenId`）；`newGithubToken`、`githubToken`、
`rawGithubToken`、`github_token`、`github-token`、`access_token` 和 `accessToken` 等
原始 PAT 查询参数会被拒绝。新客户端必须使用 POST body 传递一次性 token；无论哪种
传输，在只读 profile 都不会启动 clone。

## 操作系统边界（必须同时满足）

1. 使用独立的 `cloudcli` 服务账号或容器，不使用个人登录账号运行多人服务。
2. 将代码仓库/快照以只读 bind mount、容器 `:ro` 或等效文件权限提供；`WORKSPACES_ROOT` 不能指向服务账号的整个 home。
3. 将 SQLite、附件、日志和 QA artifacts 放到单独的可写目录，并限制为服务账号访问。
4. 不把 SSH、GitHub/GitLab、MCP stdio 或其他开发凭据放进 provider 子进程环境。CloudCLI
   会过滤已知的 Git、凭据、启动注入和配置路径变量，并可把 provider 的 HOME/Codex/Claude
   目录映射到 `CLOUDCLI_READONLY_*`；这不是任意环境变量的完整 allowlist，仍必须用独立
   服务账号/容器和最小环境启动。必须设置独立的 `CLOUDCLI_READONLY_HOME`（以及可选的
   Codex/Claude 子目录），避免继承服务账号的个人配置、hooks、插件和凭据。
5. 任何 `.mcp.json`、插件 manifest 或项目脚本都视为不可信数据，不能因为被读取就自动启动其中的命令。

Git worktree 只解决并行文件/index 隔离，不是权限边界。开发人员需要修改代码时，应在自己的本地 `developer` 环境完成，并通过正常 PR/MR 流程交付给 0.78 验收。

## 本地开发环境

本地开发者不需要配置 DeepSeek Harness，也不应依赖 0.78 的只读服务。使用独立的本地数据目录和明确的开发 profile：

```bash
CLOUDCLI_DEPLOYMENT_PROFILE=developer
# 或不设置 profile，让本地 self-hosted 默认行为生效
```

本地服务可以使用完整 Git、Terminal、worktree 和 provider 配置能力；代码、凭据和运行数据仍应遵守各仓库的 `AGENTS.md` 与协作库规则。

## DeepSeek Harness（DSH）边界

DSH 不是 CloudCLI 的必需组件，也不是 0.78 的认证机制或固定 provider runtime。代码中
只有可选的 `COMIC_DATAVERSE_TOKEN_HELPER` 兼容入口：服务在一次 provider turn 前调用
部署方提供的 helper，并只把标准输出中的临时 token 留在内存中。若 Dataverse 需要该
helper，应为服务账号单独提供最小权限的 helper 和凭据源；不要把个人的
`~/.config/deepseek-harness`、DSH 配置或 SSH/Git 凭据挂载给 CloudCLI。普通本地
developer 和 QA 用户都不需要安装或启动 DSH；是否配置 Dataverse helper 是运维选择，
不是本地接入前置条件。

### 只读部署中的 helper 例外

`product-qa-readonly` 的 provider turn 默认不会执行
`COMIC_DATAVERSE_TOKEN_HELPER`，即使服务环境中存在这个路径。这样可以避免一次
只读问答意外读取服务账号之外的 DSH/Dataverse 凭据。若 0.78 确实需要使用一个经过
审核的、最小权限的 Dataverse helper，部署管理员必须在进程启动环境中显式设置：

```bash
CLOUDCLI_READONLY_ALLOW_DATAVERSE_HELPER=1
```

该开关只在服务端启动环境中读取，不能由请求、会话选项或浏览器覆盖；任何其他值都
保持禁用（fail closed）。不设置开关时，仍可使用部署管理员直接提供的
`OPENAI_API_KEY` / `CODEX_API_KEY` / `ANTHROPIC_API_KEY`，但不会运行 helper。开发者
profile 保持原有显式 helper 行为。启用例外前，仍须确认 helper 不启动完整 DSH、不读取
个人 HOME、SSH/Git 凭据或其他与模型调用无关的秘密，并将其文件权限限制到服务账号。

## 发布前检查清单

- 确认 0.78 的 profile 是 `product-qa-readonly`，而不是仅依赖前端环境变量。
- 确认钉钉全局及各组织 allowlist 只保留产品、运营、QA 的稳定 subject；分别用一个允许账号
  和一个已移除的开发账号验证登录结果。开发账号应在 OAuth 阶段得到 `DINGTALK_USER_DENIED`，
  而不是仅依赖前端隐藏入口。
- 用已登记且 `verified` 的非管理员 DingTalk 账号验证：GET 查询和只读聊天可用，任意代码/
  Git/Terminal 写入返回 `403 DEPLOYMENT_CAPABILITY_DENIED`。再用 pending/ambiguous 账号
  验证其只能进入登记提示和读取会话，不能启动 Provider、PTY、插件或批准工具。
- 验证 provider 子进程没有开发凭据，且没有宿主 `HOME`、`CODEX_HOME`、`CLAUDE_CONFIG_DIR`、
  `SSH_*` 或解释器启动注入变量；检查 Codex 使用 read-only sandbox 并关闭网络，Claude 只
  使用只读工具白名单，并确认 Claude 的 `WebFetch`/`WebSearch` 被排除。若安全要求除模型
  调用外完全无网络，另用防火墙/容器网络策略实现。`CLOUDCLI_READONLY_*` 只是进程配置覆盖，
  不替代 OS 隔离。
- 验证代码 mount 为只读、state/artifacts 目录可写，并确认日志不包含 secret。
- 变更服务端代码后再重启；未重启的进程继续使用启动时捕获的旧策略。

## 推荐目录和发布方式

不要在正在运行的 checkout 中执行 `git pull` 或覆盖文件。建议把每个已验收的
版本放在不可变的 release 目录，并把登记的业务仓库/快照单独挂载：

```text
/srv/cloudcli/releases/<commit-sha>/        # 应用代码，只读
/srv/cloudcli/projects-ro/<project>/        # 业务代码快照，只读
/srv/cloudcli/state/auth.db                 # SQLite，可写
/srv/cloudcli/state/assets/                 # 图片和附件，可写
/srv/cloudcli/state/qa-artifacts/           # 测试报告，可写
/srv/cloudcli/state/logs/                   # 日志，可写
/srv/cloudcli/secrets/                      # secret manager 挂载，只读 0600
```

用专用 `cloudcli-qa`（或容器内非 root）账号启动服务，令其只能读取 `releases`
和 `projects-ro`，只能写 `state`。在 Linux 容器中使用 `--read-only` 配合明确的
`--mount type=bind,source=...,target=...,readonly`；在 macOS VM 上优先使用容器/独立
VM 的只读挂载。仅对同一个 `macos` 用户执行 `chmod -R a-w` 不是安全边界，因为该
用户仍能自行恢复权限。

更新版本时，先在构建机生成并校验 `<commit-sha>`，再创建新的 release/snapshot，
以只读方式挂载后启动一个新进程，健康检查通过才切换流量。不要修改正在服务的
目录，也不要让 QA 会话直接跟随主分支的工作目录变化；主分支的新提交应生成新的
快照。回滚只需切回上一个已验收的 SHA。

## API 绕过验收（必须使用真实 DingTalk 登录后的 Bearer token）

以下命令中的 `BASE_URL`、`TOKEN`、`PROJECT_ID` 和 `SESSION_ID` 仅是环境变量占位符，
不要把真实值写入文档、shell history 或仓库。先确认策略：

```bash
curl -sS -i "$BASE_URL/api/deployment-policy" \
  -H "Authorization: Bearer $TOKEN"
# 期望 200，JSON 中 profile=product-qa-readonly，且 repo.write/file.write/
# git.write/git.fetch/worktree.mutate/terminal.interactive/agent.use 均为 false。
```

用同一个 token 对下列“写入口”逐一请求；期望均为 HTTP `403`，错误码为
`DEPLOYMENT_CAPABILITY_DENIED`（或兼容的 `WORKSPACE_CAPABILITY_DENIED`），并确认
服务日志中没有对应的 Git、子进程或文件写入副作用：

```bash
curl -sS -i -X PUT "$BASE_URL/api/file-tree/projects/$PROJECT_ID/file" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  --data '{"filePath":"probe.txt","content":"must-not-write"}'
curl -sS -i -X POST "$BASE_URL/api/git/stage" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  --data "{\"project\":\"$PROJECT_ID\"}"
curl -sS -i -X POST "$BASE_URL/api/git/fetch" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  --data "{\"project\":\"$PROJECT_ID\"}"
curl -sS -i -X POST "$BASE_URL/api/git/push" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  --data "{\"project\":\"$PROJECT_ID\"}"
curl -sS -i -X POST "$BASE_URL/api/worktrees/create" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  --data "{\"project\":\"$PROJECT_ID\",\"branch\":\"probe\"}"
curl -sS -i -X POST "$BASE_URL/api/projects/create-project" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  --data '{"path":"/srv/cloudcli/projects-ro/forbidden"}'
# Legacy EventSource transport: GET must be denied as a clone mutation even
# though its HTTP method is GET. Do not put a raw GitHub PAT in this URL.
curl -sS -i -N -G "$BASE_URL/api/projects/clone-progress" \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'path=/srv/cloudcli/projects-ro/forbidden' \
  --data-urlencode 'githubUrl=https://github.com/example/readonly-probe.git'
# Preferred transport: POST keeps any one-time GitHub token in the body. The
# readonly policy must reject this before git clone is spawned.
curl -sS -i -N -X POST "$BASE_URL/api/projects/clone-progress" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  --data '{"path":"/srv/cloudcli/projects-ro/forbidden","githubUrl":"https://github.com/example/readonly-probe.git"}'
# Soft archive and force deletion are both denied. Run the force=true probe
# only against a disposable project if the response is not 403; it removes
# transcript files when a writable profile is accidentally running.
curl -sS -i -X DELETE "$BASE_URL/api/projects/$PROJECT_ID?force=false" \
  -H "Authorization: Bearer $TOKEN"
curl -sS -i -X DELETE "$BASE_URL/api/projects/$PROJECT_ID?force=true" \
  -H "Authorization: Bearer $TOKEN"
curl -sS -i -X POST "$BASE_URL/api/commands/execute" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  --data '{}'
curl -sS -i -X POST "$BASE_URL/api/agent" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  --data '{}'
curl -sS -i -X POST "$BASE_URL/api/providers/claude/mcp/servers" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  --data '{"name":"probe","transport":"http","url":"https://invalid.example"}'
curl -sS -i -X POST "$BASE_URL/api/settings/credentials" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  --data '{}'
curl -sS -i -X POST "$BASE_URL/api/browser-use/sessions/probe/stop" \
  -H "Authorization: Bearer $TOKEN"
```

只读部署仍允许会话元数据、图片/附件上传和受控聊天；这些写入只能落在
`state` 下，不能被误认为代码写权限。用一个无害的小附件验证 `/api/assets/files`
的上传/读取路径，并检查上传后文件不在 `projects-ro` 中。

`/api/agent` 是历史 API-key 入口，不使用普通 Bearer JWT；在只读 profile 中 capability
guard 应先返回 403（如果部署未挂载该 guard，缺少 `X-API-Key` 可能先得到 401，视为
配置错误并不得上线）。

## WebSocket 绕过验收

Shell 是独立的执行边界，不能只测 REST。使用项目已安装的 `ws` 客户端（或同等
工具）连接 `/shell`，发送一个普通 `init` 帧；服务端应在创建 PTY 之前发送
`DEPLOYMENT_CAPABILITY_DENIED`，随后以 close code `1008` 关闭连接。不要发送真实命令：

```bash
node <<'NODE'
const WebSocket = require('ws');
const base = new URL(process.env.BASE_URL);
const scheme = base.protocol === 'https:' ? 'wss:' : 'ws:';
const url = `${scheme}//${base.host}/shell?token=${encodeURIComponent(process.env.TOKEN)}`;
const ws = new WebSocket(url);
ws.on('open', () => ws.send(JSON.stringify({
  type: 'init', sessionId: process.env.SESSION_ID || 'probe',
  hasSession: false, projectPath: '/srv/cloudcli/projects-ro',
  provider: 'claude', isPlainShell: true,
})));
ws.on('message', (data) => console.log(String(data)));
ws.on('close', (code) => { console.log(`close=${code}`); process.exit(code === 1008 ? 0 : 1); });
ws.on('error', (error) => { console.error(error.message); process.exit(1); });
NODE
```

同时检查：

- 伪造 `X-Deployment-Profile`、`X-Capability`、请求 body 中的 `role`/`writable` 等
  字段不会改变结果；策略只能来自启动时的服务端环境。
- 没有 token 的 WebSocket 升级被拒绝；DingTalk 未登录不能回退到本地密码或首个用户。
- `chat` 连接可以订阅已有会话，但 `chat.edit-send`、工具批准和不受支持的 Provider
  不能借 WebSocket 绕过只读策略。
- 失败请求不会触发 `git`、PTY、Provider 子进程、插件进程或 Browser MCP。

## OS 级验收

以实际服务账号执行，而不是以管理员/部署用户执行：

```bash
sudo -u cloudcli-qa test -r /srv/cloudcli/projects-ro/<project>/README.md
sudo -u cloudcli-qa sh -c ': > /srv/cloudcli/projects-ro/<project>/.readonly-probe'
# 期望第二条失败；若成功，不能上线。
sudo -u cloudcli-qa sh -c 'printf ok > /srv/cloudcli/state/qa-artifacts/probe.txt'
# 期望成功，随后删除该临时 probe 并保留审计记录。
```

容器部署还要检查 `mount`/`findmnt`（或 Docker inspect）显示代码挂载带 `ro`，
而 state/artifacts 挂载可写。确认服务环境没有 `SSH_AUTH_SOCK`、`GH_TOKEN`、
`GITLAB_TOKEN`、Git push key、个人 `HOME` 或个人 DeepSeek Harness 配置；Provider
子进程应使用过滤后的环境和专用 `CLOUDCLI_READONLY_*` 路径。若确需 Dataverse，
只挂载前文所述的专用 token helper/凭据源，不要启动或共享完整 DSH。QA 使用
CloudCLI 不需要安装或启动 DSH。
