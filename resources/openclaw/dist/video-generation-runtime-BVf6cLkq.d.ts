import { i as OpenClawConfig } from "./types.openclaw-F1K2WPwK.js";
import { Hl as GenerateVideoRuntimeResult, Vl as GenerateVideoParams } from "./types-D7eu8baG.js";
import { t as SubsystemLogger } from "./subsystem-CfQVin8T.js";
import { n as getProviderEnvVars } from "./provider-env-vars-vGi8a7ZB.js";
import { s as VideoGenerationProvider } from "./types-JnnbLz65.js";
import { n as listVideoGenerationProviders, t as getVideoGenerationProvider } from "./provider-registry-DbwZTu2r.js";

//#region src/video-generation/runtime.d.ts
declare const log: SubsystemLogger;
type VideoGenerationRuntimeDeps = {
  getProvider?: typeof getVideoGenerationProvider;
  listProviders?: typeof listVideoGenerationProviders;
  getProviderEnvVars?: typeof getProviderEnvVars;
  log?: Pick<typeof log, "debug" | "warn">;
};
declare function listRuntimeVideoGenerationProviders(params?: {
  config?: OpenClawConfig;
}, deps?: VideoGenerationRuntimeDeps): VideoGenerationProvider[];
declare function generateVideo(params: GenerateVideoParams, deps?: VideoGenerationRuntimeDeps): Promise<GenerateVideoRuntimeResult>;
//#endregion
export { listRuntimeVideoGenerationProviders as n, generateVideo as t };