#!/usr/bin/env python3
"""
Realign absorption-registry.json SHA256 baselines for the 6 Qoder marketplace plugins.

Qoder cache SHA256 == registry SHA256 (original absorption baseline).
Engine-side plugin.json was normalized post-absorption (extra fields, +20~50B).
This script refreshes SHA256 to the engine-side actual values and appends a
realignment note, keeping the registry auditable.

Run:
  python docs/realign-qoder-sha256-2026-08-04.py
"""
import json
import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # docs/ -> awkn引擎/
REGISTRY = ROOT / "docs" / "absorption-registry.json"

ENG_ABSORBED = ROOT / "skills" / "awkn-技能治理" / "absorbed-skills" / "qoder-marketplace-2026-08"
QODER_CACHE = Path(r"C:\Users\10919\.qoder-cn\plugins\cache\qoder-marketplace")

PLUGIN_MAP = [
    ("Q-1", "qmind-knowledge"),
    ("Q-2", "architecture-visualization"),
    ("Q-3", "design-review"),
    ("Q-4", "alibabacloud-core"),
    ("Q-5", "meoo"),
    ("Q-6", "wxz-cli"),
]

REALIGN_TS = "2026-08-04"
REALIGN_NOTE_SUFFIX = (
    f"\n\n{REALIGN_TS} 重对齐（LF 口径）：引擎侧 plugin.json 已被规范化（追加字段，"
    f"体积增加 20~50B），SHA256 已用实测值刷新；Qoder 缓存基线保留为 "
    f"`qoderCacheSha256` 字段以便溯源。"
)


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def find_engine_plugin(plugin_name: str):
    pdir = ENG_ABSORBED / plugin_name
    versions = sorted(d for d in pdir.iterdir() if d.is_dir())
    v = versions[0]
    return v, pdir / v / ".qoder-plugin" / "plugin.json"


def find_qoder_plugin(plugin_name: str):
    pdir = QODER_CACHE / plugin_name
    versions = sorted(d for d in pdir.iterdir() if d.is_dir())
    v = versions[0]
    return pdir / v / ".qoder-plugin" / "plugin.json"


def main():
    reg = json.loads(REGISTRY.read_text(encoding="utf-8"))
    entries = {e["id"]: e for e in reg["entries"]}

    print(f"=== Before: {len(entries)} entries ===")
    diffs = []
    for qid, plugin in PLUGIN_MAP:
        eng_ver, eng_mf = find_engine_plugin(plugin)
        qod_mf = find_qoder_plugin(plugin)
        eng_sha = sha256_of(eng_mf)
        qod_sha = sha256_of(qod_mf)
        e = entries[qid]
        old_sha = next(iter(e["sha256"].values()))
        impl_key = next(iter(e["sha256"].keys()))
        if old_sha != eng_sha:
            diffs.append((qid, plugin, eng_ver.name, old_sha, eng_sha, qod_sha,
                          impl_key, e["sha256"][impl_key]))
        else:
            print(f"  {qid}/{plugin}: already aligned")

    if not diffs:
        print("No realignment needed.")
        return

    print(f"\n=== Realigning {len(diffs)} entries ===")
    for qid, plugin, version, old_sha, new_sha, qod_sha, impl_key, _ in diffs:
        e = entries[qid]
        e["sha256"] = {impl_key: new_sha}
        e["qoderCacheSha256"] = {impl_key: qod_sha}
        eng_mf = ENG_ABSORBED / plugin / version / ".qoder-plugin" / "plugin.json"
        qod_mf = find_qoder_plugin(plugin)
        e["sha256Provenance"] = {
            "engine_sha256": new_sha,
            "qoder_cache_sha256": qod_sha,
            "realignedAt": REALIGN_TS,
            "engineBytes": eng_mf.stat().st_size,
            "qoderCacheBytes": qod_mf.stat().st_size,
            "note": "Engine-side plugin.json was normalized post-absorption (e.g. added displayName / keywords / interface metadata); SHA256 differs from the Qoder-cache baseline by design.",
        }
        existing_notes = e["notes"]
        if isinstance(existing_notes, str):
            if "重对齐" not in existing_notes:
                e["notes"] = existing_notes + REALIGN_NOTE_SUFFIX
            else:
                e["notes"] = existing_notes
        else:
            e["notes"] = existing_notes
        print(f"  + {qid}/{plugin} {version}")
        print(f"    old: {old_sha[:16]}")
        print(f"    new: {new_sha[:16]}  (qoder-cache: {qod_sha[:16]})")

    if "realignedAt" not in reg:
        reg["realignedAt"] = REALIGN_TS

    REGISTRY.write_text(
        json.dumps(reg, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"\n+ Updated: {REGISTRY}")
    print(f"  entries: {len(reg['entries'])}")
    print(f"  file size: {REGISTRY.stat().st_size} bytes")


if __name__ == "__main__":
    main()