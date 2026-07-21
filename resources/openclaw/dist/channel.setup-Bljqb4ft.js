import { n as zalouserSetupAdapter } from "./setup-core-TtvMcQmE.js";
import { t as createZalouserPluginBase } from "./shared-DYTEx7Jz.js";
import { t as zalouserSetupWizard } from "./setup-surface-Bz1UbdB6.js";
//#region extensions/zalouser/src/channel.setup.ts
const zalouserSetupPlugin = { ...createZalouserPluginBase({
	setupWizard: zalouserSetupWizard,
	setup: zalouserSetupAdapter
}) };
//#endregion
export { zalouserSetupPlugin as t };
