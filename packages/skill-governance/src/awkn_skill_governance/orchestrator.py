"""G1-G7 governance orchestration outside the Skill repository."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

ENGINE_ROOT = Path(__file__).resolve().parents[4]
EVALUATOR_SRC = ENGINE_ROOT / "packages" / "skill-evaluator" / "src"
if str(EVALUATOR_SRC) not in sys.path:
    sys.path.insert(0, str(EVALUATOR_SRC))

from awkn_skill_evaluator import evaluate_skill  # noqa: E402

from .engine import (
    GovernanceError,
    current_state_for,
    desired_decision,
    execute,
    load_state,
    parse_frontmatter,
    resolve_target_facts,
    resolve_target_path,
    validate_assessment,
    validate_assessment_freshness,
    validate_runtime_evidence,
    validate_transition,
)


def _route(route_id: str, component: str, status: str, **details: Any) -> dict[str, Any]:
    return {"route_id": route_id, "component": component, "status": status, **details}


def _repository_inspection(request: dict[str, Any], request_path: Path) -> dict[str, Any]:
    path = resolve_target_path(request, request_path)
    if path is None:
        return {"status": "PARTIAL", "path": None, "findings": ["TARGET_PATH_NOT_PROVIDED"], "coverage": {}}
    if not path.is_dir():
        return {"status": "FAILED", "path": str(path), "findings": ["TARGET_SKILL_DIR_INVALID"], "coverage": {}}
    skill_doc = path / "SKILL.md"
    if not skill_doc.is_file():
        skill_doc = path / "_SKILL.md"
    files = [item.relative_to(path).as_posix() for item in path.rglob("*") if item.is_file()]
    forbidden = sorted({part for item in files for part in Path(item).parts if part in {"absorbed-skills", "data", "logs", "telemetry"}})
    findings: list[str] = []
    if not skill_doc.is_file():
        findings.append("TARGET_SKILL_DOCUMENT_MISSING")
    if forbidden:
        findings.append("SKILL_REPOSITORY_POLLUTION:" + ",".join(forbidden))
    return {
        "status": "OK" if not findings else "FAILED",
        "path": str(path),
        "skill_document": str(skill_doc) if skill_doc.is_file() else None,
        "file_count": len(files),
        "findings": findings,
        "coverage": {"files": files[:500]},
    }


def _registry_inspection(request: dict[str, Any], request_path: Path) -> dict[str, Any]:
    path = resolve_target_path(request, request_path)
    if path is None or not path.is_dir():
        target = request.get("target") if isinstance(request.get("target"), dict) else {}
        return {"status": "PARTIAL", "record": {"id": target.get("id"), "version": target.get("version"), "path": str(path) if path else None}, "conflicts": []}
    skill_doc = path / "SKILL.md"
    if not skill_doc.is_file():
        skill_doc = path / "_SKILL.md"
    metadata = parse_frontmatter(skill_doc.read_text(encoding="utf-8", errors="ignore")) if skill_doc.is_file() else {}
    conflicts: list[str] = []
    if not metadata.get("name"):
        conflicts.append("SKILL_ID_MISSING")
    if not metadata.get("version"):
        conflicts.append("SKILL_VERSION_MISSING")
    return {
        "status": "OK" if not conflicts else "FAILED",
        "record": {"id": metadata.get("name") or path.name, "version": metadata.get("version") or "0.0.0", "path": str(path), "execution_mode": metadata.get("execution_mode")},
        "conflicts": conflicts,
    }


def _resolve_or_run_assessment(request: dict[str, Any], request_path: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    if isinstance(request.get("assessment_result"), dict):
        assessment = request["assessment_result"]
        return assessment, {"status": "REUSED", "assessment_id": assessment.get("assessment_id")}
    path = resolve_target_path(request, request_path)
    if path is None:
        raise GovernanceError("TARGET_PATH_REQUIRED_FOR_ASSESSMENT")
    context = request.get("evaluation_context") if isinstance(request.get("evaluation_context"), dict) else {}
    mode = str(request.get("evaluation_mode") or "full")
    evaluation = evaluate_skill(path, mode=mode, context=context)
    if evaluation.get("status") in {"FAILED", "FAIL"}:
        raise GovernanceError(f"ASSESSMENT_FAILED:{evaluation.get('error') or evaluation.get('status')}")
    assessment = evaluation.get("assessment_result")
    if not isinstance(assessment, dict):
        raise GovernanceError("ASSESSMENT_RESULT_MISSING")
    request["assessment_result"] = assessment
    return assessment, evaluation


def _lifecycle_inspection(request: dict[str, Any], assessment: dict[str, Any], state_path: Path) -> dict[str, Any]:
    state = load_state(state_path)
    skill_id = str(assessment["skill"].get("id") or "")
    current = current_state_for(state, skill_id)
    desired = desired_decision(request, assessment, current)
    try:
        validate_transition(current, desired)
        allowed, error = True, None
    except GovernanceError as exc:
        allowed, error = False, str(exc)
    return {"status": "OK" if allowed else "BLOCKED", "current_state": current, "proposed_state": desired, "transition_allowed": allowed, "error": error, "state_version": state["version"]}


def orchestrate(command: str, request: dict[str, Any], request_path: Path, state_path: Path, receipt_dir: Path) -> dict[str, Any]:
    trace: list[dict[str, Any]] = []

    g2 = _repository_inspection(request, request_path)
    trace.append(_route("G2", "repository-inspection", g2["status"], output=g2))
    if g2["status"] == "FAILED":
        return {"status": "FAILED", "error": "REPOSITORY_INSPECTION_FAILED", "route_trace": trace}

    g1 = _registry_inspection(request, request_path)
    trace.append(_route("G1", "registry", g1["status"], output=g1))
    if g1["status"] == "FAILED":
        return {"status": "FAILED", "error": "REGISTRY_INSPECTION_FAILED", "route_trace": trace}

    assessment, evaluation = _resolve_or_run_assessment(request, request_path)
    trace.append(_route("EVAL", "skill-evaluator-package", "PASS", assessment_id=assessment.get("assessment_id"), evaluation=evaluation))

    validate_assessment(assessment)
    freshness = validate_assessment_freshness(request, request_path, assessment, required=False)
    facts = resolve_target_facts(request, request_path)
    trace.append(_route("G7", "platform-adapters", "PASS", contract_version=assessment.get("contract_version"), freshness=freshness, target_facts=facts))

    g3 = _lifecycle_inspection(request, assessment, state_path)
    trace.append(_route("G3", "lifecycle", g3["status"], output=g3))
    trace.append(_route("G5", "fusion-governance", "NOT_APPLICABLE", reason="当前 operation 不涉及技能融合"))

    if g3["proposed_state"] == "ACTIVE":
        try:
            validate_runtime_evidence(request)
            g6_status, g6_error = "PASS", None
        except GovernanceError as exc:
            g6_status, g6_error = "BLOCKED", str(exc)
        trace.append(_route("G6", "runtime-observability", g6_status, error=g6_error, evidence=request.get("runtime_evidence")))
    else:
        trace.append(_route("G6", "runtime-observability", "NOT_APPLICABLE", reason=f"目标状态为 {g3['proposed_state']}"))

    decision = execute(command, request, request_path, state_path, receipt_dir)
    trace.append(_route("G4", "approval-rollback", "PASS", decision_id=decision.get("decision_id"), write_applied=decision.get("write_applied")))
    return {"status": "PASS", "command": command, "assessment_result": assessment, "governance_decision": decision, "route_trace": trace}
