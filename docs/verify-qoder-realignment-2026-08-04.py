#!/usr/bin/env python3
"""Verify post-realignment state: every Q-* entry's SHA256 matches the actual file."""
import json
import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "docs" / "absorption-registry.json"

QODER_CACHE = Path(r"C:\Users\10919\.qoder-cn\plugins\cache\qoder-marketplace")
ENG_ABSORBED = ROOT / "skills" / "awkn-技能治理" / "absorbed-skills" / "qoder-marketplace-2026-08"

reg = json.loads(REGISTRY.read_text(encoding="utf-8"))

print("=== After realignment verification ===")
print(f"realignedAt: {reg.get('realignedAt')}")
print(f"entries: {len(reg['entries'])}")
print()

q_entries = [e for e in reg["entries"] if e["id"].startswith("Q-")]
print(f"Qoder plugin entries ({len(q_entries)}):")
all_ok = True
for e in q_entries:
    sha = next(iter(e["sha256"].values()))
    qod = next(iter(e["qoderCacheSha256"].values()))
    prov = e["sha256Provenance"]
    impl_path = ROOT / next(iter(e["sha256"].keys()))
    actual = hashlib.sha256(impl_path.read_bytes()).hexdigest()
    match_engine = sha == actual
    if not match_engine:
        all_ok = False
    impl_rel = next(iter(e["sha256"].keys()))
    parts = impl_rel.split("/")
    short = f"{parts[-3]}/{parts[-2]}"
    print(f"  {e['id']:>4} {short}")
    print(f"     engine registry : {sha[:24]}...")
    print(f"     qoder cache     : {qod[:24]}...")
    print(f"     actual file     : {actual[:24]}...  match={match_engine}")
    print(f"     bytes eng/cache : {prov['engineBytes']}/{prov['qoderCacheBytes']}")
    assert qod == prov["qoder_cache_sha256"], f"{e['id']}: qoder cache provenance broken"
    assert sha == prov["engine_sha256"], f"{e['id']}: engine provenance broken"

print()
if all_ok:
    print("PASS: all 6 entries are aligned and self-consistent")
    print("PASS: all SHA256 values match actual plugin.json files")
else:
    print("FAIL: some entries are out of sync")
    raise SystemExit(1)