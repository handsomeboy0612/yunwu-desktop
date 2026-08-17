/**
 * Host loader entry for the OpenLux account plugin.
 *
 * Empty for now: the sign-in step lives entirely in `./client`. The host half
 * exists because a composition entry loads the package's main export, and
 * `modules` only serves a browser bundle for a package the Loader has an entry
 * for. Sign-in requests that a browser origin cannot make (the captcha and
 * balance endpoints answer without CORS headers) will move in here.
 */

/** Host plugin body 鈥?no host-side behavior yet. */
export function apply(): void {}
