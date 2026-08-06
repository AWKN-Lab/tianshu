#!/usr/bin/env python3
"""
Stage 2: rewrite absorption-registry.json so that the 6 Q-* entries point to
their new home: skills/qoder-marketplace-2026-08/<plugin>/<ver>/

The SHA256 values do NOT change (copy was byte-perfect), only the path keys.
"""
from __future__ import annotations
import hashlib
import json
from datetime import date
from pathlib import Path

REG = Path(r'D:\awkn-lab\awkn引擎\docs\absorption-registry.json')
ROOT = Path(r'D:\awkn-lab\awkn引擎')

OLD_PREFIX = 'skills/awkn-技能治理/absorbed-skills/qoder-marketplace-2026-08'
NEW_PREFIX = 'skills/qoder-marketplace-2026-08'
TODAY = date.today().isoformat()
INSTALL_NOTE = (
    f"\n\n{TODAY} 安装（迁移到引擎 skills/ 命名空间）："
    f"从 `skills/awkn-技能治理/absorbed-skills/qoder-marketplace-2026-08/` "
    f"物理搬到 `skills/qoder-marketplace-2026-08/`，保留 plugin 容器整体结构。"
    f"SHA256 不变（内容字节级一致）；只更新 `implementedFiles` 和 `sha256` "
    f"的路径键。旧路径将在 Stage 3 删除。"
)


def relpath_check(p: str) -> Path:
    return ROOT / p


def main() -> int:
    reg = json.loads(REG.read_text(encoding='utf-8'))
    reg.setdefault('installedAt', TODAY)
    if reg.get('realignedAt') is None:
        reg['realignedAt'] = TODAY

    print(f'[STAGE 2] registry: {REG}')
    print(f'[STAGE 2] {len([e for e in reg["entries"] if e["id"].startswith("Q-")])} Q-* entries to rewrite')
    print()

    summary = []
    for e in reg['entries']:
        if not e['id'].startswith('Q-'):
            continue
        # 1. rewrite implementedFiles[0]
        old_impl = e['implementedFiles'][0]
        assert old_impl.startswith(OLD_PREFIX), f'{e["id"]}: unexpected impl prefix {old_impl}'
        new_impl = NEW_PREFIX + old_impl[len(OLD_PREFIX):]
        e['implementedFiles'] = [new_impl]

        # 2. rewrite sha256 dict keys
        new_sha = {}
        for k, v in e['sha256'].items():
            assert k.startswith(OLD_PREFIX), f'{e["id"]}: unexpected sha key {k}'
            new_k = NEW_PREFIX + k[len(OLD_PREFIX):]
            new_sha[new_k] = v
        e['sha256'] = new_sha

        # 3. verify SHA256 still matches the new file
        first_new_path = next(iter(new_sha))
        actual_sha = hashlib.sha256((ROOT / first_new_path).read_bytes()).hexdigest()
        stored_sha = next(iter(new_sha.values()))
        match = actual_sha == stored_sha
        print(f'  [{match and "OK" or "FAIL"}] {e["id"]} {first_new_path}')
        print(f'         stored  : {stored_sha[:24]}...')
        print(f'         actual  : {actual_sha[:24]}...')
        if not match:
            raise RuntimeError(f'{e["id"]}: SHA256 mismatch after path rewrite')
        summary.append((e['id'], first_new_path, match))

        # 4. qoderCacheSha256: keep as-is (Qoder cache path is unrelated to engine)
        # 5. sha256Provenance: keep as-is
        # 6. append install note
        if isinstance(e.get('notes'), str):
            if '安装（迁移到引擎 skills/ 命名空间）' not in e['notes']:
                e['notes'] = e['notes'] + INSTALL_NOTE
        else:
            e['notes'] = INSTALL_NOTE.lstrip()

    print()
    REG.write_text(json.dumps(reg, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(f'[STAGE 2 DONE] registry rewritten, {len(summary)} Q-* entries verified')
    print(f'[STAGE 2 DONE] installedAt: {reg["installedAt"]}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())