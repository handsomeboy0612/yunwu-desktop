/**
 * Names shared by the host half that stages an attached file and the composer
 * button that sends it. Kept in its own module so the browser bundle can read
 * them without importing anything that touches `node:fs`.
 *
 * @module openlux-plugin-account/files/name
 */

/** Endpoint within this plugin's channel (`/openlux/files.stage`). */
export const FILE_STAGE_ENDPOINT = 'files.stage'

/**
 * Which model ids accept a picture (`/openlux/files.vision`).
 *
 * The composer needs this to decide where a *dropped image* goes, and the
 * kernel cannot tell it: the model catalog on the wire carries `id`, `name`,
 * `description` and `reasoning` and no modalities at all
 * (`dsh-host-apiproxy/lib/types/api/sessions.d.ts`, `ModelCatalogModel`), while
 * the fact itself lives in the settings document this plugin maintains. So the
 * browser learns the *selection* from the kernel and the *capability* from here.
 */
export const FILE_VISION_ENDPOINT = 'files.vision'

/**
 * Largest single file this accepts, in bytes.
 *
 * The bytes travel as base64 inside one JSON RPC body, so the cap is really
 * about how large a request we are willing to build in the renderer. 32 MiB is
 * the same ceiling we gave the kernel's image intake
 * (`dsh-plugin-desktop/cordis.patch.yml`, `attachment-local.maxImageBytes`),
 * so the two attachment routes refuse at the same size rather than one of them
 * silently being stricter.
 */
export const MAX_STAGED_BYTES = 33_554_432
