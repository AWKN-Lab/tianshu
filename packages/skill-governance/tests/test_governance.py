from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
ENGINE_ROOT = PACKAGE_ROOT.parents[1]
GOV_SRC = PACKAGE_ROOT / "src"
EVAL_SRC = ENGINE_ROOT / "packages" / "skill-evaluator" / "src"
for path in (GOV_SRC, EVAL_SRC):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import pytest

from awkn_skill_evaluator import evaluate_skill
from awkn_skill_governance.engine import GovernanceError, execute, load_state


def write_skill(root: Path) -> Path:
    skill = root / "demo-skill"
    skill.mkdir()
    (skill / "SKILL.md").write_text(
        "---\nname: demo-skill\ndescription: Demo formal Skill with explicit contracts and runtime service.\nversion: 1.0.0\nruntime_service: demo\n---\n\n"
        "# Demo\n\n## 输入\nrequest\n\n## 输出\nresult\n\n## 流程\nexecute\n\n## 边界\nno state\n\n## 失败处理\nerror\n\n## 验收\nresult\n",
        encoding="utf-8",
    )
    return skill


def assessment_for(skill: Path, *, passed: bool = False) -> dict:
    result = evaluate_skill(skill)
    assessment = copy.deepcopy(result["assessment_result"])
    if passed:
        assessment["gate"]["recommendation"] = "PASS"
        assessment["gate"]["blocking_findings"] = []
        assessment["security"]["static_scan"] = "PASS"
        assessment["caps"] = []
    return assessment


def base_request(skill: Path, assessment: dict, decision: str, expected: int) -> dict:
    return {
        "request_id": f"req-{decision.lower()}",
        "target": {"path": str(skill)},
        "assessment_result": assessment,
        "decision": decision,
        "write_authorized": True,
        "expected_version": expected,
        "rollback_target": "bootstrap",
        "diff": [f"state:->{decision}"],
        "candidate_author": "author-1",
    }


def approval(assessment: dict, *states: str) -> dict:
    return {
        "approval_id": "apr-1",
        "assessment_id": assessment["assessment_id"],
        "candidate_digest": assessment["skill"]["content_digest"],
        "decision": "APPROVE",
        "approved_at": "2026-08-06T00:00:00Z",
        "approved_states": list(states),
        "reviewer": {"id": "reviewer-1", "role": "skill-governor", "independent": True},
    }


def test_initial_skill_cannot_jump_to_shadow(tmp_path: Path) -> None:
    skill = write_skill(tmp_path)
    assessment = assessment_for(skill, passed=True)
    request = base_request(skill, assessment, "SHADOW", 0)
    request["approval_record"] = approval(assessment, "SHADOW")
    request["shadow_plan"] = {"traffic_scope": "1%", "metrics": ["success"], "stop_conditions": ["error"], "rollback_target": "bootstrap"}
    with pytest.raises(GovernanceError, match="INITIAL_STATE_MUST_BE_DRAFT"):
        execute("apply", request, tmp_path / "request.json", tmp_path / "runtime" / "state.json", tmp_path / "runtime" / "receipts")


def test_state_and_receipts_live_outside_skill(tmp_path: Path) -> None:
    skill = write_skill(tmp_path)
    assessment = assessment_for(skill)
    runtime = tmp_path / "runtime" / "skill-governance"
    request = base_request(skill, assessment, "DRAFT", 0)
    result = execute("apply", request, tmp_path / "request.json", runtime / "state" / "governance-state.json", runtime / "receipts")
    assert result["write_applied"] is True
    assert (runtime / "state" / "governance-state.json").is_file()
    assert list((runtime / "receipts").glob("*.json"))
    assert not (skill / "data").exists()


def test_stale_assessment_is_blocked(tmp_path: Path) -> None:
    skill = write_skill(tmp_path)
    assessment = assessment_for(skill)
    state_path = tmp_path / "runtime" / "state.json"
    receipts = tmp_path / "runtime" / "receipts"
    execute("apply", base_request(skill, assessment, "DRAFT", 0), tmp_path / "request.json", state_path, receipts)
    (skill / "SKILL.md").write_text((skill / "SKILL.md").read_text(encoding="utf-8") + "\nchanged\n", encoding="utf-8")
    request = base_request(skill, assessment, "VALIDATING", 1)
    with pytest.raises(GovernanceError, match="ASSESSMENT_STALE"):
        execute("apply", request, tmp_path / "request.json", state_path, receipts)


def test_approved_requires_independent_approval(tmp_path: Path) -> None:
    skill = write_skill(tmp_path)
    assessment = assessment_for(skill, passed=True)
    state_path = tmp_path / "state.json"
    state_path.write_text(json.dumps({
        "version": 1,
        "skills": {"demo-skill": {"state": "VALIDATING"}},
        "history": [],
        "receipts": {},
    }), encoding="utf-8")
    request = base_request(skill, assessment, "APPROVED", 1)
    with pytest.raises(GovernanceError, match="APPROVAL_RECORD_REQUIRED"):
        execute("apply", request, tmp_path / "request.json", state_path, tmp_path / "receipts")


def test_active_requires_runtime_evidence(tmp_path: Path) -> None:
    skill = write_skill(tmp_path)
    assessment = assessment_for(skill, passed=True)
    state_path = tmp_path / "state.json"
    state_path.write_text(json.dumps({
        "version": 1,
        "skills": {"demo-skill": {"state": "SHADOW"}},
        "history": [],
        "receipts": {},
    }), encoding="utf-8")
    request = base_request(skill, assessment, "ACTIVE", 1)
    request["approval_record"] = approval(assessment, "ACTIVE")
    with pytest.raises(GovernanceError, match="RUNTIME_EVIDENCE_REQUIRED"):
        execute("apply", request, tmp_path / "request.json", state_path, tmp_path / "receipts")


def test_runtime_state_shape_is_versioned(tmp_path: Path) -> None:
    state = load_state(tmp_path / "missing.json")
    assert state == {"version": 0, "skills": {}, "history": [], "receipts": {}}
