import { i as OpenClawConfig } from "../types.openclaw-F1K2WPwK.js";
import { t as PluginMetadataRegistryView } from "../plugin-metadata-snapshot.types-SqepopNQ.js";
import { cn as ProviderPlugin } from "../types-D7eu8baG.js";

//#region src/plugins/provider-discovery.runtime.d.ts
declare function clearProviderDiscoveryModuleLoaders(): void;
declare function resolvePluginDiscoveryProvidersRuntime(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  bundledProviderVitestCompat?: boolean;
  onlyPluginIds?: string[];
  includeUntrustedWorkspacePlugins?: boolean;
  requireCompleteDiscoveryEntryCoverage?: boolean;
  discoveryEntriesOnly?: boolean;
  includeManifestModelCatalogProviders?: boolean;
  pluginMetadataSnapshot?: PluginMetadataRegistryView;
}): ProviderPlugin[];
//#endregion
export { clearProviderDiscoveryModuleLoaders, resolvePluginDiscoveryProvidersRuntime };