from __future__ import annotations

import json
from pathlib import Path

ENGINE_ROOT = Path(__file__).resolve().parents[1]
SKILLS_ROOT = ENGINE_ROOT / "skills"
SOURCE_ROOT = ENGINE_ROOT.parent / "skill-sources"

SYSTEMS = {
    "awkn-技能测评": {
        "workflow": ENGINE_ROOT / "workflows" / "skill-platform" / "evaluate.py",
        "package": ENGINE_ROOT / "packages" / "skill-evaluator",
    },
    "awkn-技能治理": {
        "workflow": ENGINE_ROOT / "workflows" / "skill-platform" / "govern.py",
        "package": ENGINE_ROOT / "packages" / "skill-governance",
    },
}


def frontmatter_active(path: Path) -> bool:
    return path.read_text(encoding="utf-8", errors="ignore").startswith("---")


def test_formal_skills_are_thin_runtime_contracts() -> None:
    for name, config in SYSTEMS.items():
        root = SKILLS_ROOT / name
        skill_doc = root / "SKILL.md"
        assert skill_doc.is_file()
        content = skill_doc.read_text(encoding="utf-8")
        assert "execution_mode: orchestrated" in content
        assert config["workflow"].relative_to(ENGINE_ROOT).as_posix() in content
        assert config["package"].name in content
        modules = root / "skills"
        if modules.is_dir():
            assert not any(frontmatter_active(path) for path in modules.rglob("SKILL.md"))


def test_runtime_packages_and_workflows_do_not_import_legacy_skill_scripts() -> None:
    forbidden = (
        "skills/awkn-技能测评/scripts",
        "skills\\awkn-技能测评\\scripts",
        "skills/awkn-技能治理/scripts",
        "skills\\awkn-技能治理\\scripts",
        "awkn-技能治理/absorbed-skills",
        "awkn-技能治理\\absorbed-skills",
    )
    files = list((ENGINE_ROOT / "packages" / "skill-evaluator").rglob("*.py"))
    files += list((ENGINE_ROOT / "packages" / "skill-governance").rglob("*.py"))
    files += list((ENGINE_ROOT / "workflows" / "skill-platform").rglob("*.py"))
    for path in files:
        content = path.read_text(encoding="utf-8", errors="ignore")
        assert not any(value in content for value in forbidden), path


def test_mutable_state_default_is_runtime_data() -> None:
    workflow = (ENGINE_ROOT / "workflows" / "skill-platform" / "govern.py").read_text(encoding="utf-8")
    assert '"runtime" / "data" / "skill-governance"' in workflow
    assert 'skill_dir / "data"' not in workflow
    assert (ENGINE_ROOT / "runtime" / "data" / "skill-governance" / "README.md").is_file()


def test_skill_sources_have_independent_target_and_manifest() -> None:
    manifest_path = SOURCE_ROOT / "migration-manifest.json"
    assert (SOURCE_ROOT / "README.md").is_file()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["target_root"] == "D:/awkn-lab/skill-sources"
    assert manifest["status"] in {"COPY_TARGET_READY_PHYSICAL_MOVE_PENDING", "PHYSICAL_MOVE_COMPLETE"}
    assert "absorbed-skills" in manifest["blocked_paths_in_skill_repo"]


def test_skill_repository_ignore_rules_block_future_pollution() -> None:
    ignore = (SKILLS_ROOT / ".gitignore").read_text(encoding="utf-8")
    for path in (
        "awkn-技能治理/absorbed-skills/",
        "awkn-技能治理/data/",
        "awkn-技能治理/logs/",
        "awkn-技能治理/telemetry/",
        "awkn-技能治理/scripts/",
        "awkn-技能治理/skills/",
        "awkn-技能测评/scripts/",
        "awkn-技能测评/skills/",
    ):
        assert path in ignore
