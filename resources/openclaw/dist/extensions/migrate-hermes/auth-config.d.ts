import { i as OpenClawConfig } from "../../types.openclaw-F1K2WPwK.js";
import { d as MigrationProviderContext } from "../../plugin-entry-C2vALirs.js";
//#region extensions/migrate-hermes/auth-config.d.ts
type HermesAuthProfileConfig = {
  profileId: string;
  provider: string;
  mode: "api_key" | "oauth" | "token";
  email?: string;
  displayName?: string;
};
type HermesAuthConfigApplyResult = "configured" | "conflict" | "unavailable";
declare function hasAuthProfileConfigConflict(config: OpenClawConfig, profile: HermesAuthProfileConfig, overwrite: boolean): boolean;
declare function hasCurrentAuthProfileConfigConflict(ctx: MigrationProviderContext, profile: HermesAuthProfileConfig): boolean;
declare function applyAuthProfileConfigWithConflictCheck(params: {
  ctx: MigrationProviderContext;
  profile: HermesAuthProfileConfig;
  applyConfigPatch?: (config: OpenClawConfig) => OpenClawConfig;
}): Promise<HermesAuthConfigApplyResult>;
//#endregion
export { HermesAuthConfigApplyResult, HermesAuthProfileConfig, applyAuthProfileConfigWithConflictCheck, hasAuthProfileConfigConflict, hasCurrentAuthProfileConfigConflict };