import { o as CommandTurnContext } from "./templating-BLMMEF1D.js";
import { v as resolveChunkMode } from "./outbound.types-CHpw9VBQ.js";
import { Gr as DispatchReplyWithDispatcher, Hr as finalizeInboundContext, Wr as DispatchReplyWithBufferedBlockDispatcher } from "./types-CR1WAXpo.js";
import { r as ReplyPayload } from "./reply-payload-CGSW3318.js";
import { n as generateConversationLabel } from "./conversation-label-generator-BG4oj-9l.js";

//#region src/plugin-sdk/reply-dispatch-runtime.d.ts
/** Dispatches a reply with buffered block support after lazy-loading the runtime dispatcher. */
declare const dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcher;
/** Dispatches a reply through the provider dispatcher after lazy-loading runtime code. */
declare const dispatchReplyWithDispatcher: DispatchReplyWithDispatcher;
//#endregion
export { type CommandTurnContext, type DispatchReplyWithBufferedBlockDispatcher, type DispatchReplyWithDispatcher, type ReplyPayload, dispatchReplyWithBufferedBlockDispatcher, dispatchReplyWithDispatcher, finalizeInboundContext, generateConversationLabel, resolveChunkMode };