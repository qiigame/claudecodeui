// pluginsRoutes: used by the server entrypoint to mount protected plugin-management endpoints.
export { createPluginsModule, pluginsRoutes } from './plugins.module.js';

// startEnabledPluginServers/canStartEnabledPluginServers: used by the server
// entrypoint to apply the deployment execution boundary before launching
// enabled plugin subprocesses.
export {
  canStartEnabledPluginServers,
  startEnabledPluginServers,
} from './plugin-process.service.js';
// stopAllPlugins: used by the server entrypoint to stop plugin subprocesses during shutdown.
export { stopAllPlugins } from './plugin-process.service.js';
// getPluginPort: used by WebSocket setup in the server entrypoint to proxy plugin connections.
export { getPluginPort } from './plugin-process.service.js';
