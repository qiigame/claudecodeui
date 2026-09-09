export { WS_OPEN_STATE, connectedClients } from './services/websocket-state.service.js';
export {
  createWebSocketServer,
  resolveWebSocketDeploymentPolicy,
} from './services/websocket-server.service.js';
export type {
  WebSocketDeploymentPolicyCandidates,
} from './services/websocket-server.service.js';
// Identity predicates are shared by transport adapters and focused tests; the
// upgrade itself only checks actor presence, while execution handlers require
// the verified predicate.
export {
  hasDingTalkActor,
  hasVerifiedDingTalkActor,
} from './services/websocket-auth.service.js';
export { chatRunRegistry } from './services/chat-run-registry.service.js';
export { handleChatConnection } from './services/chat-websocket.service.js';
export { handleShellConnection } from './services/shell-websocket.service.js';
// Consumed by the providers module's sessions watcher, which announces the
// sessions it (re)indexed from disk through the same builder the chat gateway
// uses, so both paths put the identical delta on the wire.
export { broadcastSessionUpserted, broadcastSessionUpsertedBatch } from './services/session-upsert-broadcast.service.js';
// runDetachedChatTurn: used by the scheduled-messages module to run a turn
// from a timer, with no socket to stream to or report errors on.
export { runDetachedChatTurn } from './services/chat-websocket.service.js';
export type { ProviderRuntimeGateway } from './services/chat-websocket.service.js';
