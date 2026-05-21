const esbuild = require('esbuild');
const watch = process.argv.includes('--watch');

const targets = [
  { entryPoints: ['src/main.ts'],    outfile: 'dist/main.js',    label: 'main'    },
  { entryPoints: ['src/preload.ts'], outfile: 'dist/preload.js', label: 'preload' },
  { entryPoints: ['src/worker.ts'],  outfile: 'dist/worker.js',  label: 'worker'  },
];

const baseConfig = {
  bundle: true,
  sourcemap: true,
  minify: false,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
};

async function main() {
  if (watch) {
    for (const { label, ...t } of targets) {
      const ctx = await esbuild.context({ ...baseConfig, ...t });
      await ctx.watch();
      console.log(`watching ${label}…`);
    }
  } else {
    await Promise.all(targets.map(({ label, ...t }) => esbuild.build({ ...baseConfig, ...t })));
    console.log('build complete');
  }
}

main().catch(() => process.exit(1));
