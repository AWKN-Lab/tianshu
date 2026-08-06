"""E1-E6 executable evaluator orchestration."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .scoring import build_assessment, classify_levels, source_inventory
from .security import find_skill_document, parse_frontmatter, scan_security

PACKAGE_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = PACKAGE_ROOT / "contracts" / "assessment-result.schema.json"


def _route(route_id: str, component: str, status: str, **details: Any) -> dict[str, Any]:
    return {"route_id": route_id, "component": component, "status": status, **details}


def validate_schema(payload: dict[str, Any]) -> dict[str, Any]:
    if not SCHEMA_PATH.is_file():
        return {"status": "FAIL", "errors": [f"SCHEMA_MISSING:{SCHEMA_PATH}"]}
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    try:
        import jsonschema
    except ImportError:
        missing = [key for key in schema.get("required", []) if key not in payload]
        return {"status": "PASS" if not missing else "FAIL", "errors": [f"MISSING:{key}" for key in missing], "validator": "fallback"}
    try:
        jsonschema.validate(payload, schema)
    except jsonschema.ValidationError as exc:
        return {"status": "FAIL", "errors": [exc.message], "validator": "jsonschema"}
    return {"status": "PASS", "errors": [], "validator": "jsonschema"}


def _input_recognition(skill_dir: Path, context: dict[str, Any]) -> dict[str, Any]:
    skill_doc = find_skill_document(skill_dir)
    if skill_doc is None:
        return {"status": "FAILED", "error": "SKILL_DOCUMENT_MISSING"}
    metadata = parse_frontmatter(skill_doc.read_text(encoding="utf-8", errors="ignore"))
    inventory, source_digest, _ = source_inventory(skill_dir)
    material, evidence, risk = classify_levels(inventory, context, {"findings": []})
    if any(item["kind"] == "implementation" for item in inventory):
        skill_type = "tool"
    elif any(item["kind"] == "template" for item in inventory):
        skill_type = "template"
    elif any(item["kind"] == "reference" for item in inventory):
        skill_type = "knowledge"
    else:
        skill_type = "thin-runtime-contract"
    return {
        "status": "OK",
        "skill_type": skill_type,
        "material_level": material,
        "evidence_level": evidence,
        "risk_level": risk,
        "metadata": metadata,
        "inventory": inventory,
        "source_digest": source_digest,
    }


def _diagnose(assessment: dict[str, Any]) -> dict[str, Any]:
    findings = list(assessment.get("findings", []))
    for cap in assessment.get("caps", []):
        findings.append({
            "id": f"CAP-{cap.get('id')}",
            "severity": "P1" if cap.get("id") in {"EVIDENCE_CAP", "RUNTIME_UNKNOWN"} else "P2",
            "title": str(cap.get("reason") or cap.get("id")),
            "source": "assessment.caps",
            "impact": "限制置信度与门控上限。",
            "remediation": "补齐对应证据并重新执行测评。",
            "acceptance": "该 cap 在新测评结果中消失。",
            "confidence": "high",
        })
    return {"status": "OK", "findings": findings}


def _improvement_gate(assessment: dict[str, Any], findings: list[dict[str, Any]]) -> dict[str, Any]:
    routes = {"quick_fix": [], "thirty_minute": [], "release": []}
    for item in findings:
        action = {"finding_id": item.get("id"), "action": item.get("remediation"), "acceptance": item.get("acceptance")}
        if item.get("severity") == "P0":
            routes["quick_fix"].append(action)
        elif item.get("severity") == "P1":
            routes["thirty_minute"].append(action)
        else:
            routes["release"].append(action)
    return {
        "status": "OK",
        "routes": routes,
        "gate": assessment["gate"],
        "trial_tasks": [] if assessment["gate"]["recommendation"] == "PASS" else [{
            "type": "evidence_recheck",
            "input": "修复后的 Skill 与执行回执",
            "pass_condition": "阻断 finding 清零且 Schema 通过",
            "fail_condition": "仍存在 P0 或安全 FAIL",
        }],
    }


def evaluate_skill(skill_path: str | Path, *, mode: str = "full", context: dict[str, Any] | None = None) -> dict[str, Any]:
    context = context or {}
    skill_dir = Path(skill_path).resolve()
    trace: list[dict[str, Any]] = []
    if not skill_dir.is_dir():
        return {"status": "FAILED", "error": "SKILL_DIR_INVALID", "route_trace": trace}

    e1 = _input_recognition(skill_dir, context)
    trace.append(_route("E1", "input-recognition", "PASS" if e1.get("status") == "OK" else "FAIL", output=e1))
    if e1.get("status") != "OK":
        return {"status": "FAILED", "error": e1.get("error"), "route_trace": trace}

    security = scan_security(skill_dir)
    trace.append(_route("E3", "security-precheck", "PASS" if security.get("status") == "OK" else "FAIL", static_scan=security.get("static_scan"), finding_count=len(security.get("findings", []))))
    if security.get("status") != "OK":
        return {"status": "FAILED", "error": security.get("error"), "route_trace": trace}

    assessment = build_assessment(skill_dir, context, mode=mode, security_result=security)
    trace.append(_route("E2", "scoring", "PASS", scores=assessment.get("scores"), evidence=assessment.get("evidence")))

    diagnosis = _diagnose(assessment)
    trace.append(_route("E4", "evidence-diagnosis", "PASS", finding_count=len(diagnosis["findings"])))

    gate = _improvement_gate(assessment, diagnosis["findings"])
    trace.append(_route("E5", "improvement-gate", "PASS", recommendation=assessment["gate"]["recommendation"]))

    schema_validation = validate_schema(assessment)
    trace.append(_route("E6", "report-calibration", "PASS" if schema_validation["status"] == "PASS" else "FAIL", schema_validation=schema_validation))

    if schema_validation["status"] != "PASS":
        status = "FAILED"
    else:
        status = assessment["gate"]["recommendation"]
    return {
        "status": status,
        "mode": mode,
        "assessment_result": assessment,
        "diagnosis": diagnosis,
        "improvement_gate": gate,
        "schema_validation": schema_validation,
        "route_trace": trace,
    }
