#!/usr/bin/env python3
"""
Install Qoder marketplace 6 plugins into the engine skills/ tree as a single
namespaced container: skills/qoder-marketplace-2026-08/<plugin>/<ver>/

Stage 1: copy (no delete) so we can SHA256-verify before destructive step.
"""
from __future__ import annotations
import hashlib
import json
import shutil
from pathlib import Path

SRC = Path(r'D:\awkn-lab\awkn引擎\skills\awkn-技能治理\absorbed-skills\qoder-marketplace-2026-08')
DST = Path(r'D:\awkn-lab\awkn引擎\skills\qoder-marketplace-2026-08')
REGISTRY = Path(r'D:\awkn-lab\awkn引擎\docs\absorption-registry.json')

# 6 plugins to install (id, plugin name)
PLUGINS = [
    ('Q-1', 'qmind-knowledge'),
    ('Q-2', 'architecture-visualization'),
    ('Q-3', 'design-review'),
    ('Q-4', 'alibabacloud-core'),
    ('Q-5', 'meoo'),
    ('Q-6', 'wxz-cli'),
]


def sha256_of(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main() -> int:
    DST.mkdir(parents=True, exist_ok=True)
    print(f'[STAGE 1] target: {DST}')
    print(f'[STAGE 1] source: {SRC}')
    print()

    summary = []
    for qid, name in PLUGINS:
        src_plugin = SRC / name
        if not src_plugin.is_dir():
            print(f'  [SKIP] {qid} {name}: source not found at {src_plugin}')
            continue
        dst_plugin = DST / name
        if dst_plugin.exists():
            print(f'  [SKIP] {qid} {name}: already installed at {dst_plugin}')
            continue
        # Copy the whole plugin container (subdirs + .qoder-plugin + skills + etc.)
        shutil.copytree(src_plugin, dst_plugin)
        # Hash the canonical plugin.json (if present)
        # plugin.json lives under <plugin>/<ver>/.qoder-plugin/plugin.json
        versions = [v for v in dst_plugin.iterdir() if v.is_dir()]
        if not versions:
            print(f'  [WARN] {qid} {name}: no version subdir')
            continue
        ver_dir = versions[0]
        plugin_json = ver_dir / '.qoder-plugin' / 'plugin.json'
        skill_count = sum(1 for _ in ver_dir.rglob('SKILL.md'))
        file_count = sum(1 for x in ver_dir.rglob('*') if x.is_file())
        sha = sha256_of(plugin_json) if plugin_json.exists() else '(no plugin.json)'
        # verify source == destination sha256 (no content drift)
        src_ver = src_plugin / ver_dir.name
        src_pj = src_ver / '.qoder-plugin' / 'plugin.json'
        src_sha = sha256_of(src_pj) if src_pj.exists() else '(no plugin.json)'
        ok = sha == src_sha
        summary.append({
            'qid': qid,
            'name': name,
            'version': ver_dir.name,
            'skills': skill_count,
            'files': file_count,
            'sha256': sha,
            'src_sha256': src_sha,
            'match': ok,
            'new_path': str(dst_plugin / ver_dir.name / '.qoder-plugin' / 'plugin.json').replace(
                r'D:\awkn-lab\awkn引擎\\', ''
            ),
        })
        print(f'  [OK]   {qid} {name}/{ver_dir.name}: {skill_count} skills / {file_count} files / sha {sha[:12]}... match={ok}')

    print()
    print(f'[STAGE 1 DONE] {len(summary)} plugins installed to {DST}')

    # write a manifest snapshot for stage 2
    manifest = DST / '.install-manifest-2026-08-04.json'
    manifest.write_text(
        json.dumps(summary, indent=2, ensure_ascii=False),
        encoding='utf-8',
    )
    print(f'[STAGE 1 DONE] manifest: {manifest}')

    return 0


if __name__ == '__main__':
    raise SystemExit(main())