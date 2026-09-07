// Copies non-TypeScript assets (SQL migrations) that `tsc` does not emit
// into the build output, so `dist/` is fully self-contained at runtime.
const fs = require('node:fs');
const path = require('node:path');

const srcDir = path.join(__dirname, '..', 'src', 'memory', 'migrations');
const destDir = path.join(__dirname, '..', 'dist', 'memory', 'migrations');

fs.mkdirSync(destDir, { recursive: true });
for (const file of fs.readdirSync(srcDir)) {
  if (file.endsWith('.sql')) {
    fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
  }
}

// eslint-disable-next-line no-console
console.log(`copied migrations from ${srcDir} to ${destDir}`);
