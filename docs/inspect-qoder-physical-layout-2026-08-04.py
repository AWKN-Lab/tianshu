#!/usr/bin/env python3
"""Show physical layout of the 6 absorbed Qoder marketplace plugins."""
from pathlib import Path

ROOT = Path(r'D:\awkn-lab\awkn引擎\skills\awkn-技能治理\absorbed-skills\qoder-marketplace-2026-08')

print(f'{"plugin":<26} {"ver":<10} {"plugin.json":<12} {"#skills":<8} total_files')
print('-' * 70)

for p in sorted(ROOT.iterdir()):
    if not p.is_dir() or p.name.startswith('awkn'):
        continue
    for v in sorted(p.iterdir()):
        if not v.is_dir():
            continue
        pj = v / '.qoder-plugin' / 'plugin.json'
        skills = sum(1 for x in v.rglob('SKILL.md'))
        all_files = sum(1 for x in v.rglob('*') if x.is_file())
        print(f'{p.name:<26} {v.name:<10} {"YES" if pj.exists() else "NO":<12} {skills:<8} {all_files}')