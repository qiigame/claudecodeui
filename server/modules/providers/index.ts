export { sessionSynchronizerService } from './services/session-synchronizer.service.js';
export { providerSkillsService } from './services/skills.service.js';
export { providerMcpService } from './services/mcp.service.js';
// The composition root injects its startup deployment policy into a runtime
// dispatcher; the legacy singleton remains available for standalone embedders.
export {
  createProviderRuntimeService,
  providerRuntimeService,
} from './services/provider-runtime.service.js';

// providerModelsService: used by Commands to list models and resolve the active session model.
export { providerModelsService } from './services/provider-models.service.js';

// sessionsService: used by the websocket module's chat gateway to resolve an
// edited message's resume point, which only the providers module can read.
export { sessionsService } from './services/sessions.service.js';

export { initializeSessionsWatcher } from './services/sessions-watcher.service.js';
export { closeSessionsWatcher } from './services/sessions-watcher.service.js';

// createProviderRouter: used by the server composition root to inject the
// immutable deployment policy into provider/session HTTP boundaries.
export { createProviderRouter } from './provider.routes.js';
