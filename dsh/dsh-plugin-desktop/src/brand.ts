/**
 * Product identity for this fork, in one place.
 *
 * Upstream spells these values inline at each use site (`main.ts` for the
 * Electron app name and the Windows AppUserModelId, `index.ts` for the window
 * chrome). Collecting them here keeps a rebrand to one edit and keeps the
 * divergence from upstream to a single import per file, so `git subtree pull`
 * stays a clean merge.
 *
 * `APP_ID` and `PRODUCT_NAME` must stay in step with `build.appId` and
 * `build.productName` in package.json: electron-builder writes the installer
 * from those, while `app.setName(PRODUCT_NAME)` decides the userData directory
 * at runtime. A mismatch splits one install across two state directories.
 */

/** Reverse-DNS application identity: installer, Windows taskbar grouping. */
export const APP_ID = 'ai.openlux.desktop'

/** Installed application name; also the userData directory name. */
export const PRODUCT_NAME = 'OpenLux Desktop'

/** Native window title. */
export const WINDOW_TITLE = 'OpenLux'

/**
 * Sidebar brand row label. The row reads the same as the window title on
 * purpose: it is the same fact seen from inside the page.
 */
export const WORDMARK_TEXT = WINDOW_TITLE

/**
 * Loopback route serving the brand mark to the Web surface. The Host reads the
 * file from `build/`; the client stylesheet names this path, so both planes
 * must agree on it.
 */
export const BRAND_MARK_ROUTE = '/openlux/brand-mark.png'

/**
 * Desktop and Start Menu shortcut label. Shorter than PRODUCT_NAME on purpose:
 * PRODUCT_NAME is the install identity, this is what a person reads on an icon.
 */
export const SHORTCUT_NAME = 'OpenLux'

/** Installer filename stem; electron-builder appends version, arch, and extension. */
export const INSTALLER_STEM = 'OpenLux-Desktop'
