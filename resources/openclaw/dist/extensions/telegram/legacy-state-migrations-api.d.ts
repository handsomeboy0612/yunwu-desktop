import { i as OpenClawConfig } from "../../types.openclaw-F1K2WPwK.js";
import { U as ChannelLegacyStateMigrationPlan } from "../../types.core-DF7IXShG.js";
//#region extensions/telegram/src/state-migrations.d.ts
declare function detectTelegramLegacyStateMigrations(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir?: string;
}): Promise<ChannelLegacyStateMigrationPlan[]>;
//#endregion
export { detectTelegramLegacyStateMigrations };