import { t as getProviderEnvVars } from "../../provider-env-vars-DFJoFB6-.js";
import { n as listMemoryEmbeddingProviders } from "../../memory-embedding-provider-runtime-BmoQHnEI.js";
import { n as resolveMemoryFtsState, r as resolveMemoryVectorState, t as resolveMemoryCacheSummary } from "../../status-format-ExS6-yQO.js";
import "../../memory-core-host-status-BIxXfkMp.js";
import { t as DEFAULT_LOCAL_MODEL } from "../../embedding-defaults-BP3wPc9o.js";
import "../../memory-core-host-embedding-registry-5NuNE3Ay.js";
import { t as hasConfiguredMemorySecretInput } from "../../secret-input-CVx0lyPz.js";
import { t as checkQmdBinaryAvailability } from "../../engine-qmd-C0Ncp5QM.js";
import "../../memory-core-host-engine-qmd-DOd77P6g.js";
import "../../provider-env-vars-WVi82yb9.js";
import { u as configureMemoryCoreDreamingState } from "../../dreaming-state-DWd_V39L.js";
import { b as removeGroundedShortTermCandidates, s as auditShortTermPromotionArtifacts, u as loadShortTermPromotionDreamingStats, x as repairShortTermPromotionArtifacts } from "../../short-term-promotion-B-Lvx_wV.js";
import { a as createEmbeddingProvider, t as MemoryIndexManager } from "../../manager-Bu-opQiN.js";
import { r as getMemorySearchManager } from "../../memory-Bd3pODac.js";
import { t as memoryRuntime } from "../../runtime-provider-jzJM1wgO.js";
import { n as repairDreamingArtifacts, t as auditDreamingArtifacts } from "../../dreaming-repair-DynAz4Iy.js";
//#region extensions/memory-core/src/memory/provider-adapters.ts
function getBuiltinMemoryEmbeddingProviderAdapter(id) {
	return listMemoryEmbeddingProviders().find((adapter) => adapter.id === id);
}
function getBuiltinMemoryEmbeddingProviderDoctorMetadata(providerId) {
	const adapter = getBuiltinMemoryEmbeddingProviderAdapter(providerId);
	if (!adapter) return null;
	const authProviderId = adapter.authProviderId ?? adapter.id;
	return {
		providerId: adapter.id,
		authProviderId,
		envVars: getProviderEnvVars(authProviderId),
		transport: adapter.transport === "local" ? "local" : "remote",
		autoSelectPriority: adapter.autoSelectPriority
	};
}
function listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata() {
	return listMemoryEmbeddingProviders().filter((adapter) => typeof adapter.autoSelectPriority === "number").toSorted((a, b) => (a.autoSelectPriority ?? 0) - (b.autoSelectPriority ?? 0)).map((adapter) => {
		const authProviderId = adapter.authProviderId ?? adapter.id;
		return {
			providerId: adapter.id,
			authProviderId,
			envVars: getProviderEnvVars(authProviderId),
			transport: adapter.transport === "local" ? "local" : "remote",
			autoSelectPriority: adapter.autoSelectPriority
		};
	});
}
//#endregion
export { DEFAULT_LOCAL_MODEL, MemoryIndexManager, auditDreamingArtifacts, auditShortTermPromotionArtifacts, checkQmdBinaryAvailability, configureMemoryCoreDreamingState, createEmbeddingProvider, getBuiltinMemoryEmbeddingProviderDoctorMetadata, getMemorySearchManager, hasConfiguredMemorySecretInput, listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata, loadShortTermPromotionDreamingStats, memoryRuntime, removeGroundedShortTermCandidates, repairDreamingArtifacts, repairShortTermPromotionArtifacts, resolveMemoryCacheSummary, resolveMemoryFtsState, resolveMemoryVectorState };
