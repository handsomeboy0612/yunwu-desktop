import { i as OpenClawConfig } from "../../types.openclaw-F1K2WPwK.js";
//#region extensions/fal/onboard.d.ts
declare const FAL_DEFAULT_IMAGE_MODEL_REF = "fal/fal-ai/flux/dev";
declare function applyFalConfig(cfg: OpenClawConfig): OpenClawConfig;
//#endregion
export { FAL_DEFAULT_IMAGE_MODEL_REF, applyFalConfig };