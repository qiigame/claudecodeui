import assert from 'node:assert/strict';
import test from 'node:test';

import { createPluginsService } from '../plugins.service.js';

type Dependencies = Parameters<typeof createPluginsService>[0];

function dependencies(overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    scanPlugins: () => [], readConfig: () => ({}), saveConfig: () => undefined,
    getPluginDirectory: () => null, getPluginsDirectory: () => '/plugins',
    resolveAsset: () => null, assetIsFile: () => false, contentType: () => 'text/plain',
    install: async () => ({ name: 'plugin', dirName: 'plugin' }),
    update: async () => ({ name: 'plugin', dirName: 'plugin' }),
    uninstall: async () => undefined, startServer: async () => 4000,
    stopServer: async () => undefined, getServerPort: () => undefined,
    isServerRunning: () => false, getActiveProjectPaths: () => [],
    normalizeProjectPath: (projectPath) => projectPath.replace(/\/$/, ''),
    joinPath: (...parts) => parts.join('/'),
    logError: () => undefined, ...overrides,
  };
}

test('setEnabled persists configuration and starts an enabled plugin server', async () => {
  const operations: string[] = [];
  const service = createPluginsService(dependencies({
    scanPlugins: () => [{ name: 'demo', dirName: 'demo', server: { entry: 'server.js' } }],
    getPluginDirectory: () => '/plugins/demo',
    saveConfig: () => operations.push('save'),
    startServer: async () => { operations.push('start'); return 4000; },
  }));
  await service.setEnabled('demo', true);
  assert.deepEqual(operations, ['save', 'start']);
});

test('Project Stats RPC accepts only a normalized path from the active project registry', async () => {
  const service = createPluginsService(dependencies({
    getServerPort: () => 4000,
    getActiveProjectPaths: () => ['/workspace/active-project/'],
  }));

  assert.deepEqual(await service.prepareRpc('project-stats', '/workspace/active-project/'), {
    port: 4000,
    secrets: {},
    authorizedProjectPath: '/workspace/active-project',
  });
  await assert.rejects(
    service.prepareRpc('project-stats', '/workspace/active-project/private'),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'PLUGIN_PROJECT_PATH_DENIED',
  );
  await assert.rejects(
    service.prepareRpc('project-stats', '/workspace/archived-project'),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'PLUGIN_PROJECT_PATH_DENIED',
  );
});

test('Project Stats RPC rejects missing and ambiguous path values without starting its server', async () => {
  let serverStarted = false;
  const service = createPluginsService(dependencies({
    getActiveProjectPaths: () => ['/workspace/active-project'],
    scanPlugins: () => [{
      name: 'project-stats',
      enabled: true,
      server: { entry: 'server.js' },
    }],
    startServer: async () => {
      serverStarted = true;
      return 4000;
    },
  }));

  for (const pathInput of [undefined, '', ['/workspace/active-project'], { path: '/workspace/active-project' }]) {
    await assert.rejects(
      service.prepareRpc('project-stats', pathInput),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'PLUGIN_PROJECT_PATH_DENIED'
        && 'statusCode' in error
        && error.statusCode === 403,
    );
  }
  assert.equal(serverStarted, false);
});

test('ordinary plugin RPC remains path-agnostic', async () => {
  let projectPathsRead = false;
  const service = createPluginsService(dependencies({
    getServerPort: () => 4001,
    getActiveProjectPaths: () => {
      projectPathsRead = true;
      return [];
    },
  }));

  assert.deepEqual(await service.prepareRpc('ordinary-plugin'), { port: 4001, secrets: {} });
  assert.equal(projectPathsRead, false);
});
