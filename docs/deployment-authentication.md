# 部署认证边界

CloudCLI 的认证模式在服务启动时由服务端环境解析并固定。显式的
`CLOUDCLI_DEPLOYMENT_PROFILE` 优先；浏览器构建变量 `VITE_IS_PLATFORM` 不是可靠的
生产安全控制，但为兼容旧托管部署，在没有显式 profile 或 DingTalk 配置时仍可能把
进程解析为 legacy `platform`。生产环境应始终显式设置 profile，并在变更后重启服务。

## 认证模式

| profile | 认证行为 |
| --- | --- |
| `platform` | 解析为 `platform` 的进程（包括上文所述的旧版 fallback）可以在没有 Bearer token 时使用受控的首个数据库用户；新部署应显式写 profile，不要依赖 fallback。 |
| `production` | 必须先完成普通 JWT 登录；不会因为 profile 名称自动走 platform 免登录旁路。若声明 DingTalk 配置或 `CLOUDCLI_REQUIRE_DINGTALK_AUTH=true`，则只接受 DingTalk 登录。 |
| `product-qa-readonly` | 必须使用 DingTalk 登录，并由部署策略继续限制写入能力。 |
| `developer` / `self-hosted` | 在显式选择这些 profile 时使用本地用户名密码/JWT；可由显式 DingTalk 配置切换为 SSO，不会被残留的 `VITE_IS_PLATFORM=true` 改写。 |

## REST Bearer 规则

受保护 REST 路由只接受严格的 `Authorization: Bearer <token>` 形式：认证方案必须是
`Bearer`（大小写不敏感），且只能有一个符合 JWT/b64token 字符集、完全不含空白的凭据。
`Basic`、缺少凭据、多个凭据或其他格式都会返回 `401 AUTH_TOKEN_INVALID`，不会被当作 JWT
尝试验证。

SSE 等无法设置请求头的旧客户端仍可使用对应 URL 的 `token` 查询参数；如果请求已经带有
`Authorization` 头，则该头必须是合法 Bearer，格式错误不会静默回退到查询参数。

## DingTalk 配置缺失时的行为

声明 `product-qa-readonly`、`CLOUDCLI_REQUIRE_DINGTALK_AUTH=true`，或
`CLOUDCLI_DINGTALK_CREDENTIALS_FILE` / `CLOUDCLI_DINGTALK_PUBLIC_ORIGIN` 后，服务端会把
部署视为 DingTalk 认证意图。缺少完整凭据时，DingTalk OAuth 状态保持不可用，
受保护请求不会回退到本地密码或首个数据库用户，而是要求 DingTalk 身份（fail-closed）。
如果此时没有显式 profile，部署策略也会回退到 `product-qa-readonly`，而不是带着
DingTalk SSO 意图启动一个可写的 `self-hosted` 实例。

这条规则不会让普通 `developer` 本地启动因为缺少 DingTalk 凭据而失败；开发者仍可在没有
DingTalk 配置时使用本地密码登录。运维在启用 `product-qa-readonly` 前，应先验证凭据文件、
HTTPS public origin、allowlist 和身份 registry/runtime map，避免把服务启动成“可访问但无可用
登录入口”的状态。

0.78 的 managed 启动脚本必须显式声明：

```bash
CLOUDCLI_DEPLOYMENT_PROFILE=product-qa-readonly
CLOUDCLI_REQUIRE_DINGTALK_AUTH=true
```

并同时配置 identity registry/runtime map。不要依赖“检测到 DingTalk 配置后的默认回退”；回退
行为只为本地兼容保留，不能作为部署或新人接入的事实依据。

## 登录、身份状态与执行权限

DingTalk OAuth 成功只证明登录 subject 已通过 OAuth，不自动授予代码或工具执行权限。
在 managed profile 中，`verified` actor 才能执行需要身份归因的写入/Provider 操作；
首次登录、无匹配、多匹配或 `configured` actor 可以看到登记提示并读取被允许的会话，
但不能启动 Provider、PTY、插件、Agent、工具批准或 Git/代码写入。allowlist 决定
“能否进入部署”，identity registry/runtime map 决定“subject 是否可被可信归因”；两者
都通过后仍要受 `product-qa-readonly` capability policy 约束。

策略和认证意图在进程启动时固定。修改 profile、DingTalk allowlist、registry 或 runtime
map 后必须按发布流程重启并重新 OAuth；前端隐藏按钮、请求 body 中的 `role`/`writable`
字段和 `VITE_*` 变量都不能改变服务端结果。本文描述的是认证契约，不代表当前
`192.168.0.78` 进程已经加载了本地代码改造；部署状态和 OS 只读证据以
[deployment-readonly.md](./deployment-readonly.md) 的实施状态、发布记录和验收清单为准。
