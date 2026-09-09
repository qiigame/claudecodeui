import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { api } from '@/shared/api';
import type { Plugin } from '@/shared/types';
import { useDeploymentPolicy } from '@/shared/context/DeploymentPolicyContext';
import { isManagedIdentityRestricted, useAuth } from '@/modules/auth';


type PluginsContextValue = {
  plugins: Plugin[];
  loading: boolean;
  pluginsError: string | null;
  refreshPlugins: () => Promise<void>;
  installPlugin: (url: string) => Promise<{ success: boolean; error?: string }>;
  uninstallPlugin: (name: string) => Promise<{ success: boolean; error?: string }>;
  updatePlugin: (name: string) => Promise<{ success: boolean; error?: string }>;
  togglePlugin: (name: string, enabled: boolean) => Promise<{ success: boolean; error: string | null }>;
};

const PluginsContext = createContext<PluginsContextValue | null>(null);

export function usePlugins() {
  const context = useContext(PluginsContext);
  if (!context) {
    throw new Error('usePlugins must be used within a PluginsProvider');
  }
  return context;
}

/** Mounted by the app root so the plugins and project-workspace modules can read and mutate installed plugins through usePlugins. */
export function PluginsProvider({ children }: { children: ReactNode }) {
  const { can, isReadOnly } = useDeploymentPolicy();
  const { authMode, user } = useAuth();
  // Plugin installation, removal, updates and enable/disable all mutate the
  // host process or its on-disk plugin directory.  Keep the context methods
  // inert in product/QA deployments as well as hiding their settings tab; a
  // stale component or an extension callback must not turn a read-only UI
  // into a write request.  The server remains authoritative.
  const canManagePlugins = can('plugin.write')
    && !isReadOnly
    && !isManagedIdentityRestricted(authMode, user);
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [pluginsError, setPluginsError] = useState<string | null>(null);

  const refreshPlugins = useCallback(async () => {
    try {
      const res = await api.plugins.list();
      if (res.ok) {
        const data = await res.json();
        setPlugins(data.plugins || []);
        setPluginsError(null);
      } else {
        let errorMessage = `Failed to fetch plugins (${res.status})`;
        try {
          const data = await res.json();
          errorMessage = data.details || data.error || errorMessage;
        } catch {
          errorMessage = res.statusText || errorMessage;
        }
        setPluginsError(errorMessage);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch plugins';
      setPluginsError(message);
      console.error('[Plugins] Failed to fetch plugins:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshPlugins();
  }, [refreshPlugins]);

  const installPlugin = useCallback(async (url: string) => {
    if (!canManagePlugins) {
      return { success: false, error: 'Plugin installation is disabled for this deployment.' };
    }

    try {
      const res = await api.plugins.install(url);
      const data = await res.json();
      if (res.ok) {
        await refreshPlugins();
        return { success: true };
      }
      return { success: false, error: data.details || data.error || 'Install failed' };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Install failed' };
    }
  }, [canManagePlugins, refreshPlugins]);

  const uninstallPlugin = useCallback(async (name: string) => {
    if (!canManagePlugins) {
      return { success: false, error: 'Plugin removal is disabled for this deployment.' };
    }

    try {
      const res = await api.plugins.uninstall(name);
      const data = await res.json();
      if (res.ok) {
        await refreshPlugins();
        return { success: true };
      }
      return { success: false, error: data.details || data.error || 'Uninstall failed' };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Uninstall failed' };
    }
  }, [canManagePlugins, refreshPlugins]);

  const updatePlugin = useCallback(async (name: string) => {
    if (!canManagePlugins) {
      return { success: false, error: 'Plugin updates are disabled for this deployment.' };
    }

    try {
      const res = await api.plugins.update(name);
      const data = await res.json();
      if (res.ok) {
        await refreshPlugins();
        return { success: true };
      }
      return { success: false, error: data.details || data.error || 'Update failed' };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Update failed' };
    }
  }, [canManagePlugins, refreshPlugins]);

  const togglePlugin = useCallback(async (name: string, enabled: boolean): Promise<{ success: boolean; error: string | null }> => {
    if (!canManagePlugins) {
      return { success: false, error: 'Plugin changes are disabled for this deployment.' };
    }

    try {
      const res = await api.plugins.toggle(name, enabled);
      if (!res.ok) {
        let errorMessage = `Toggle failed (${res.status})`;
        try {
          const data = await res.json();
          errorMessage = data.details || data.error || errorMessage;
        } catch {
          // response body wasn't JSON, use status text
          errorMessage = res.statusText || errorMessage;
        }
        return { success: false, error: errorMessage };
      }
      await refreshPlugins();
      return { success: true, error: null };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Toggle failed' };
    }
  }, [canManagePlugins, refreshPlugins]);

  // Built once per change: an inline object would re-render every consumer on
  // any render of this provider.
  const value = useMemo(
    () => ({ plugins, loading, pluginsError, refreshPlugins, installPlugin, uninstallPlugin, updatePlugin, togglePlugin }),
    [installPlugin, loading, plugins, pluginsError, refreshPlugins, togglePlugin, uninstallPlugin, updatePlugin],
  );

  return (
    <PluginsContext.Provider value={value}>
      {children}
    </PluginsContext.Provider>
  );
}
