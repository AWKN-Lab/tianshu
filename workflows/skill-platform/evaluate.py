#!/usr/bin/env python3
"""CLI workflow for AWKN Skill evaluation.

Workflow code is intentionally outside AWKN-Lab/skills.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ENGINE_ROOT = Path(__file__).resolve().parents[2]
PACKAGE_SRC = ENGINE_ROOT / "packages" / "skill-evaluator" / "src"
if str(PACKAGE_SRC) not in sys.path:
    sys.path.insert(0, str(PACKAGE_SRC))

from awkn_skill_evaluator import evaluate_skill  # noqa: E402


def _load_context(path: str | None) -> dict:
    if not path:
        return {}
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("CONTEXT_OBJECT_REQUIRED")
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description="Run AWKN E1-E6 Skill evaluation workflow.")
    parser.add_argument("skill_dir")
    parser.add_argument("--mode", choices=["quick", "full", "boost", "batch"], default="full")
    parser.add_argument("--context")
    parser.add_argument("--output")
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()
    try:
        result = evaluate_skill(args.skill_dir, mode=args.mode, context=_load_context(args.context))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        result = {"status": "FAILED", "error": str(exc), "route_trace": []}
    rendered = json.dumps(result, ensure_ascii=False, indent=2 if args.pretty else None)
    if args.output:
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 1 if result.get("status") in {"FAILED", "FAIL"} else 0


if __name__ == "__main__":
    raise SystemExit(main())
