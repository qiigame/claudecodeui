# CloudCLI 项目身份注册表接入

CloudCLI 的项目人员归因由 `comic-coordination/registry/identities.json` 统一管理。
CloudCLI 只读取它，不在 CloudCLI 仓库复制一份可独立编辑的人员映射。

## 运行配置

在 0.78 的服务启动环境中设置：

```bash
CLOUDCLI_IDENTITY_REGISTRY_PATH=/srv/cloudcli/config/identities.json
CLOUDCLI_IDENTITY_REGISTRY_REQUIRED=1
CLOUDCLI_IDENTITY_RUNTIME_MAP_PATH=/srv/cloudcli/secrets/identity-runtime-map.json
CLOUDCLI_SHARED_GIT_IDENTITY_ID=vcs-shared-github-jyzhao
# 0.78/managed deployment must be explicit; do not rely on fallback inference.
CLOUDCLI_DEPLOYMENT_PROFILE=product-qa-readonly
CLOUDCLI_REQUIRE_DINGTALK_AUTH=true
```

`identity-runtime-map.json` 是 0600 的本机文件，运行时唯一的人员映射来源；CloudCLI 数据库也会在 OAuth 后以 0600 权限保留 pending actor 的 subject，供下方管理员登记接口受控读取：

```json
{
  "schema_version": 1,
  "dingtalk_subjects": [
    {
      "provider_key": "haohan",
      "binding_ref": "dingtalk-subject/guowei/haohan",
      "subject": "<actual-union-or-open-id>",
      "subject_scope": "global",
      "status": "active"
    }
  ]
}
```

该文件不进入 Git、日报或群消息。注册表只负责 `binding_ref → person_id`；runtime map
负责 `stable subject → binding_ref`，两者缺一时身份保持 pending。runtime map 条目只有
`active` / `verified` 才能参与可信归因；`configured` 仅表示已录入待核验，不能开放写入。
CloudCLI 会拒绝软链接、非普通文件或权限不是严格 `0600`（含 special bits）的 runtime map，
避免同机其他账号读取或替换真实 subject。

共享 Git 的 name/email 由注册表中的 `author_names` / `emails` 提供。只有在注册表已登记且确有迁移需要时，才使用以下本地覆盖值；它们不能改变 `vcs_identity_id`：

```bash
CLOUDCLI_SHARED_GIT_NAME=<registered-author-name>
CLOUDCLI_SHARED_GIT_EMAIL=<registered-author-email>
```

这些变量不是凭据，不应写入 Git；OAuth secret、token 和数据库密码仍按协作库安全规则由受控凭据存储提供。
服务启动时只要求共享 Git 身份已在注册表中声明且未停用；若状态仍为 `configured`，服务保持
可登录的只读模式，直到人员、钉钉 binding 和 Git 身份都经负责人确认并提升为 `verified`。

CloudCLI 本身提供 receipt 的写入与查询能力，但不内置日报 worker 或日报归档流程。
如果另有外部 worker 消费同一 SQLite 数据库，必须由该 worker 自己配置只读路径和权限；
CloudCLI 不识别 `CLOUDCLI_IDENTITY_COMMIT_RECEIPTS_DB_PATH` 这类路径覆盖变量。共享 Git
提交只有在 commit SHA、`Human-Actor`、CloudCLI actor/run/provider 和
`verification_status=verified` receipt 全部匹配时才可显示中文姓名；receipt 缺失、重复或
不一致一律保留“共享 Git 身份（人员待确认）”。数据库文件必须是服务账号可读、其他用户
不可读的普通 `0600` 文件，外部日报归档不应包含 receipt 原文或稳定 subject。

## 归因行为

- OAuth 回调使用 provider + stable subject 查注册表；显示名、邮箱和服务器账号不作为唯一键。
- 已通过白名单认证的登录可按唯一匹配自动绑定（自动登记）：注册表精确 provider 绑定优先，其次已登记的钉钉 ID（`open_dingtalk_id` / `user_id` / subject 级 ID，跨 provider 有效——灏瀚与动影两个关联组织是「或」的关系），最后是注册表唯一姓名或 `display_aliases` 别名。自动绑定会把 stable subject 原子写入 runtime map（`active`），binding_ref 按 `dingtalk-subject/<person_id>/<provider>` 生成；注册表未声明该 provider 的 subject 时，运行时行按 binding_ref 中的 person_id 直接归属，不阻断后续登录。
- 只有 `active` 且 subject `verified` 的人员进入写入流程；无匹配、多匹配（含跨 provider 重名）或仅 `configured` 的身份会建立/保留 pending 门禁，只能查看，不能写代码、提交、推送或发外部通知。
- 每个执行创建独立 actor/session/run。共享 Git 账号保持同一个 Git name/email，不修改 0.78 全局 Git 配置。
- 旧的 `/api/agent` API-key 入口也必须经过同一身份门禁；没有 verified 的项目人员不能通过这个入口绕过浏览器会话直接执行、建分支、push 或创建 PR。
- `prepare-commit-msg` 自动写入 `Human-Actor`、`CloudCLI-Actor-ID`、`CloudCLI-Session-ID`、`CloudCLI-Run-ID` 和 `CloudCLI-Provider`，并拒绝篡改已有值。
- `post-commit` 将 commit receipt 回传本机服务；服务端重新读取 Git 元数据并校验共享身份和 `Human-Actor`，未通过时标记为 `pending` / mismatch，日报不得自动 @。

## 首次登录登记

1. 已登记人员的首次登录通常无需人工介入：白名单认证通过后服务按上节顺序自动绑定并写 runtime map。同名歧义或姓名未登记时才保留 pending enrollment，只有已登记且 `verified` 的设置管理员会话可请求 `GET /api/collaboration/identity-enrollments` 读取受保护的登记清单；普通成员和 pending 管理员不可读取原始 subject。
2. 负责人通过协作库 PR 确认 `person_id`、中文姓名、角色、仓库范围和个人或共享 VCS 身份。
3. 自动绑定的 subject 之后由管理员补登进协作库注册表（subject 条目与状态）；pending 的按旧流程手工核验后补 runtime map。
4. 历史 commit 不重写；无法证明的历史记录保留“待映射”。

每次写入、Provider / Shell 执行和 commit 前，服务都会重新用 actor 保存的 subject 查询
当前注册表；绑定被暂停、删除、歧义或降级为 `configured` 时，旧 JWT 也只能读，不能依赖
未过期会话继续写入。

首位管理员不能依赖“数据库第一用户”自动提权。正确顺序是：负责人先完成一次 OAuth 产生
pending、只读 actor；部署管理员仅从受保护数据库读取最新且唯一的 enrollment 并独立核验；随后
按协作库 PR-A（configured）→ runtime map（configured）→ PR-B（verified）→ runtime row
原子提升为 `active`/`verified`；同步合并后的 registry SHA、重启并让负责人退出后重新 OAuth，
确认 `/api/collaboration/me`、VCS 和 receipt 后，才把该 actor 的数值 `user_id` 写入受保护的
`CLOUDCLI_SETTINGS_ADMIN_USER_IDS`。禁止使用数据库第一用户、姓名或 Git 邮箱代替核验。
只有完成这套 bootstrap 后，管理员才可读取 `GET /api/collaboration/identity-enrollments` 来登记
其他 pending actor。

同一人员如果有多个组织或迁移后的钉钉 subject，应在注册表中分别登记 subject，全部指向同一个 `person_id`。CloudCLI 为每个 subject 保留独立 actor 以便审计，但不会因为显示名或 `person_id` 把两个稳定登录 subject 合并成一个 subject 记录。

校验协作库注册表：

```bash
node comic-coordination/tools/validate-identity-registry.mjs comic-coordination/registry/identities.json
```
