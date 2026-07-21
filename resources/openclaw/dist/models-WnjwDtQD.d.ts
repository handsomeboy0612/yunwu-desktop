import { i as OpenClawConfig } from "./types.openclaw-F1K2WPwK.js";
//#region extensions/vllm/models.d.ts
type ModelsConfig = NonNullable<OpenClawConfig["models"]>;
type ProviderConfig = NonNullable<ModelsConfig["providers"]>[string];
declare function buildVllmProvider(params?: {
  baseUrl?: string;
  apiKey?: string;
}): Promise<ProviderConfig>;
//#endregion
export { buildVllmProvider as t };