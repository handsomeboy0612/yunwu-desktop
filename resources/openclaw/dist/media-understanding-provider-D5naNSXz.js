import { r as describeImagesWithModel, t as describeImageWithModel } from "./image-runtime-BthtM2hz.js";
import "./media-understanding-DRzhEA6T.js";
//#region extensions/anthropic/media-understanding-provider.ts
/**
* Anthropic media-understanding provider descriptor. It routes image and native
* document description through the shared model-backed media helpers.
*/
/** Media-understanding provider for Anthropic Claude models. */
const anthropicMediaUnderstandingProvider = {
	id: "anthropic",
	capabilities: ["image"],
	defaultModels: { image: "claude-opus-4-8" },
	autoPriority: { image: 20 },
	nativeDocumentInputs: ["pdf"],
	describeImage: describeImageWithModel,
	describeImages: describeImagesWithModel
};
//#endregion
export { anthropicMediaUnderstandingProvider as t };
