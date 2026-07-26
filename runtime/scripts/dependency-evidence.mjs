import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJsonPath = join(runtimeRoot, 'package.json');
const packageLockPath = join(runtimeRoot, 'package-lock.json');
const outputPath = join(runtimeRoot, 'baseline', 'dependency-manifest.json');

const packageJsonText = readFileSync(packageJsonPath, 'utf8');
const packageLockText = readFileSync(packageLockPath, 'utf8');
const packageJson = JSON.parse(packageJsonText);
const packageLock = JSON.parse(packageLockText);

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function packageNameFromPath(path, metadata) {
  if (metadata?.name) return metadata.name;
  const marker = 'node_modules/';
  const index = path.lastIndexOf(marker);
  return index >= 0 ? path.slice(index + marker.length) : path || packageJson.name;
}

const directRuntime = new Set(Object.keys(packageJson.dependencies ?? {}));
const directDev = new Set(Object.keys(packageJson.devDependencies ?? {}));
const packages = Object.entries(packageLock.packages ?? {})
  .filter(([path]) => path !== '')
  .map(([path, metadata]) => {
    const name = packageNameFromPath(path, metadata);
    return {
      path,
      name,
      version: metadata.version ?? 'unknown',
      integrity: metadata.integrity ?? null,
      resolved: metadata.resolved ?? null,
      license: metadata.license ?? null,
      dev: metadata.dev === true,
      optional: metadata.optional === true,
      directRuntime: directRuntime.has(name),
      directDev: directDev.has(name),
    };
  })
  .sort((left, right) => left.path.localeCompare(right.path));

const manifest = {
  schema: 'awkn-dependency-manifest/v1',
  source: {
    packageJsonSha256: sha256(packageJsonText),
    packageLockSha256: sha256(packageLockText),
    lockfileVersion: packageLock.lockfileVersion ?? null,
  },
  project: {
    name: packageJson.name,
    version: packageJson.version,
    nodeEngine: packageJson.engines?.node ?? null,
  },
  summary: {
    packageEntries: packages.length,
    directRuntime: packages.filter((item) => item.directRuntime).length,
    directDev: packages.filter((item) => item.directDev).length,
    transitive: packages.filter((item) => !item.directRuntime && !item.directDev).length,
    missingIntegrity: packages.filter((item) => item.integrity === null).length,
    missingLicense: packages.filter((item) => item.license === null).length,
  },
  directDependencies: {
    runtime: Object.fromEntries(Object.entries(packageJson.dependencies ?? {}).sort(([a], [b]) => a.localeCompare(b))),
    development: Object.fromEntries(Object.entries(packageJson.devDependencies ?? {}).sort(([a], [b]) => a.localeCompare(b))),
  },
  packages,
};

writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(manifest.summary, null, 2));
console.log(`Dependency manifest: ${outputPath}`);
