import { t as definePluginEntry } from "../../plugin-entry-BZpzqykQ.js";
import { t as buildFalImageGenerationProvider } from "../../image-generation-provider-DprX484s.js";
import { t as buildFalMusicGenerationProvider } from "../../music-generation-provider-Lvdl0NZk.js";
import { t as createFalProvider } from "../../provider-registration-C2uG-REv.js";
import { t as buildFalVideoGenerationProvider } from "../../video-generation-provider-DoTYGy3a.js";
var fal_default = definePluginEntry({
	id: "fal",
	name: "fal Provider",
	description: "Bundled fal image, video, and music generation provider",
	register(api) {
		api.registerProvider(createFalProvider());
		api.registerImageGenerationProvider(buildFalImageGenerationProvider());
		api.registerMusicGenerationProvider(buildFalMusicGenerationProvider());
		api.registerVideoGenerationProvider(buildFalVideoGenerationProvider());
	}
});
//#endregion
export { fal_default as default };
