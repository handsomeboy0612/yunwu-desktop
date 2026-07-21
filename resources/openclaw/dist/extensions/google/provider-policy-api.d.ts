import { f as ModelProviderConfig } from "../../types.models-Nc1Z-tAz.js";
import { Cu as ProviderThinkingProfile } from "../../types-D7eu8baG.js";
import { wt as ProviderDefaultThinkingPolicyContext } from "../../plugin-entry-C2vALirs.js";
//#region extensions/google/provider-policy-api.d.ts
declare function normalizeConfig(params: {
  provider: string;
  providerConfig: ModelProviderConfig;
}): ModelProviderConfig;
declare function resolveThinkingProfile(context: ProviderDefaultThinkingPolicyContext): ProviderThinkingProfile | undefined;
//#endregion
export { normalizeConfig, resolveThinkingProfile };