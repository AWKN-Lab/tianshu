"""Transactional governance kernel for formal Skills.

All mutable state lives under runtime/data. This package contains execution
logic only and must never write into AWKN-Lab/skills.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import subprocess
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

POLICY_VERSION = "3.0.0"
CONTRACT_VERSION = "1.0.0"
SUPPORTED_ASSESSMENT_CONTRACTS = {"1.0.0"}
ALLOWED_DECISIONS = {
    "DRAFT", "VALIDATING", "APPROVED", "SHADOW", "ACTIVE",
    "QUARANTINED", "RETIRED", "BLOCKED",
}
ALLOWED_TRANSITIONS = {
    "DRAFT": {"VALIDATING", "QUARANTINED"},
    "VALIDATING": {"APPROVED", "QUARANTINED"},
    "APPROVED": {"SHADOW", "QUARANTINED"},
    "SHADOW": {"ACTIVE", "QUARANTINED"},
    "ACTIVE": {"QUARANTINED", "RETIRED"},
    "QUARANTINED": {"VALIDATING", "RETIRED"},
    "RETIRED": set(),
    "BLOCKED": {"VALIDATING", "QUARANTINED", "RETIRED"},
}
SOURCE_EXTENSIONS = {
    ".md", ".py", ".js", ".ts", ".tsx", ".jsx", ".sh", ".ps1",
    ".json", ".yaml", ".yml", ".txt", ".toml",
}
EXCLUDED_PARTS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", "out",
    "data", "logs", "telemetry", "reports", "receipts", ".transactions",
    ".pytest_cache", "coverage", "absorbed-skills", "skill-sources",
}


class GovernanceError(Exception):
    """Expected governance gate failure."""


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def canonical_hash(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise GovernanceError(f"FILE_NOT_FOUND:{path}") from exc
    except json.JSONDecodeError as exc:
        raise GovernanceError(f"JSON_INVALID:{path}:{exc}") from exc
    if not isinstance(payload, dict):
        raise GovernanceError(f"JSON_OBJECT_REQUIRED:{path}")
    return payload


def _stage_json(path: Path, payload: dict[str, Any]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{os.getpid()}.{time.time_ns()}.tmp")
    data = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    with temp.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    return temp


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    temp = _stage_json(path, payload)
    try:
        os.replace(temp, path)
    except OSError:
        temp.unlink(missing_ok=True)
        raise


@contextmanager
def file_lock(lock_path: Path, timeout_seconds: float = 10.0) -> Iterator[None]:
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + timeout_seconds
    fd: int | None = None
    while fd is None:
        try:
            fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, f"pid={os.getpid()}\ncreated_at={now_utc()}\n".encode("utf-8"))
        except FileExistsError:
            if time.monotonic() >= deadline:
                raise GovernanceError("STATE_LOCK_TIMEOUT")
            time.sleep(0.05)
    try:
        yield
    finally:
        if fd is not None:
            os.close(fd)
        lock_path.unlink(missing_ok=True)


def load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": 0, "skills": {}, "history": [], "receipts": {}}
    state = load_json(path)
    if not isinstance(state.get("version"), int):
        raise GovernanceError("STATE_VERSION_INVALID")
    if not isinstance(state.get("skills"), dict) or not isinstance(state.get("history"), list):
        raise GovernanceError("STATE_SHAPE_INVALID")
    state.setdefault("receipts", {})
    if not isinstance(state["receipts"], dict):
        raise GovernanceError("STATE_RECEIPTS_INVALID")
    return state


def parse_frontmatter(content: str) -> dict[str, Any]:
    if not content.startswith("---"):
        return {}
    parts = content.split("---", 2)
    if len(parts) < 3:
        return {}
    result: dict[str, Any] = {}
    for line in parts[1].splitlines():
        if ":" not in line or line.strip().startswith("#"):
            continue
        key, raw = line.split(":", 1)
        result[key.strip()] = raw.strip().strip("\"'")
    return result


def compute_source_digest(skill_dir: Path) -> str:
    digest = hashlib.sha256()
    files: list[Path] = []
    for path in skill_dir.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in SOURCE_EXTENSIONS:
            continue
        relative_parts = path.relative_to(skill_dir).parts
        if any(part in EXCLUDED_PARTS for part in relative_parts):
            continue
        files.append(path)
    for path in sorted(files, key=lambda item: item.relative_to(skill_dir).as_posix()):
        relative = path.relative_to(skill_dir).as_posix()
        data = path.read_bytes()
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(data)
        digest.update(b"\0")
    return digest.hexdigest()


def git_commit(skill_dir: Path) -> str:
    env_sha = os.environ.get("GIT_COMMIT") or os.environ.get("GITHUB_SHA")
    if env_sha:
        return env_sha
    try:
        proc = subprocess.run(
            ["git", "-C", str(skill_dir), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
        value = proc.stdout.strip()
        if proc.returncode == 0 and len(value) >= 7:
            return value
    except (OSError, subprocess.SubprocessError):
        pass
    return "0000000"


def resolve_target_path(request: dict[str, Any], request_path: Path) -> Path | None:
    target = request.get("target") if isinstance(request.get("target"), dict) else {}
    raw = target.get("path") or request.get("skill_path")
    if not isinstance(raw, str) or not raw:
        return None
    path = Path(raw)
    if not path.is_absolute():
        path = request_path.parent / path
    return path.resolve()


def resolve_target_facts(request: dict[str, Any], request_path: Path) -> dict[str, str]:
    target = request.get("target") if isinstance(request.get("target"), dict) else {}
    facts = {
        "id": str(target.get("id") or ""),
        "version": str(target.get("version") or ""),
        "git_commit": str(target.get("git_commit") or ""),
        "content_digest": str(target.get("content_digest") or ""),
    }
    skill_dir = resolve_target_path(request, request_path)
    if skill_dir is None:
        return facts
    if not skill_dir.is_dir():
        raise GovernanceError(f"TARGET_SKILL_DIR_INVALID:{skill_dir}")
    skill_doc = skill_dir / "SKILL.md"
    if not skill_doc.is_file():
        skill_doc = skill_dir / "_SKILL.md"
    if not skill_doc.is_file():
        raise GovernanceError("TARGET_SKILL_DOCUMENT_MISSING")
    metadata = parse_frontmatter(skill_doc.read_text(encoding="utf-8", errors="ignore"))
    facts.update({
        "id": str(metadata.get("name") or skill_dir.name),
        "version": str(metadata.get("version") or "0.0.0"),
        "git_commit": git_commit(skill_dir),
        "content_digest": compute_source_digest(skill_dir),
        "path": str(skill_dir),
    })
    return facts


def resolve_assessment(request: dict[str, Any], request_path: Path) -> dict[str, Any]:
    payload = request.get("assessment_result")
    if isinstance(payload, dict):
        return payload
    raw = request.get("assessment_path")
    if isinstance(raw, str) and raw:
        path = Path(raw)
        if not path.is_absolute():
            path = request_path.parent / path
        return load_json(path.resolve())
    raise GovernanceError("ASSESSMENT_RESULT_REQUIRED")


def validate_assessment(assessment: dict[str, Any]) -> None:
    required = ["contract_version", "assessment_id", "skill", "evaluator", "scores", "security", "gate"]
    missing = [key for key in required if key not in assessment]
    if missing:
        raise GovernanceError("ASSESSMENT_FIELDS_MISSING:" + ",".join(missing))
    if assessment.get("contract_version") not in SUPPORTED_ASSESSMENT_CONTRACTS:
        raise GovernanceError("ASSESSMENT_CONTRACT_UNSUPPORTED")
    if assessment.get("gate", {}).get("recommendation") not in {"PASS", "CONDITIONAL", "FAIL"}:
        raise GovernanceError("ASSESSMENT_GATE_INVALID")
    skill = assessment.get("skill")
    if not isinstance(skill, dict) or not skill.get("id") or not skill.get("content_digest"):
        raise GovernanceError("ASSESSMENT_SKILL_INVALID")


def validate_assessment_freshness(request: dict[str, Any], request_path: Path, assessment: dict[str, Any], *, required: bool) -> dict[str, Any]:
    facts = resolve_target_facts(request, request_path)
    comparable = {key: value for key, value in facts.items() if key in {"id", "version", "git_commit", "content_digest"} and value}
    if not comparable:
        if required:
            raise GovernanceError("FRESHNESS_EVIDENCE_REQUIRED")
        return {"status": "UNKNOWN", "target": facts, "mismatches": []}
    subject = assessment["skill"]
    mismatches: list[str] = []
    for key in ("id", "version", "git_commit", "content_digest"):
        actual = comparable.get(key)
        expected = str(subject.get(key) or "")
        if actual and expected and actual != expected:
            mismatches.append(f"{key}:assessment={expected}:actual={actual}")
    if mismatches:
        raise GovernanceError("ASSESSMENT_STALE:" + "|".join(mismatches))
    return {"status": "PASS", "target": facts, "mismatches": []}


def current_state_for(state: dict[str, Any], skill_id: str) -> str | None:
    record = state.get("skills", {}).get(skill_id)
    return str(record.get("state")) if isinstance(record, dict) and record.get("state") else None


def default_decision(current: str | None, assessment: dict[str, Any]) -> str:
    gate = assessment["gate"]["recommendation"]
    if current is None:
        return "DRAFT"
    if gate == "FAIL":
        return "QUARANTINED"
    mapping = {
        "DRAFT": "VALIDATING",
        "VALIDATING": "APPROVED" if gate == "PASS" else "VALIDATING",
        "APPROVED": "SHADOW" if gate == "PASS" else "QUARANTINED",
        "SHADOW": "ACTIVE" if gate == "PASS" else "QUARANTINED",
        "ACTIVE": "ACTIVE",
        "QUARANTINED": "VALIDATING" if gate != "FAIL" else "QUARANTINED",
        "RETIRED": "RETIRED",
        "BLOCKED": "VALIDATING" if gate != "FAIL" else "QUARANTINED",
    }
    return mapping[current]


def desired_decision(request: dict[str, Any], assessment: dict[str, Any], current: str | None) -> str:
    decision = str(request.get("decision") or default_decision(current, assessment))
    if decision not in ALLOWED_DECISIONS:
        raise GovernanceError(f"DECISION_INVALID:{decision}")
    return decision


def validate_transition(current: str | None, desired: str) -> None:
    if current is None:
        if desired != "DRAFT":
            raise GovernanceError(f"INITIAL_STATE_MUST_BE_DRAFT:{desired}")
        return
    if current == desired:
        raise GovernanceError(f"NO_EFFECTIVE_CHANGE:{current}")
    if desired == "QUARANTINED":
        return
    if desired not in ALLOWED_TRANSITIONS.get(current, set()):
        raise GovernanceError(f"ILLEGAL_TRANSITION:{current}->{desired}")


def validate_approval_record(request: dict[str, Any], assessment: dict[str, Any], desired: str, *, required: bool) -> dict[str, Any]:
    record = request.get("approval_record")
    if not isinstance(record, dict):
        if required:
            raise GovernanceError("APPROVAL_RECORD_REQUIRED")
        return {"approval_id": "unassigned", "reviewer": {"id": "unassigned", "role": "unassigned", "independent": False}}
    reviewer = record.get("reviewer")
    if not isinstance(reviewer, dict):
        raise GovernanceError("APPROVAL_REVIEWER_REQUIRED")
    reviewer_id = str(reviewer.get("id") or "")
    role = str(reviewer.get("role") or "")
    if not reviewer_id or not role:
        raise GovernanceError("APPROVER_IDENTITY_INCOMPLETE")
    if reviewer.get("independent") is not True:
        raise GovernanceError("INDEPENDENT_APPROVER_REQUIRED")
    required_fields = ["approval_id", "assessment_id", "candidate_digest", "decision", "approved_at"]
    missing = [key for key in required_fields if not record.get(key)]
    if missing:
        raise GovernanceError("APPROVAL_FIELDS_MISSING:" + ",".join(missing))
    if record.get("assessment_id") != assessment["assessment_id"]:
        raise GovernanceError("APPROVAL_ASSESSMENT_MISMATCH")
    if record.get("candidate_digest") != assessment["skill"]["content_digest"]:
        raise GovernanceError("APPROVAL_CANDIDATE_MISMATCH")
    if str(record.get("decision")).upper() != "APPROVE":
        raise GovernanceError("APPROVAL_NOT_APPROVED")
    if request.get("candidate_author") == reviewer_id:
        raise GovernanceError("SELF_APPROVAL_REJECTED")
    approved_states = record.get("approved_states")
    if isinstance(approved_states, list) and approved_states and desired not in approved_states:
        raise GovernanceError(f"APPROVAL_STATE_SCOPE_MISMATCH:{desired}")
    return {**record, "reviewer": {"id": reviewer_id, "role": role, "independent": True}}


def validate_runtime_evidence(request: dict[str, Any]) -> None:
    evidence = request.get("runtime_evidence")
    if not isinstance(evidence, dict):
        raise GovernanceError("RUNTIME_EVIDENCE_REQUIRED")
    thresholds = request.get("runtime_thresholds") if isinstance(request.get("runtime_thresholds"), dict) else {}
    checks = [
        (int(evidence.get("sample_size", 0)) >= int(thresholds.get("minimum_sample", 30)), "sample_size"),
        (float(evidence.get("success_rate", 0)) >= float(thresholds.get("minimum_success_rate", 0.95)), "success_rate"),
        (float(evidence.get("error_rate", 1)) <= float(thresholds.get("maximum_error_rate", 0.05)), "error_rate"),
        (float(evidence.get("correction_rate", 1)) <= float(thresholds.get("maximum_correction_rate", 0.10)), "correction_rate"),
        (str(evidence.get("security_status", "UNKNOWN")).upper() == "PASS", "security_status"),
    ]
    failed = [name for passed, name in checks if not passed]
    if failed:
        raise GovernanceError("RUNTIME_GATE_FAILED:" + "|".join(failed))


def validate_transition_gates(request: dict[str, Any], assessment: dict[str, Any], desired: str) -> None:
    gate = assessment["gate"]["recommendation"]
    static_scan = assessment.get("security", {}).get("static_scan")
    if desired in {"APPROVED", "SHADOW", "ACTIVE"} and gate != "PASS":
        raise GovernanceError(f"ASSESSMENT_GATE_BLOCKS_{desired}:{gate}")
    if desired in {"APPROVED", "SHADOW", "ACTIVE"} and static_scan != "PASS":
        raise GovernanceError(f"SECURITY_STATUS_BLOCKS_{desired}:{static_scan}")
    if desired == "SHADOW":
        plan = request.get("shadow_plan")
        if not isinstance(plan, dict):
            raise GovernanceError("SHADOW_PLAN_REQUIRED")
        missing = [key for key in ("traffic_scope", "metrics", "stop_conditions", "rollback_target") if plan.get(key) in (None, "", [], {})]
        if missing:
            raise GovernanceError("SHADOW_PLAN_FIELDS_MISSING:" + ",".join(missing))
    if desired == "ACTIVE":
        validate_runtime_evidence(request)
    if desired == "RETIRED":
        migration = request.get("dependency_migration")
        if not isinstance(migration, dict) or str(migration.get("status", "")).upper() != "COMPLETE":
            raise GovernanceError("DEPENDENCY_MIGRATION_REQUIRED")
    if desired == "QUARANTINED" and not request.get("quarantine_reason"):
        raise GovernanceError("QUARANTINE_REASON_REQUIRED")


def _check_write_gates(request: dict[str, Any], state: dict[str, Any]) -> None:
    if request.get("write_authorized") is not True:
        raise GovernanceError("WRITE_AUTHORIZATION_REQUIRED")
    expected = request.get("expected_version")
    if not isinstance(expected, int):
        raise GovernanceError("EXPECTED_VERSION_REQUIRED")
    if expected != state["version"]:
        raise GovernanceError(f"EXPECTED_VERSION_CONFLICT:{expected}:actual={state['version']}")
    if not isinstance(request.get("rollback_target"), str) or not request["rollback_target"].strip():
        raise GovernanceError("ROLLBACK_TARGET_REQUIRED")
    if not isinstance(request.get("diff"), list) or not request["diff"]:
        raise GovernanceError("DIFF_REQUIRED")


def _build_decision(request: dict[str, Any], assessment: dict[str, Any], decision: str, approval: dict[str, Any], *, current_state: str | None, freshness: dict[str, Any], receipt: dict[str, Any] | None = None, write_applied: bool = False) -> dict[str, Any]:
    generated_at = now_utc()
    seed = f"{request.get('request_id','')}:{assessment.get('assessment_id')}:{current_state}:{decision}:{generated_at}"
    decision_id = "gdec_" + hashlib.sha256(seed.encode("utf-8")).hexdigest()[:16]
    reviewer = approval.get("reviewer", {})
    return {
        "contract_version": CONTRACT_VERSION,
        "decision_id": decision_id,
        "assessment_id": assessment["assessment_id"],
        "report_hash": canonical_hash(assessment),
        "policy_version": POLICY_VERSION,
        "skill": {"id": str(assessment["skill"].get("id") or ""), "version": str(assessment["skill"].get("version") or "0.0.0")},
        "decision": decision,
        "required_actions": list(request.get("required_actions") or assessment.get("gate", {}).get("required_actions") or []),
        "approver": {"id": str(reviewer.get("id") or "unassigned"), "role": str(reviewer.get("role") or "unassigned"), "independent": bool(reviewer.get("independent"))},
        "write_applied": write_applied,
        "receipt": receipt or {"current_state": current_state, "proposed_state": decision, "freshness": freshness, "approval_id": approval.get("approval_id")},
        "rollback_target": request.get("rollback_target"),
        "generated_at": generated_at,
    }


def _commit_state_and_receipt(state_path: Path, receipt_path: Path, previous: dict[str, Any], next_state: dict[str, Any], result: dict[str, Any]) -> None:
    staged_receipt = _stage_json(receipt_path, result)
    try:
        write_json_atomic(state_path, next_state)
        try:
            os.replace(staged_receipt, receipt_path)
        except OSError as exc:
            write_json_atomic(state_path, previous)
            raise GovernanceError(f"RECEIPT_COMMIT_FAILED:{exc}") from exc
    finally:
        staged_receipt.unlink(missing_ok=True)


def _apply(request: dict[str, Any], request_path: Path, assessment: dict[str, Any], state_path: Path, receipt_dir: Path) -> dict[str, Any]:
    with file_lock(state_path.with_suffix(state_path.suffix + ".lock")):
        state = load_state(state_path)
        _check_write_gates(request, state)
        skill_id = str(assessment["skill"].get("id") or "")
        if not skill_id:
            raise GovernanceError("SKILL_ID_MISSING")
        current = current_state_for(state, skill_id)
        desired = desired_decision(request, assessment, current)
        validate_transition(current, desired)
        freshness = validate_assessment_freshness(request, request_path, assessment, required=desired != "DRAFT")
        approval = validate_approval_record(request, assessment, desired, required=desired in {"APPROVED", "SHADOW", "ACTIVE", "RETIRED", "QUARANTINED"})
        validate_transition_gates(request, assessment, desired)

        before = copy.deepcopy(state["skills"].get(skill_id))
        after = {
            "state": desired,
            "skill_version": str(assessment["skill"].get("version") or "0.0.0"),
            "assessment_id": assessment["assessment_id"],
            "report_hash": canonical_hash(assessment),
            "content_digest": assessment["skill"].get("content_digest"),
            "git_commit": assessment["skill"].get("git_commit"),
            "updated_at": now_utc(),
        }
        receipt = {
            "before": before,
            "after": after,
            "diff": list(request["diff"]),
            "assessment_id": assessment["assessment_id"],
            "approval_id": approval.get("approval_id"),
            "approver": approval.get("reviewer", {}),
            "rollback_target": request["rollback_target"],
            "freshness": freshness,
            "state_version_before": state["version"],
            "state_version_after": state["version"] + 1,
        }
        result = _build_decision(request, assessment, desired, approval, current_state=current, freshness=freshness, receipt=receipt, write_applied=True)
        next_state = copy.deepcopy(state)
        next_state["skills"][skill_id] = after
        next_state["history"].append({"decision_id": result["decision_id"], "skill_id": skill_id, "before": before, "after": after, "receipt": receipt, "generated_at": result["generated_at"]})
        next_state["receipts"][result["decision_id"]] = result
        next_state["version"] += 1
        _commit_state_and_receipt(state_path, receipt_dir / f"{result['decision_id']}.json", state, next_state, result)
        return result


def _rollback(request: dict[str, Any], request_path: Path, assessment: dict[str, Any], state_path: Path, receipt_dir: Path) -> dict[str, Any]:
    with file_lock(state_path.with_suffix(state_path.suffix + ".lock")):
        state = load_state(state_path)
        _check_write_gates(request, state)
        approval = validate_approval_record(request, assessment, "ROLLBACK", required=True)
        validate_assessment_freshness(request, request_path, assessment, required=True)
        target_id = request["rollback_target"]
        target = next((event for event in reversed(state["history"]) if event.get("decision_id") == target_id), None)
        if target is None:
            raise GovernanceError(f"ROLLBACK_TARGET_NOT_FOUND:{target_id}")
        skill_id = target["skill_id"]
        current_record = copy.deepcopy(state["skills"].get(skill_id))
        restored = copy.deepcopy(target.get("before"))
        decision = str(restored.get("state") or "DRAFT") if restored else "DRAFT"
        receipt = {
            "before": current_record,
            "after": restored,
            "diff": [f"rollback:{target_id}"],
            "assessment_id": assessment["assessment_id"],
            "approval_id": approval.get("approval_id"),
            "approver": approval.get("reviewer", {}),
            "rollback_target": target_id,
            "state_version_before": state["version"],
            "state_version_after": state["version"] + 1,
        }
        result = _build_decision(request, assessment, decision, approval, current_state=current_record.get("state") if isinstance(current_record, dict) else None, freshness={"status": "PASS"}, receipt=receipt, write_applied=True)
        next_state = copy.deepcopy(state)
        if restored is None:
            next_state["skills"].pop(skill_id, None)
        else:
            next_state["skills"][skill_id] = restored
        next_state["history"].append({"decision_id": result["decision_id"], "skill_id": skill_id, "before": current_record, "after": restored, "receipt": receipt, "generated_at": result["generated_at"]})
        next_state["receipts"][result["decision_id"]] = result
        next_state["version"] += 1
        _commit_state_and_receipt(state_path, receipt_dir / f"{result['decision_id']}.json", state, next_state, result)
        return result


def _inspect_or_plan(command: str, request: dict[str, Any], request_path: Path, assessment: dict[str, Any], state_path: Path) -> dict[str, Any]:
    state = load_state(state_path)
    skill_id = str(assessment["skill"].get("id") or "")
    current = current_state_for(state, skill_id)
    desired = desired_decision(request, assessment, current)
    try:
        validate_transition(current, desired)
        transition_status, transition_error = "PASS", None
    except GovernanceError as exc:
        transition_status, transition_error = "BLOCKED", str(exc)
    try:
        freshness = validate_assessment_freshness(request, request_path, assessment, required=False)
    except GovernanceError as exc:
        freshness = {"status": "FAIL", "error": str(exc)}
    approval = validate_approval_record(request, assessment, desired, required=False)
    result = _build_decision(request, assessment, desired, approval, current_state=current, freshness=freshness, write_applied=False)
    result["receipt"].update({"operation": command, "transition_status": transition_status, "transition_error": transition_error, "state_version": state["version"]})
    return result


def execute(command: str, request: dict[str, Any], request_path: Path, state_path: Path, receipt_dir: Path) -> dict[str, Any]:
    assessment = resolve_assessment(request, request_path)
    validate_assessment(assessment)
    if command in {"inspect", "plan"}:
        return _inspect_or_plan(command, request, request_path, assessment, state_path)
    if command == "apply":
        return _apply(request, request_path, assessment, state_path, receipt_dir)
    if command == "rollback":
        return _rollback(request, request_path, assessment, state_path, receipt_dir)
    raise GovernanceError(f"COMMAND_INVALID:{command}")
