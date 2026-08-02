import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = join(runtimeRoot, 'src');
const reportPath = join(runtimeRoot, 'architecture-scan.json');

const componentRoots = new Set([
  'contracts',
  'input',
  'intent',
  'context',
  'policy',
  'skills',
  'broker',
  'loop',
  'delivery',
  'outcome',
  'memory',
  'evolve',
  'workflow',
  'observability',
  'core',
  'tools',
  'goal',
  'review',
]);

/**
 * These roots are governed immediately. Legacy roots remain report-only until
 * their dedicated Adapter/Shadow work package moves them behind public ports.
 */
const strictRoots = new Set([
  'contracts',
  'input',
  'intent',
  'context',
  'policy',
  'skills',
  'broker',
  'loop',
  'delivery',
  'outcome',
  'review',
]);

/**
 * Every exception must name its removal work package. New exceptions require
 * architecture review; this list is a debt register, not a wildcard bypass.
 */
const legacyExceptions = new Map([
  ['ARCH-004:skills/manager.ts', {
    workPackage: 'WP-AOS-07',
    reason: 'Engine v2 SkillsManager compatibility singleton; remove after Skill Registry composition-root migration',
  }],
]);

function toPosix(value) {
  return value.split(sep).join('/');
}

function listTypeScriptFiles(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const fullPath = join(directory, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) walk(fullPath);
      else if (stat.isFile() && extname(entry) === '.ts') files.push(fullPath);
    }
  };
  walk(root);
  return files.sort();
}

function componentOf(relativePath) {
  const [root] = relativePath.split('/');
  return componentRoots.has(root) ? root : null;
}

function resolveRelativeImport(importer, specifier) {
  if (!specifier.startsWith('.')) return null;
  return toPosix(relative(srcRoot, resolve(dirname(importer), specifier)));
}

function isAllowedCrossComponentTarget(targetPath) {
  return targetPath.endsWith('/public')
    || targetPath.endsWith('/public.js')
    || targetPath.includes('/ports/inbound/');
}

const files = listTypeScriptFiles(srcRoot);
const findings = {
  directDbImports: [],
  moduleSingletons: [],
  processEnvInCoreLayers: [],
  crossComponentImports: [],
};
const violations = [];
const legacyExceptionsUsed = [];

function registerViolation(violation) {
  const exception = legacyExceptions.get(`${violation.rule}:${violation.file}`);
  if (exception) {
    legacyExceptionsUsed.push({ ...violation, ...exception });
    return;
  }
  violations.push(violation);
}

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const relativePath = toPosix(relative(srcRoot, file));
  const sourceComponent = componentOf(relativePath);
  const strict = sourceComponent !== null && strictRoots.has(sourceComponent);

  const importPattern = /(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    const directDb = /(?:^|\/)store\/db(?:\.js)?$/.test(specifier);
    if (directDb) {
      findings.directDbImports.push({ file: relativePath, specifier });
      if (strict) registerViolation({ rule: 'ARCH-003', file: relativePath, specifier, message: 'strict component imports store/db directly' });
    }

    const targetPath = resolveRelativeImport(file, specifier);
    if (targetPath === null || sourceComponent === null) continue;
    const targetComponent = componentOf(targetPath);
    if (targetComponent === null || targetComponent === sourceComponent || targetComponent === 'contracts') continue;

    findings.crossComponentImports.push({ file: relativePath, sourceComponent, targetComponent, targetPath });
    if (strict && !isAllowedCrossComponentTarget(targetPath)) {
      registerViolation({
        rule: 'ARCH-002',
        file: relativePath,
        targetPath,
        message: 'cross-component import bypasses public.ts or inbound port',
      });
    }
  }

  if (/\blet\s+instance\s*(?::|=)/.test(source)) {
    findings.moduleSingletons.push({ file: relativePath });
    if (strict) registerViolation({ rule: 'ARCH-004', file: relativePath, message: 'strict component declares a mutable module singleton' });
  }

  if ((relativePath.includes('/domain/') || relativePath.includes('/application/')) && /\bprocess\.env\b/.test(source)) {
    findings.processEnvInCoreLayers.push({ file: relativePath });
    registerViolation({ rule: 'ARCH-006', file: relativePath, message: 'Domain/Application reads process.env directly' });
  }

  if (sourceComponent === 'contracts') {
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) continue;
      const targetPath = resolveRelativeImport(file, specifier);
      if (targetPath !== null && componentOf(targetPath) !== 'contracts') {
        registerViolation({ rule: 'ARCH-001', file: relativePath, targetPath, message: 'contracts depend on runtime implementation' });
      }
    }
  }
}

// ===== ARCH-007: Migration version continuity check =====
// 防止合并冲突解决时静默丢失迁移版本（跨文件一致性校验）
// 触发经验：E104 版本快照陷阱 + 复盘 2026-07-30 行动项 P1
const migrationRegistryPath = join(srcRoot, 'store', 'agent-os-migration-registry.ts');
const migrationCheck = (() => {
  try {
    const source = readFileSync(migrationRegistryPath, 'utf8');
    const versions = [];
    for (const match of source.matchAll(/version:\s*(\d+)/g)) {
      versions.push(Number.parseInt(match[1], 10));
    }
    if (versions.length === 0) {
      return { ok: false, reason: 'no migration versions found in agent-os-migration-registry.ts', versions: [] };
    }
    const duplicates = versions.filter((v, i) => versions.indexOf(v) !== i);
    const sorted = [...versions].sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] !== sorted[i - 1] + 1) {
        gaps.push({ from: sorted[i - 1], to: sorted[i] });
      }
    }
    const ok = duplicates.length === 0 && gaps.length === 0;
    return {
      ok,
      versions: sorted,
      latest: sorted[sorted.length - 1],
      duplicates,
      gaps,
      reason: ok
        ? `migration versions continuous (${sorted[0]}..${sorted[sorted.length - 1]})`
        : `migration versions broken: duplicates=[${duplicates.join(',')}] gaps=${JSON.stringify(gaps)}`,
    };
  } catch (error) {
    return { ok: false, reason: `failed to read migration registry: ${error instanceof Error ? error.message : String(error)}`, versions: [] };
  }
})();

if (!migrationCheck.ok) {
  registerViolation({
    rule: 'ARCH-007',
    file: 'store/agent-os-migration-registry.ts',
    message: migrationCheck.reason,
  });
}

const report = {
  schema: 'awkn-architecture-scan-report/v1',
  generatedAt: new Date().toISOString(),
  runtime: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  scannedFiles: files.length,
  strictRoots: [...strictRoots].sort(),
  summary: {
    directDbImports: findings.directDbImports.length,
    moduleSingletons: findings.moduleSingletons.length,
    processEnvInCoreLayers: findings.processEnvInCoreLayers.length,
    crossComponentImports: findings.crossComponentImports.length,
    legacyExceptionsUsed: legacyExceptionsUsed.length,
    blockingViolations: violations.length,
    migrationContinuity: migrationCheck.ok ? 'OK' : 'BROKEN',
    migrationLatest: migrationCheck.latest ?? null,
  },
  findings,
  legacyExceptionsUsed,
  violations,
  migrationCheck,
};

writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report.summary, null, 2));
console.log(`Architecture report: ${reportPath}`);

for (const exception of legacyExceptionsUsed) {
  console.warn(`${exception.rule} legacy exception ${exception.file} → ${exception.workPackage}`);
}

if (violations.length > 0) {
  for (const violation of violations) console.error(`${violation.rule} ${violation.file}: ${violation.message}`);
  process.exitCode = 1;
}
