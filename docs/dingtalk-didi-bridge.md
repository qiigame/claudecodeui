# DIDI-app 钉钉对话桥接（简版）

> 正式版已迁入协作库 `comic-coordination/tools/didi-bridge/`（OPS-2026-008，含 launchd 安装包）；本文件与脚本是原始开发副本。

这是一个独立的小脚本，用现有的 DWS CLI 和本机 Agent 完成：

```text
钉钉群 @
    ↓
dws event consume
    ↓
Claude Code（默认）或 Codex，只读查看 comic-coordination
    ↓
dws chat +messages-reply，引用回复原消息
```

它不接入 CloudCLI 的 Web 服务，不需要数据库，也不会修改项目文件。脚本退出后监听就停止。

## 启动

在 `cloudcli` 目录执行：

```bash
node scripts/dingtalk-didi-bridge.mjs \
  --profile '重庆灏瀚网络科技有限公司'
```

不传 `--profile` 时使用 DWS 当前登录态。默认只监听固定的 `comic-coordination` 群，且只处理 `user_im_message_receive_at` 事件。

按 `Ctrl-C` 停止。DWS 监听使用 `--ephemeral`，正常退出会清理本次订阅。

## 开启赵井渝私聊

拿到赵井渝在目标组织中的 `openDingTalkId` 后，再额外传入：

```bash
export DIDI_OWNER_OPEN_ID='你的 openDingTalkId'
node scripts/dingtalk-didi-bridge.mjs \
  --profile '重庆灏瀚网络科技有限公司'
```

没有这个变量时，不会启动私聊监听。群聊和私聊是两条独立的 DWS 事件流。

## 切换 Agent

默认调用本机 `claude`：

```bash
DIDI_AGENT=claude node scripts/dingtalk-didi-bridge.mjs
```

需要用 Codex 时：

```bash
DIDI_AGENT=codex node scripts/dingtalk-didi-bridge.mjs
```

可用 `DIDI_CLAUDE_MODEL` 或 `DIDI_CODEX_MODEL` 临时指定模型；不指定时沿用各 CLI 自己的配置。

## 先看配置，不启动监听

```bash
node scripts/dingtalk-didi-bridge.mjs \
  --profile '重庆灏瀚网络科技有限公司' \
  --dry-run
```

## 当前行为

- 每次只串行处理一条消息，避免同时启动很多 Agent。
- 同一进程内按事件 ID 简单去重；重启后不会保留历史去重记录。
- Agent 失败或没有输出时不发送空回复。
- 回复过长会截断到约 6000 字。
- 监听进程异常退出后会自动等待 3 秒重连。
- Agent 使用只读权限和 `Read / Glob / Grep`，不会执行修改文件的工具。
