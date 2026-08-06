from __future__ import annotations

import json
import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
SRC = PACKAGE_ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from awkn_skill_evaluator import evaluate_skill, scan_security
from awkn_skill_evaluator.orchestrator import validate_schema


def write_skill(root: Path, body: str = "") -> Path:
    skill = root / "demo-skill"
    skill.mkdir()
    (skill / "SKILL.md").write_text(
        "---\n"
        "name: demo-skill\n"
        "description: A deterministic demo Skill with explicit input and output contracts.\n"
        "version: 1.0.0\n"
        "runtime_service: demo\n"
        "---\n\n"
        "# Demo\n\n"
        "## 输入\nrequest\n\n"
        "## 输出\nresult\n\n"
        "## 流程\nvalidate then execute\n\n"
        "## 边界\nno mutable state in the Skill directory\n\n"
        "## 失败处理\nreturn an error\n\n"
        "## 验收\nresult matches schema\n\n"
        + body,
        encoding="utf-8",
    )
    return skill


def test_thin_skill_returns_conditional_without_receipts(tmp_path: Path) -> None:
    skill = write_skill(tmp_path)
    result = evaluate_skill(skill, context={"fit_context": {"task": "evaluate"}})
    assert result["status"] == "CONDITIONAL"
    assessment = result["assessment_result"]
    assert assessment["evidence"]["evidence_level"] == "E0"
    assert any(item["id"] == "EVIDENCE_CAP" for item in assessment["caps"])
    assert validate_schema(assessment)["status"] == "PASS"


def test_execution_receipts_raise_evidence_level(tmp_path: Path) -> None:
    skill = write_skill(tmp_path)
    scripts = skill / "scripts"
    scripts.mkdir()
    (scripts / "run.py").write_text("print('ok')\n", encoding="utf-8")
    context = {
        "fit_context": {
            "user_role": "developer",
            "task": "evaluate",
            "available_inputs": ["skill"],
            "available_tools": ["python"],
            "expected_output": "json",
            "authorized_scope": "local",
            "constraints": "fast",
        },
        "test_receipts": [{"status": "PASS", "exit_code": 0, "artifact_digest": "12345678abcdef"}],
        "runtime_receipts": [{"status": "PASS", "exit_code": 0, "artifact_digest": "abcdef12345678", "security_status": "PASS"}],
    }
    result = evaluate_skill(skill, context=context)
    assert result["assessment_result"]["evidence"]["evidence_level"] == "E3"
    assert result["route_trace"][0]["route_id"] == "E1"
    assert [item["route_id"] for item in result["route_trace"]] == ["E1", "E3", "E2", "E4", "E5", "E6"]


def test_security_is_single_source_and_blocks_p0(tmp_path: Path) -> None:
    skill = write_skill(tmp_path)
    scripts = skill / "scripts"
    scripts.mkdir()
    (scripts / "bad.py").write_text("value = eval(user_input)\n", encoding="utf-8")
    security = scan_security(skill)
    result = evaluate_skill(skill)
    assert security["pattern_count"] == 15
    assert security["static_scan"] == "FAIL"
    assert result["status"] == "FAIL"
    assert result["assessment_result"]["security"]["scanner_version"] == security["scanner_version"]


def test_absorbed_sources_do_not_pollute_digest(tmp_path: Path) -> None:
    skill = write_skill(tmp_path)
    first = evaluate_skill(skill)["assessment_result"]["skill"]["content_digest"]
    source = skill / "absorbed-skills" / "vendor"
    source.mkdir(parents=True)
    (source / "SKILL.md").write_text("external source", encoding="utf-8")
    second = evaluate_skill(skill)["assessment_result"]["skill"]["content_digest"]
    assert first == second
