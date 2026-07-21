import { i as OpenClawConfig } from "./types.openclaw-F1K2WPwK.js";
import { f as ReplyPayload, n as GetReplyOptions } from "./types-Iy-uj5hQ.js";
import { i as MsgContext } from "./templating-CrpVqn66.js";

//#region src/auto-reply/reply/get-reply.d.ts
declare function getReplyFromConfig(ctx: MsgContext, opts?: GetReplyOptions, configOverride?: OpenClawConfig): Promise<ReplyPayload | ReplyPayload[] | undefined>;
//#endregion
export { getReplyFromConfig as t };