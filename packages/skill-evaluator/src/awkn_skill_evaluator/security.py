"""Deterministic static security precheck for formal Skill directories."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

SCANNER_VERSION = "3.0.0"
TEXT_EXTENSIONS = {".md", ".py", ".js", ".ts", ".tsx", ".jsx", ".sh", ".ps1", ".json", ".yaml", ".yml", ".toml"}
EXCLUDED_PARTS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", "out",
    "data", "logs", "telemetry", "reports", "receipts", ".pytest_cache", "coverage",
    "absorbed-skills", "skill-sources", ".transactions",
}
PLACEHOLDERS = {"example", "placeholder", "changeme", "your-", "your_", "xxx", "dummy", "fake", "sample", "test123", "replace_me"}

RULES: tuple[tuple[str, str, str, str], ...] = (
    ("INJ-001", r"\beval\s*\(", "P0", "eval dynamic execution"),
    ("INJ-002", r"\bexec\s*\(", "P0", "exec dynamic execution"),
    ("INJ-003", r"\bsubprocess\.(?:run|call|Popen|check_output|check_call)\s*\([^\n]*shell\s*=\s*True", "P0", "shell=True command execution"),
    ("INJ-004", r"\bos\.system\s*\(", "P0", "os.system command execution"),
    ("INJ-005", r"(?i)\bf[\"'][^\n\"']*(?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER)\b", "P0", "f-string SQL"),
    ("INJ-006", r"(?i)(?:prompt|system_prompt|user_prompt|messages?)\s*=\s*f[\"'][^\n]*\{(?:user|input|query|request|data)", "P1", "user input interpolated into prompt"),
    ("INJ-007", r"\.innerHTML\s*=\s*[^;\n]+", "P1", "innerHTML assignment"),
    ("INJ-008", r"\brequests\.(?:get|post|put|patch|delete)\s*\([^\n]*(?:request|params?|query|user|url)", "P1", "user-controlled URL request"),
    ("INJ-009", r"\bopen\s*\([^\n]*(?:request|params?|query|form|user|argv)", "P0", "user-controlled file path"),
    ("INJ-010", r"\byaml\.(?:load|unsafe_load)\s*\(|\bpickle\.loads?\s*\(", "P0", "unsafe deserialization"),
    ("INJ-011", r"(?i)\b(?:render_template_string|Template)\s*\([^\n]*(?:user|input|query|request|data)", "P1", "user input in template rendering"),
    ("INJ-012", r"\bsubprocess\.(?:run|call|Popen)\s*\([^\n]*(?:\+|\.format\(|f[\"'])", "P1", "dynamic command construction"),
    ("INJ-013", r"\b(?:importlib\.import_module|__import__)\s*\([^\n]*(?:user|input|query|request|argv)", "P1", "dynamic module import"),
    ("INJ-014", r"\b(?:extractall|unpack_archive)\s*\([^\n]*(?:request|upload|user|input|archive|file)", "P1", "archive traversal risk"),
    ("INJ-015", r"(?i)\b(?:redirect|window\.location|location\.href)\s*\([^\n]*(?:user|input|query|request|url)|(?:javascript|data):", "P1", "unsafe redirect or URL scheme"),
)

OFFENSIVE_TERMS = {"渗透测试", "红队", "漏洞利用", "密码破解", "reverse shell", "exploit", "sqlmap", "metasploit", "brute force"}
DISCLAIMER_TERMS = {"仅限授权", "授权使用", "书面许可", "教育目的", "authorized use", "written permission", "educational purpose"}


def parse_frontmatter(content: str) -> dict[str, Any]:
    if not content.startswith("---"):
        return {}
    parts = content.split("---", 2)
    if len(parts) < 3:
        return {}
    result: dict[str, Any] = {}
    for line in parts[1].splitlines():
        if not line.strip() or line.lstrip().startswith("#") or ":" not in line:
            continue
        key, raw = line.split(":", 1)
        value: Any = raw.strip().strip("\"'")
        if str(value).lower() == "true":
            value = True
        elif str(value).lower() == "false":
            value = False
        result[key.strip()] = value
    return result


def find_skill_document(skill_dir: Path) -> Path | None:
    for name in ("SKILL.md", "_SKILL.md"):
        candidate = skill_dir / name
        if candidate.is_file():
            return candidate
    return None


def iter_text_files(skill_dir: Path) -> list[Path]:
    files: list[Path] = []
    for path in skill_dir.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in TEXT_EXTENSIONS:
            continue
        relative_parts = path.relative_to(skill_dir).parts
        if any(part in EXCLUDED_PARTS for part in relative_parts):
            continue
        files.append(path)
    return sorted(files, key=lambda item: item.relative_to(skill_dir).as_posix())


def _placeholder(value: str) -> bool:
    lowered = value.lower()
    return any(marker in lowered for marker in PLACEHOLDERS)


def _finding(rule_id: str, severity: str, title: str, path: str, line: int, evidence: str, remediation: str) -> dict[str, Any]:
    return {
        "rule_id": rule_id,
        "severity": severity,
        "title": title,
        "path": path,
        "line": line,
        "evidence": evidence[:180],
        "remediation": remediation,
        "confidence": "medium",
    }


def _scan_file(path: Path, skill_dir: Path) -> list[dict[str, Any]]:
    relative = path.relative_to(skill_dir).as_posix()
    findings: list[dict[str, Any]] = []
    content = path.read_text(encoding="utf-8", errors="ignore")
    secret_re = re.compile(r"(?ix)\b(api[_-]?key|token|secret|password|passwd)\s*=\s*[\"']([^\"']+)[\"']")
    for number, line in enumerate(content.splitlines(), start=1):
        for match in secret_re.finditer(line):
            if not _placeholder(match.group(2)):
                findings.append(_finding("SEC-001", "P0", f"hard-coded {match.group(1)}", relative, number, line.strip(), "Use an environment variable or managed secret and rotate exposed values."))
        if re.search(r"(?<![\w'\"])\binput\s*\(", line):
            findings.append(_finding("RUN-001", "P1", "interactive input() blocks agent execution", relative, number, line.strip(), "Use arguments, structured stdin, or parent authorization context."))
        if line.lstrip().startswith(("#", "//", "*", ";")):
            continue
        for rule_id, pattern, severity, title in RULES:
            if re.search(pattern, line):
                findings.append(_finding(rule_id, severity, title, relative, number, line.strip(), "Use parameterized APIs, allowlists, normalized paths, and least privilege."))
    return findings


def scan_security(skill_path: str | Path) -> dict[str, Any]:
    skill_dir = Path(skill_path).resolve()
    if not skill_dir.is_dir():
        return {"status": "FAILED", "error": "SKILL_DIR_INVALID", "pattern_count": len(RULES), "findings": []}
    skill_doc = find_skill_document(skill_dir)
    if skill_doc is None:
        return {"status": "FAILED", "error": "SKILL_DOCUMENT_MISSING", "pattern_count": len(RULES), "findings": []}

    metadata = parse_frontmatter(skill_doc.read_text(encoding="utf-8", errors="ignore"))
    files = iter_text_files(skill_dir)
    findings: list[dict[str, Any]] = []
    for path in files:
        findings.extend(_scan_file(path, skill_dir))

    document = skill_doc.read_text(encoding="utf-8", errors="ignore").lower()
    authorization_required = any(term.lower() in document for term in OFFENSIVE_TERMS)
    authorization_valid = (
        not authorization_required
        or (
            metadata.get("requires_authorization") is True
            and metadata.get("authorization_mode") == "explicit_user_confirmation"
            and any(term.lower() in document for term in DISCLAIMER_TERMS)
        )
    )
    if not authorization_valid:
        findings.append(_finding("AUTH-001", "P0", "high-risk Skill lacks authorization contract", skill_doc.name, 1, "authorization metadata incomplete", "Declare explicit user confirmation and authorized scope."))

    blockers = [item for item in findings if item["severity"] == "P0"]
    return {
        "status": "OK",
        "scanner_version": SCANNER_VERSION,
        "pattern_count": len(RULES),
        "static_scan": "FAIL" if blockers else "PASS",
        "runtime_status": "UNKNOWN",
        "passed": not blockers,
        "authorization": {"required": authorization_required, "valid": authorization_valid},
        "coverage": {
            "scanned_files": [path.relative_to(skill_dir).as_posix() for path in files],
            "excluded_parts": sorted(EXCLUDED_PARTS),
        },
        "findings": findings,
    }
