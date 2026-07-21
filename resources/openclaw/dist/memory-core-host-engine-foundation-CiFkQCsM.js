import "./paths-DyelItkH.js";
import "./fs-safe-aqmM_n6V.js";
import "./utils-BApvfmPs.js";
import "./types.secrets-lIZQEgMF.js";
import "./subsystem-yNfG7O3v.js";
import "./agent-scope-CDZXADgT.js";
import "./config-Dpm7ICBa.js";
import "./mime-C8mVE2Bw.js";
import "./paths-CHZBIGhF.js";
import { n as onInternalSessionTranscriptUpdate } from "./transcript-events-BFG5Kqze.js";
import "./memory-search-CBXJuehI.js";
import "./fs-utils-BtV6P5-S.js";
import "./openclaw-runtime-config-DP76ERDw.js";
import "./openclaw-runtime-session-DP76ERDw.js";
//#region src/plugin-sdk/memory-core-host-engine-foundation.ts
/**
* Public SDK foundation surface for memory host engine config, paths, and shared helpers.
*/
const MEMORY_CORE_TRANSCRIPT_UPDATE_SUBSCRIBER_KEY = Symbol.for("openclaw.memoryCore.sessionTranscriptUpdateSubscriber");
globalThis[MEMORY_CORE_TRANSCRIPT_UPDATE_SUBSCRIBER_KEY] ??= onInternalSessionTranscriptUpdate;
//#endregion
export {};
