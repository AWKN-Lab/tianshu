"""Evidence-bound Skill scoring engine.

Runtime implementation lives in tianshu/packages. Formal Skill directories remain
thin discovery and invocation contracts.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from .security import EXCLUDED_PARTS, find_skill_document, parse_frontmatter, scan_security

EVALUATOR_NAME = "awkn-技能测评"
EVALUATOR_VERSION = "4.0.0"
POLICY_PACK = "evidence-bound-v3"
CONTRACT_VERSION = "1.0.0"
SOURCE_EXTENSIONS = {
    ".md", ".py", ".js", ".ts", ".tsx", ".jsx", ".sh", ".ps1",
    ".json", ".yaml", ".yml", ".txt", ".toml",
}
IMPLEMENTATION_EXTENSIONS = {".py", ".js", ".ts", ".tsx", ".jsx", ".sh", ".ps1"}
TEST_MARKERS = ("test_", "_test.", ".test.", ".spec.", "tests/")


def canonical_json(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def classify_file(relative: str, suffix: str) -> str:
    lowered = relative.lower()
    if suffix in IMPLEMENTATION_EXTENSIONS:
        return "test" if any(marker in lowered for marker in TEST_MARKERS) else "implementation"
    if lowered.endswith(".schema.json") or "/references/" in f"/{lowered}":
        return "reference"
    if "/templates/" in f"/{lowered}":
        return "template"
    if lowered.endswith(("readme.md", "quickstart.md", "changelog.md", "skill.md", "_skill.md")):
        return "documentation"
    return "asset"


def iter_source_files(skill_dir: Path) -> list[Path]:
    files: list[Path] = []
    for path in skill_dir.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in SOURCE_EXTENSIONS:
            continue
        relative_parts = path.relative_to(skill_dir).parts
        if any(part in EXCLUDED_PARTS for part in relative_parts):
            continue
        files.append(path)
    return sorted(files, key=lambda item: item.relative_to(skill_dir).as_posix())


def source_inventory(skill_dir: Path) -> tuple[list[dict[str, Any]], str, str]:
    digest = hashlib.sha256()
    inventory: list[dict[str, Any]] = []
    chunks: list[str] = []
    for path in iter_source_files(skill_dir):
        relative = path.relative_to(skill_dir).as_posix()
        data = path.read_bytes()
        file_digest = hashlib.sha256(data).hexdigest()
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(data)
        digest.update(b"\0")
        inventory.append({
            "path": relative,
            "size": len(data),
            "sha256": file_digest,
            "kind": classify_file(relative, path.suffix.lower()),
        })
        chunks.append(data.decode("utf-8", errors="ignore"))
    return inventory, digest.hexdigest(), "\n".join(chunks)


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


def has_any(content: str, terms: Iterable[str]) -> bool:
    lowered = content.lower()
    return any(term.lower() in lowered for term in terms)


def verified_receipts(context: dict[str, Any], key: str) -> list[dict[str, Any]]:
    raw = context.get(key, [])
    if not isinstance(raw, list):
        return []
    result: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        status = str(item.get("status", "")).upper()
        digest = item.get("artifact_digest") or item.get("receipt_digest")
        exit_code = item.get("exit_code")
        if status == "PASS" and exit_code in {0, None} and isinstance(digest, str) and len(digest) >= 8:
            result.append(item)
    return result


def _dimension(name: str, maximum: int, checks: list[tuple[bool, int, str, list[dict[str, Any]]]]) -> dict[str, Any]:
    score = 0
    reasons: list[str] = []
    evidence: list[dict[str, Any]] = []
    for passed, points, reason, refs in checks:
        if passed:
            score += points
            reasons.append(reason)
            evidence.extend(refs)
    unique = {canonical_json(item): item for item in evidence}
    return {
        "name": name,
        "score": min(maximum, score),
        "max": maximum,
        "reason": "；".join(reasons) if reasons else "缺少可验证证据",
        "evidence": list(unique.values()),
    }


def _refs(inventory: list[dict[str, Any]], kinds: set[str]) -> list[dict[str, Any]]:
    return [
        {"type": "file", "path": item["path"], "digest": item["sha256"], "verified": True}
        for item in inventory if item["kind"] in kinds
    ][:12]


def classify_levels(inventory: list[dict[str, Any]], context: dict[str, Any], security: dict[str, Any]) -> tuple[str, str, str]:
    implementation_count = sum(item["kind"] == "implementation" for item in inventory)
    supporting_count = sum(item["kind"] in {"reference", "template", "test"} for item in inventory)
    if implementation_count and supporting_count:
        material = "M3"
    elif implementation_count or len(inventory) >= 3:
        material = "M2"
    elif inventory:
        material = "M1"
    else:
        material = "M0"

    if verified_receipts(context, "runtime_receipts"):
        evidence = "E3"
    elif verified_receipts(context, "test_receipts"):
        evidence = "E2"
    elif implementation_count:
        evidence = "E1"
    else:
        evidence = "E0"

    findings = security.get("findings", [])
    if any(item.get("severity") == "P0" for item in findings):
        risk = "R3"
    elif findings:
        risk = "R2"
    elif implementation_count:
        risk = "R1"
    else:
        risk = "R0"
    return material, evidence, risk


def build_assessment(
    skill_path: str | Path,
    context: dict[str, Any] | None = None,
    *,
    mode: str = "full",
    security_result: dict[str, Any] | None = None,
) -> dict[str, Any]:
    context = context or {}
    skill_dir = Path(skill_path).resolve()
    skill_doc = find_skill_document(skill_dir)
    if skill_doc is None:
        raise ValueError("SKILL_DOCUMENT_MISSING")

    primary = skill_doc.read_text(encoding="utf-8", errors="ignore")
    metadata = parse_frontmatter(primary)
    inventory, source_digest, combined = source_inventory(skill_dir)
    security = security_result or scan_security(skill_dir)
    if security.get("status") != "OK":
        raise ValueError(str(security.get("error") or "SECURITY_SCAN_FAILED"))

    material_level, evidence_level, risk_level = classify_levels(inventory, context, security)
    impl_refs = _refs(inventory, {"implementation"})
    test_refs = _refs(inventory, {"test"})
    doc_refs = _refs(inventory, {"documentation"})
    ref_refs = _refs(inventory, {"reference"})
    test_receipts = verified_receipts(context, "test_receipts")
    runtime_receipts = verified_receipts(context, "runtime_receipts")
    test_receipt_refs = [{"type": "execution_receipt", "digest": item.get("artifact_digest") or item.get("receipt_digest"), "verified": True} for item in test_receipts]
    runtime_receipt_refs = [{"type": "runtime_receipt", "digest": item.get("artifact_digest") or item.get("receipt_digest"), "verified": True} for item in runtime_receipts]

    has_inputs = has_any(combined, ["## 输入", "input", "参数", "父级上下文"])
    has_outputs = has_any(combined, ["## 输出", "output", "产物", "返回"])
    has_flow = has_any(combined, ["流程", "执行步骤", "编排", "workflow"])
    has_boundary = has_any(combined, ["边界", "禁止", "限制", "调用约束"])
    has_failure = has_any(combined, ["失败", "错误", "异常", "降级"])
    has_acceptance = has_any(combined, ["验收", "acceptance"])
    has_examples = has_any(combined, ["示例", "example", "```bash", "```json"])
    has_observability = has_any(combined, ["成功率", "错误率", "修正率", "观测", "运行指标"])
    has_schema = any(item["path"].lower().endswith(".schema.json") for item in inventory)
    metadata_complete = bool(metadata.get("name") and metadata.get("description") and metadata.get("version"))

    official_dims = [
        _dimension("utility", 5, [(has_inputs, 1, "输入明确", doc_refs), (has_outputs, 1, "输出明确", doc_refs), (has_flow, 1, "流程明确", doc_refs), (has_acceptance, 1, "验收明确", doc_refs), (bool(impl_refs) or has_any(combined, ["runtime_service", "workflow_entry"]), 1, "存在执行入口", impl_refs or doc_refs)]),
        _dimension("innovation", 5, [(has_schema, 1, "结构化契约", ref_refs), (has_observability, 1, "观测定义", doc_refs), (bool(runtime_receipts), 2, "运行回执", runtime_receipt_refs), (has_any(combined, ["模式", "quick", "full", "batch"]), 1, "模式定义", doc_refs)]),
        _dimension("completeness", 5, [(metadata_complete, 1, "元数据完整", doc_refs), (has_flow, 1, "流程完整", doc_refs), (has_boundary, 1, "边界明确", doc_refs), (has_failure, 1, "失败处理", doc_refs), (has_schema or has_outputs, 1, "输出可校验", ref_refs or doc_refs)]),
        _dimension("experience", 5, [(has_examples, 1, "示例存在", doc_refs), (has_flow, 1, "步骤可读", doc_refs), (has_boundary, 1, "调用边界清楚", doc_refs), (bool(test_refs), 1, "测试资产存在", test_refs), (bool(test_receipts), 1, "测试已执行", test_receipt_refs)]),
    ]

    quality_dims = [
        _dimension("goal_clarity", 10, [(len(str(metadata.get("description", ""))) >= 20, 5, "目标描述充分", doc_refs), (has_inputs and has_outputs, 5, "输入输出成对", doc_refs)]),
        _dimension("contract_integrity", 10, [(metadata_complete, 4, "元数据完整", doc_refs), (has_schema, 3, "Schema 存在", ref_refs), (has_boundary, 3, "边界明确", doc_refs)]),
        _dimension("functional_correctness", 10, [(bool(impl_refs) or has_any(combined, ["runtime_service", "workflow_entry"]), 4, "执行入口存在", impl_refs or doc_refs), (bool(test_receipts), 6, "测试执行通过", test_receipt_refs)]),
        _dimension("error_handling", 10, [(has_failure, 5, "错误路径有定义", doc_refs), (any(str(item.get("case_type", "")).lower() in {"negative", "failure", "error"} for item in test_receipts), 5, "失败路径已执行", test_receipt_refs)]),
        _dimension("security", 10, [(security.get("static_scan") == "PASS", 7, "静态安全通过", []), (bool(runtime_receipts) and all(str(item.get("security_status", "PASS")).upper() == "PASS" for item in runtime_receipts), 3, "运行安全通过", runtime_receipt_refs)]),
        _dimension("testability", 10, [(bool(test_refs), 3, "测试资产存在", test_refs), (bool(test_receipts), 7, "测试有回执", test_receipt_refs)]),
        _dimension("maintainability", 10, [(has_flow, 4, "流程清楚", doc_refs), (bool(metadata.get("version")), 3, "版本存在", doc_refs), (bool(ref_refs), 3, "参考资料分离", ref_refs)]),
        _dimension("portability", 10, [(has_boundary, 4, "环境边界明确", doc_refs), (not has_any(combined, ["c:\\users\\", "/home/"]), 3, "未发现用户目录硬编码", doc_refs), (has_any(combined, ["依赖", "requirements", "package.json", "runtime_service"]), 3, "依赖有声明", doc_refs)]),
        _dimension("observability", 10, [(has_observability, 4, "指标存在", doc_refs), (bool(runtime_receipts), 6, "指标有回执", runtime_receipt_refs)]),
        _dimension("user_experience", 10, [(has_examples, 3, "示例存在", doc_refs), (has_flow, 3, "步骤清楚", doc_refs), (has_outputs and has_acceptance, 4, "结果与验收明确", doc_refs)]),
    ]

    self_dims = [
        _dimension("change_history", 1, [(bool(metadata.get("version")), 1, "版本存在", doc_refs)]),
        _dimension("regression", 1, [(bool(test_receipts), 1, "回归有回执", test_receipt_refs)]),
        _dimension("observability", 1, [(bool(runtime_receipts), 1, "运行有回执", runtime_receipt_refs)]),
        _dimension("version_governance", 1, [(bool(metadata.get("version")) and has_schema, 1, "版本与契约存在", ref_refs)]),
        _dimension("feedback_loop", 1, [(has_any(combined, ["用户反馈", "纠错闭环", "修正率"]) and bool(runtime_receipts), 1, "反馈闭环有证据", runtime_receipt_refs)]),
    ]

    fit_context = context.get("fit_context") if isinstance(context.get("fit_context"), dict) else {}
    fit_fields = (("user_role", 15), ("task", 15), ("available_inputs", 15), ("available_tools", 15), ("expected_output", 15), ("authorized_scope", 15), ("constraints", 10))
    fit_dims = [_dimension(name, weight, [(fit_context.get(name) not in (None, "", [], {}), weight, f"{name} 已提供", [{"type": "context", "field": name, "verified": True}])]) for name, weight in fit_fields]

    details = {
        "official_simulation": {"total": sum(item["score"] for item in official_dims), "max": 20, "dimensions": official_dims},
        "self_evolution": {"total": sum(item["score"] for item in self_dims), "max": 5, "dimensions": self_dims},
        "quality": {"total": sum(item["score"] for item in quality_dims), "max": 100, "dimensions": quality_dims},
        "fit": {"total": sum(item["score"] for item in fit_dims), "max": 100, "status": "SCORED" if fit_context else "UNKNOWN", "dimensions": fit_dims},
    }
    scores = {key: value["total"] for key, value in details.items()}

    caps: list[dict[str, Any]] = []
    if evidence_level in {"E0", "E1"}:
        caps.append({"id": "EVIDENCE_CAP", "reason": "缺少已执行测试回执", "gate_ceiling": "CONDITIONAL"})
    if not fit_context:
        caps.append({"id": "TARGET_CONTEXT_REQUIRED", "reason": "缺少适配上下文", "gate_ceiling": "CONDITIONAL"})
    if not runtime_receipts:
        caps.append({"id": "RUNTIME_UNKNOWN", "reason": "缺少运行回执", "gate_ceiling": "CONDITIONAL"})

    findings = []
    for item in security.get("findings", []):
        findings.append({
            "id": str(item.get("rule_id") or f"SEC-{len(findings)+1:03d}"),
            "severity": str(item.get("severity") or "P2"),
            "title": str(item.get("title") or "安全问题"),
            "source": f"{item.get('path', 'SKILL.md')}:{item.get('line', 1)}",
            "impact": "影响安全、可靠性或发布门控。",
            "remediation": str(item.get("remediation") or "修复后重新扫描。"),
            "acceptance": "重新扫描不再命中该规则。",
            "confidence": str(item.get("confidence") or "medium"),
        })

    blockers = [item["id"] for item in findings if item["severity"] == "P0"]
    if security.get("static_scan") == "FAIL" or blockers:
        recommendation = "FAIL"
    elif caps:
        recommendation = "CONDITIONAL"
    elif scores["official_simulation"] + scores["self_evolution"] >= 18 and scores["quality"] >= 75 and scores["fit"] >= 70:
        recommendation = "PASS"
    else:
        recommendation = "CONDITIONAL"

    required_actions = [{"type": "evidence", "code": cap["id"], "acceptance": cap["reason"]} for cap in caps]
    required_actions.extend({"type": "fix", "finding_id": finding["id"], "acceptance": finding["acceptance"]} for finding in findings if finding["severity"] in {"P0", "P1"})

    context_digest = sha256_text(canonical_json({"mode": mode, "context": context}))
    assessment_id = "asmt_" + sha256_text(canonical_json({
        "source_digest": source_digest,
        "evaluator_version": EVALUATOR_VERSION,
        "policy_pack": POLICY_PACK,
        "context_digest": context_digest,
        "mode": mode,
    }))[:20]
    skill_name = str(metadata.get("name") or skill_dir.name)
    skill_version = str(metadata.get("version") or "0.0.0")
    trace = [{
        "group": key,
        "total": value["total"],
        "max": value["max"],
        "formula": "sum(dimensions.score)",
        "dimensions": [{"name": item["name"], "score": item["score"], "max": item["max"]} for item in value["dimensions"]],
    } for key, value in details.items()]

    return {
        "contract_version": CONTRACT_VERSION,
        "assessment_id": assessment_id,
        "skill": {"id": skill_name, "name": skill_name, "version": skill_version, "git_commit": git_commit(skill_dir), "content_digest": source_digest},
        "evaluator": {"name": EVALUATOR_NAME, "version": EVALUATOR_VERSION, "policy_pack": POLICY_PACK},
        "evidence": {"material_level": material_level, "evidence_level": evidence_level, "risk_level": risk_level},
        "scores": scores,
        "score_details": details,
        "caps": caps,
        "calculation_trace": trace,
        "security": {"static_scan": security.get("static_scan", "UNKNOWN"), "runtime_status": "PASS" if runtime_receipts else "UNKNOWN", "scanner_version": security.get("scanner_version")},
        "gate": {"recommendation": recommendation, "blocking_findings": blockers, "required_actions": required_actions},
        "findings": findings,
        "coverage": {"source_files": inventory, "excluded_parts": sorted(EXCLUDED_PARTS), "security": security.get("coverage", {})},
        "context_digest": context_digest,
        "generated_at": now_utc(),
    }
