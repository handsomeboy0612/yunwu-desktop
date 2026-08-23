import { defineConfig } from 'tsdown'

// The browser bundle registers itself with the shell's module loader under the
// package name, because that is the id `modules` advertises when it scans this
// package's `dsh.client` field and serves /plugins/<id>/client.js. A mismatch
// here loads the script but never resolves the entry.
const PACKAGE_NAME = 'openlux-plugin-account'

export default defineConfig([
  {
    name: PACKAGE_NAME,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: true,
  },
  {
    name: `${PACKAGE_NAME}/client`,
    entry: { client: 'src/client/index.ts' },
    tsconfig: 'tsconfig.client.json',
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: true,
    // Shared with every other client bundle through the module loader; bundling
    // a second React or a second slots registry would split the app's state.
    // Every entry here is one the shell shares into the browser's frozen module
    // table (`client/web/src/platform.ts`: PLATFORM_MODULES plus the preloaded
    // runtime client). That list is also the limit: a require the table cannot
    // answer throws at load, bundling one of these instead would split the app's
    // state across two copies, and any other @deepseek-ai value import is a
    // cross-plugin import the kernel's own build gate rejects — collaboration
    // goes through cordis services or slots.
    external: [
      'react',
      'react/jsx-runtime',
      'react-dom',
      'react-dom/client',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-runtime/client',
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-ui-primitives',
    ],
    noExternal: (id: string) => id.startsWith('@deepseek-ai/') ? undefined : true,
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
