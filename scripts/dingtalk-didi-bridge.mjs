#!/usr/bin/env node

/* A small, standalone DWS -> local Agent bridge. */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GROUP_ID = 'cid9WCthxLqO4tZGtX9pJrJqA==';
const GROUP_EVENT = 'user_im_message_receive_at';
const DIRECT_EVENT = 'user_im_message_receive_o2o';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../comic-coordination');

const cli = parseArgs(process.argv.slice(2));
const project = path.resolve(cli.project || process.env.DIDI_PROJECT || ROOT);
const dws = cli.dws || process.env.DIDI_DWS_BIN || 'dws';
const profile = cli.profile || process.env.DIDI_DWS_PROFILE || '';
const agent = cli.agent || process.env.DIDI_AGENT || 'codex';
const owner = cli.owner || process.env.DIDI_OWNER_OPEN_ID || '';

if (!['claude', 'codex'].includes(agent)) die('agent 只能是 claude 或 codex');
if (cli.dryRun) {
  console.log(JSON.stringify({ dws, profile: profile || '(当前 DWS 登录态)', project, agent,
    group: { event: GROUP_EVENT, conversationId: GROUP_ID },
    direct: owner ? { event: DIRECT_EVENT, senderOpenDingtalkId: owner } : null }, null, 2));
  process.exit(0);
}

let stopping = false;
let busy = false;
const children = new Set();
const seen = new Set();
const queue = [];

log(`启动：${agent}，项目 ${project}`);
log('监听固定群 comic-coordination；Ctrl-C 停止');
if (owner) log('同时监听已配置的私聊');

start('group');
if (owner) start('direct');
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

function log(message) {
  console.log(`[didi-bridge ${new Date().toISOString()}] ${message}`);
}

function logError(message) {
  console.error(`[didi-bridge ${new Date().toISOString()}] ${message}`);
}

function start(route) {
  const eventKey = route === 'group' ? GROUP_EVENT : DIRECT_EVENT;
  const args = [...profileArgs(), 'event', 'consume', eventKey, '--flatten', '--format', 'ndjson', '--ephemeral', '--yes'];
  if (route === 'direct') args.push('--open-dingtalk-id', owner);
  const child = spawn(dws, args, { cwd: project, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  children.add(child);
  let buffer = '';
  child.stdout.on('data', (part) => {
    buffer += String(part);
    if (buffer.length > 1000000) buffer = '';
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      try {
        const value = JSON.parse(line);
        const event = normalize(value);
        if (!event || !event.type) {
          logError(`[${route}] 未识别结构，keys=${Object.keys(value || {}).join(',')}`);
        } else if (allowed(route, event)) {
          add(route, event);
        } else {
          logError(`[${route}] 事件被过滤：type=${event.type} conversation=${event.conversation_id || '?'}`);
        }
      } catch {
        // Ignore non-event output from the CLI.
      }
    }
  });
  // DWS diagnostics can contain request details; keep them out of bridge logs.
  child.stderr.resume();
  child.once('error', (error) => logError(`[${route}] dws 启动失败：${error.code || 'error'}`));
  child.once('close', () => {
    children.delete(child);
    if (!stopping) {
      logError(`[${route}] 监听进程退出，3 秒后重连`);
      const timer = setTimeout(() => { if (!stopping) start(route); }, 3000);
      timer.unref?.();
    }
  });
}

function normalize(value) {
  if (!value || typeof value !== 'object') return null;
  let inner = value.data;
  if (typeof inner === 'string') { try { inner = JSON.parse(inner); } catch { inner = null; } }
  const src = inner && typeof inner === 'object' ? { ...value, ...inner } : value;
  let content = src.content;
  if (!text(content) && src.text) content = typeof src.text === 'string' ? src.text : src.text.content;
  return {
    type: src.type || src.event_type || src.eventType,
    event_id: src.event_id || src.eventId,
    message_id: src.message_id || src.messageId || src.openMessageId || src.msgId,
    conversation_id: src.conversation_id || src.conversationId || src.openConversationId,
    sender: src.sender_open_dingtalk_id || src.senderOpenDingtalkId || src.sender_open_id || src.senderId || src.senderStaffId,
    sender_name: src.sender,
    content,
  };
}

function allowed(route, event) {
  if (event.type !== (route === 'group' ? GROUP_EVENT : DIRECT_EVENT)) return false;
  if (typeof event.content !== 'string' || !event.content.trim() || event.content.length > 20000) return false;
  if (!text(event.event_id) || !text(event.message_id)
    || !text(event.sender) || !text(event.conversation_id)) return false;
  return route === 'group' ? event.conversation_id === GROUP_ID : event.sender === owner;
}

function add(route, event) {
  const key = `${event.type}:${event.event_id}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (seen.size > 2000) seen.delete(seen.values().next().value);
  queue.push({ route, event });
  void pump();
}

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (!stopping && queue.length) {
      const item = queue.shift();
      if (!item) continue;
      const preview = String(item.event.content).slice(0, 30).replace(/\n/g, ' ');
      log(`收到${item.route === 'group' ? '群 @' : '私聊'}（${item.event.sender_name || item.event.sender}）：${preview}`);
      try {
        const answer = await ask(item.event.content);
        if (answer) {
          await reply(item.event, answer);
          log(`${item.route === 'group' ? '群' : '私聊'}已回复（${answer.length} 字）`);
        } else {
          logError('Agent 无回答，未发送回复');
        }
      } catch (error) {
        logError(`处理失败：${error.message}${error.detail ? `；${error.detail}` : ''}`);
      }
    }
  } finally {
    busy = false;
  }
}

function ask(message) {
  const prompt = [
    '你是 comic-coordination 的内部协作助手。只读查看当前项目中的 README、docs、registry 和 spec，回答下面的问题。',
    '不要修改文件，不要执行 git 写操作，不要发送消息，不要索取凭据。资料不足时说“待确认”，用简洁中文回答。',
    '', '----- 用户消息 -----', message, '----- 消息结束 -----',
  ].join('\n');
  if (agent === 'codex') {
    const args = ['exec', '--ephemeral', '--sandbox', 'read-only', '--cd', project, '--color', 'never', '-'];
    if (process.env.DIDI_CODEX_MODEL) args.splice(1, 0, '--model', process.env.DIDI_CODEX_MODEL);
    return run(process.env.DIDI_CODEX_BIN || 'codex', args, prompt, 120000);
  }
  const args = ['--print', '--output-format', 'text', '--no-session-persistence', '--permission-mode', 'plan',
    '--tools', 'Read,Glob,Grep', '--disallowed-tools', 'Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Task',
    '--add-dir', project];
  if (process.env.DIDI_CLAUDE_MODEL) args.push('--model', process.env.DIDI_CLAUDE_MODEL);
  return run(process.env.DIDI_CLAUDE_BIN || 'claude', args, prompt, 120000);
}

function reply(event, answer) {
  const textValue = answer.trim().slice(0, 6000);
  if (!textValue) return Promise.resolve();
  const key = createHash('sha256').update(`didi:${event.type}:${event.event_id}`).digest('hex');
  const args = [...profileArgs(), 'chat', '+messages-reply', '--conversation-id', event.conversation_id,
    '--ref-msg-id', event.message_id, '--ref-sender', event.sender, '--text', textValue,
    '--idempotency-key', key, '--format', 'json', '--yes'];
  return run(dws, args, null, 30000);
}

function run(command, args, input, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: project, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    children.add(child);
    let output = '';
    let stderrTail = '';
    child.stdout.on('data', (part) => { if (output.length < 100000) output += String(part); });
    child.stderr.on('data', (part) => { stderrTail = (stderrTail + String(part)).slice(-500); });
    child.once('error', reject);
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 3000);
      force.unref?.();
      const error = new Error('timeout'); error.code = 'timeout'; reject(error);
    }, timeout);
    timer.unref?.();
    child.once('close', (code) => {
      children.delete(child);
      clearTimeout(timer);
      if (code !== 0) {
        const error = new Error(`exit_${code ?? 'unknown'}`);
        const tail = stderrTail.trim().split('\n').filter(Boolean).pop() || '';
        if (tail) error.detail = tail.slice(0, 200);
        reject(error);
      } else resolve(stripAnsi(output).trim());
    });
    if (input === null) child.stdin.end(); else child.stdin.end(input);
  });
}

function stop() {
  if (stopping) return;
  stopping = true;
  log('正在停止');
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch { /* already exited */ }
  }
  queue.length = 0;
}

function profileArgs() { return profile ? ['--profile', profile] : []; }
function text(value) { return typeof value === 'string' && value.trim(); }
function stripAnsi(value) { return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, ''); }
function die(message) { console.error(`[didi-bridge] ${message}`); process.exit(2); }

function parseArgs(args) {
  const result = { dryRun: false };
  const names = { '--profile': 'profile', '--project': 'project', '--agent': 'agent', '--owner-open-id': 'owner', '--dws': 'dws' };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--dry-run') { result.dryRun = true; continue; }
    if (args[i] === '-h' || args[i] === '--help') { printHelp(); process.exit(0); }
    const key = names[args[i]];
    if (!key) die(`未知参数：${args[i]}`);
    if (!args[i + 1] || args[i + 1].startsWith('--')) die(`${args[i]} 需要一个值`);
    result[key] = args[++i];
  }
  return result;
}

function printHelp() {
  console.log(`node scripts/dingtalk-didi-bridge.mjs [选项]\n\n  --profile <值>       DWS profile（可省略，使用当前登录态）\n  --project <目录>     只读项目目录\n  --agent claude|codex  本机 Agent，默认 codex\n  --owner-open-id <id>  额外监听私聊\n  --dws <路径>         dws 可执行文件路径\n  --dry-run            只显示配置，不启动监听`);
}
