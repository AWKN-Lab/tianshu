#!/usr/bin/env python3
"""CLI workflow for AWKN Skill governance.

The workflow imports execution packages from tianshu/packages and stores mutable
state under tianshu/runtime/data/skill-governance.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ENGINE_ROOT = Path(__file__).resolve().parents[2]
GOVERNANCE_SRC = ENGINE_ROOT / "packages" / "skill-governance" / "src"
EVALUATOR_SRC = ENGINE_ROOT / "packages" / "skill-evaluator" / "src"
for path in (GOVERNANCE_SRC, EVALUATOR_SRC):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from awkn_skill_governance import GovernanceError, orchestrate  # noqa: E402
from awkn_skill_governance.engine import load_json  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Run AWKN G1-G7 Skill governance workflow.")
    parser.add_argument("command", choices=["inspect", "plan", "apply", "rollback"])
    parser.add_argument("--request", required=True)
    parser.add_argument("--state-file")
    parser.add_argument("--receipt-dir")
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()

    request_path = Path(args.request).resolve()
    runtime_root = ENGINE_ROOT / "runtime" / "data" / "skill-governance"
    state_path = Path(args.state_file).resolve() if args.state_file else runtime_root / "state" / "governance-state.json"
    receipt_dir = Path(args.receipt_dir).resolve() if args.receipt_dir else runtime_root / "receipts"
    try:
        request = load_json(request_path)
        result = orchestrate(args.command, request, request_path, state_path, receipt_dir)
    except (GovernanceError, OSError, ValueError, json.JSONDecodeError) as exc:
        result = {"status": "FAILED", "error": str(exc), "route_trace": []}
    print(json.dumps(result, ensure_ascii=False, indent=2 if args.pretty else None))
    return 0 if result.get("status") == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
