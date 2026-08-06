#!/usr/bin/env python3
"""List all 36 SKILL.md files inside the absorbed Qoder marketplace tree."""
from pathlib import Path

ROOT = Path(r'D:\awkn-lab\awkn引擎\skills\awkn-技能治理\absorbed-skills\qoder-marketplace-2026-08')

print(f'{"#":<3} {"plugin":<24} {"version":<10} {"skill_path"}')
print('-' * 100)
i = 0
seen = {}
duplicates = []
for plugin_dir in sorted(ROOT.iterdir()):
    if not plugin_dir.is_dir() or plugin_dir.name.startswith('awkn'):
        continue
    for ver_dir in sorted(plugin_dir.iterdir()):
        if not ver_dir.is_dir():
            continue
        # SKILL.md files live under <plugin>/<ver>/skills/<skill>/SKILL.md
        for skill_md in ver_dir.rglob('SKILL.md'):
            i += 1
            skill_path = skill_md.parent.relative_to(ROOT)
            skill_name = skill_md.parent.name
            print(f'{i:<3} {plugin_dir.name:<24} {ver_dir.name:<10} {skill_path}')
            if skill_name in seen:
                duplicates.append((skill_name, seen[skill_name], skill_path))
            else:
                seen[skill_name] = skill_path

print()
print(f'TOTAL SKILL.md files: {i}')
print(f'UNIQUE skill folder names: {len(seen)}')
if duplicates:
    print(f'POSSIBLE NAME COLLISIONS: {len(duplicates)}')
    for name, a, b in duplicates:
        print(f'  - {name}: {a}  VS  {b}')
else:
    print('NO name collisions between skills.')