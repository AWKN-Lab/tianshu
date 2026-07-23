# Team Knowledge

> **Version:** 1.0.0 | [Changelog](../CHANGELOG.md)

Structured knowledge layer for agent teams. Three primitives: lessons, decisions, and tasks.

## The Problem

Agent teams accumulate experience across dozens of sessions. Without a structured way to capture it, lessons get lost, decisions get contradicted, and the same mistakes happen twice. Each agent's MEMORY.md only knows what that agent experienced.

## What This Skill Does

Gives your agent team a shared brain:
- **Lessons:** What we learned (prevents repeated mistakes)
- **Decisions:** Why we chose X (prevents contradictory choices)
- **Tasks:** What needs doing (self-managed work queue)

All stored as plain markdown with YAML frontmatter. Searchable via grep or semantic memory (QMD).

## Install

Copy `team-knowledge/` into any agent's `skills/` directory. Best installed on your lead/coordinator agent. All agents can read/write to the shared directory.

## Works With

Any OpenClaw agent team. Best combined with semantic memory (QMD) for search. Works without it via grep.

## Version

v1.0.0 (2026-03-04)
