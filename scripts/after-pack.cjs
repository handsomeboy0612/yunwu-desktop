'use strict';

const fs = require('fs');
const path = require('path');

/**
 * electron-builder intentionally strips nested directories literally named
 * `node_modules` from `extraResources`/`extraFiles`, even with an explicit
 * `filter: ["**\/*"]` (see electron-userland/electron-builder#3104 / #3185).
 * Our bundled OpenClaw kernel ships a full npm dependency tree (274 top-level
 * packages + nested node_modules), so that filtering breaks the packaged app
 * with `ERR_MODULE_NOT_FOUND` (e.g. `json5`) at runtime.
 *
 * This afterPack hook runs AFTER electron-builder has finished copying/filtering
 * the app, so a plain recursive copy preserves every file (including all nested
 * node_modules and symlink-resolved content) verbatim.
 */
exports.default = async function afterPack(context) {
  const projectDir =
    (context.packager && context.packager.projectDir) || process.cwd();
  const src = path.join(projectDir, 'resources', 'openclaw');
  const dest = path.join(context.appOutDir, 'resources', 'openclaw');

  if (!fs.existsSync(src)) {
    throw new Error(
      `[after-pack] kernel staging not found: ${src}. Did you run "npm run prepare-kernel" first?`
    );
  }

  const entry = path.join(src, 'openclaw.mjs');
  if (!fs.existsSync(entry)) {
    throw new Error(`[after-pack] kernel entry missing: ${entry}`);
  }

  /** Wipe any partial copy electron-builder may have produced, then copy fully. */
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });

  const nmDir = path.join(dest, 'node_modules');
  const pkgCount = fs.existsSync(nmDir) ? fs.readdirSync(nmDir).length : 0;
  if (pkgCount === 0) {
    throw new Error(
      `[after-pack] copy produced empty node_modules at ${nmDir}; aborting to avoid shipping a broken kernel.`
    );
  }

  console.log(
    `[after-pack] kernel copied -> ${dest} (node_modules packages: ${pkgCount})`
  );

  // 自研插件源码:开发期从 app.getAppPath()/resources 读,打包后落到
  // process.resourcesPath/<name>,与内核同级。漏拷的话安装链路会找不到入口。
  for (const name of ['persona-plugin', 'yunwu-video-plugin']) {
    const pluginSrc = path.join(projectDir, 'resources', name);
    const pluginDest = path.join(context.appOutDir, 'resources', name);
    if (!fs.existsSync(path.join(pluginSrc, 'index.mjs'))) {
      console.warn(`[after-pack] skip missing plugin source: ${pluginSrc}`);
      continue;
    }
    fs.rmSync(pluginDest, { recursive: true, force: true });
    fs.cpSync(pluginSrc, pluginDest, { recursive: true });
    console.log(`[after-pack] plugin copied -> ${pluginDest}`);
  }
};
