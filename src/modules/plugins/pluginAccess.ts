import type { Plugin } from '@/shared/types';

const PRODUCT_QA_READ_ONLY_PLUGIN_NAMES = new Set(['comic-coordination']);

/** Used by project-workspace plugin surfaces to expose the authenticated coordination mirror without enabling arbitrary plugins. */
export function isProductQaReadOnlyPlugin(plugin: Pick<Plugin, 'name'> | null | undefined): boolean {
  return Boolean(plugin && PRODUCT_QA_READ_ONLY_PLUGIN_NAMES.has(plugin.name));
}
