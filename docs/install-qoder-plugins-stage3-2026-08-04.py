#!/usr/bin/env python3
"""
Stage 3: delete the 6 plugin containers from the old absorbed-skills/ path.

Important: the awkn-技能治理/1.0.0/ backup subdir under the same parent
(qualitative-audit from the 2026-08-04 skill-system restore) MUST be kept.
Only the 6 specific plugin dirs in PLUGINS are removed.
"""
from __future__ import annotations
import shutil
from pathlib import Path

SRC = Path(r'D:\awkn-lab\awkn引擎\skills\awkn-技能治理\absorbed-skills\qoder-marketplace-2026-08')
DST = Path(r'D:\awkn-lab\awkn引擎\skills\qoder-marketplace-2026-08')

PLUGINS = [
    'qmind-knowledge',
    'architecture-visualization',
    'design-review',
    'alibabacloud-core',
    'meoo',
    'wxz-cli',
]

# Sanity check: every plugin must already be at the new location
print('[STAGE 3] pre-flight: confirm all 6 plugins exist at new location')
for name in PLUGINS:
    new = DST / name
    if not new.is_dir():
        raise RuntimeError(f'PRE-FLIGHT FAIL: {new} does not exist; refusing to delete source')
print('  [OK] all 6 plugins exist at new location')
print()

print('[STAGE 3] deleting old paths')
for name in PLUGINS:
    old = SRC / name
    if not old.is_dir():
        print(f'  [SKIP] {name}: not present at {old}')
        continue
    shutil.rmtree(old)
    print(f'  [DEL]  {name}: removed {old}')

print()
# Show what remains under the old path
print(f'[STAGE 3] remaining contents of {SRC}:')
if SRC.is_dir():
    for child in sorted(SRC.iterdir()):
        marker = 'DIR ' if child.is_dir() else 'FILE'
        print(f'  {marker} {child.name}')
else:
    print('  (path no longer exists)')
print()

# Confirm new location is intact
print(f'[STAGE 3] new location {DST}:')
total_files = 0
total_skills = 0
for p in sorted(DST.iterdir()):
    if not p.is_dir() or p.name.startswith('.'):
        continue
    for v in p.iterdir():
        if not v.is_dir():
            continue
        skills = sum(1 for _ in v.rglob('SKILL.md'))
        files = sum(1 for x in v.rglob('*') if x.is_file())
        total_skills += skills
        total_files += files
        print(f'  [DIR] {p.name}/{v.name}: {skills} skills / {files} files')
print(f'  TOTAL: {total_skills} skills / {total_files} files')
print()
print('[STAGE 3 DONE] old paths removed, new paths intact')