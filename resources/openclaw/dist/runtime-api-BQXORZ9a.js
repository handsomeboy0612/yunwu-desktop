import "./media-runtime-Dy2HrAqe.js";
import "./text-chunking-nijjGL3g.js";
import { t as createPluginRuntimeStore } from "./runtime-store-uAKGMqTs.js";
import "./channel-outbound-DWd0sHxj.js";
import "./outbound-media-DejWcTJK.js";
import "./ssrf-runtime-CZi-6iMr.js";
import "./dangerous-name-runtime-cJriWyuh.js";
import "./channel-status-CxP0h-5H.js";
import "./bundled-channel-config-schema-CqRzCASC.js";
import "./channel-config-primitives-BgcfcRdI.js";
import "./channel-actions-CdLhqkfP.js";
import "./channel-inbound-B4TgYqpv.js";
import "./channel-feedback-Bo1DW6IF.js";
import "./channel-pairing-BhZI8NmU.js";
import "./webhook-request-guards-DsPJqnE8.js";
import "./webhook-ingress-BCGGb51n.js";
import "./webhook-targets-BcWfdgAC.js";
//#region extensions/googlechat/src/runtime.ts
const { setRuntime: setGoogleChatRuntime, getRuntime: getGoogleChatRuntime } = createPluginRuntimeStore({
	pluginId: "googlechat",
	errorMessage: "Google Chat runtime not initialized"
});
//#endregion
export { setGoogleChatRuntime as n, getGoogleChatRuntime as t };
