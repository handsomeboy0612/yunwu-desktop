import { i as OpenClawConfig } from "../../types.openclaw-F1K2WPwK.js";
//#region extensions/vydra/onboard.d.ts
declare const VYDRA_DEFAULT_IMAGE_MODEL_REF = "vydra/grok-imagine";
declare function applyVydraConfig(cfg: OpenClawConfig): OpenClawConfig;
//#endregion
export { VYDRA_DEFAULT_IMAGE_MODEL_REF, applyVydraConfig };