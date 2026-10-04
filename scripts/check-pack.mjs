// Checks what `npm publish` would ship: the build, the docs and the example config, and nothing else (no sources, tests,
// benchmark, CI files or local state). Run after `npm run build`: node scripts/check-pack.mjs
import { execSync } from 'node:child_process';
import process from 'node:process';

const [pack] = JSON.parse(execSync('npm pack --dry-run --json --ignore-scripts', { encoding: 'utf8' }));
const files = pack.files.map((f) => f.path.replace(/\\/g, '/')).sort();
const allowed = [/^dist\/cli\.js(\.map)?$/, /^(README|ROUTING|CHANGELOG)\.md$/, /^LICENSE$/, /^package\.json$/, /^smart\.config\.example\.json$/];
const unexpected = files.filter((f) => !allowed.some((re) => re.test(f)));
const required = ['dist/cli.js', 'package.json', 'README.md', 'LICENSE'];
const missing = required.filter((f) => !files.includes(f));
if (unexpected.length || missing.length) {
  process.stderr.write(`npm package check failed.${unexpected.length ? `\nUnexpected: ${unexpected.join(', ')}` : ''}${missing.length ? `\nMissing: ${missing.join(', ')}` : ''}\n`);
  process.exit(1);
}
process.stdout.write(`npm package: ${files.length} files, ${(pack.unpackedSize / 1024).toFixed(0)} KB unpacked: ${files.join(', ')}\n`);
