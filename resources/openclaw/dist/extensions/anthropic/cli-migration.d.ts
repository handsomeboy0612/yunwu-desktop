import { i as OpenClawConfig } from "../../types.openclaw-F1K2WPwK.js";
import { jt as ProviderAuthResult } from "../../types-D7eu8baG.js";
import { n as readClaudeCliCredentialsForSetup } from "../../cli-auth-seam-DcXD0wqk.js";
//#region extensions/anthropic/cli-migration.d.ts
type ClaudeCliCredential = NonNullable<ReturnType<typeof readClaudeCliCredentialsForSetup>>;
/** Build the config migration result for adopting Claude CLI-backed Anthropic defaults. */
declare function buildAnthropicCliMigrationResult(config: OpenClawConfig, credential?: ClaudeCliCredential | null): ProviderAuthResult;
//#endregion
export { buildAnthropicCliMigrationResult };