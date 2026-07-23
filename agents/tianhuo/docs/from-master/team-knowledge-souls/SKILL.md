---
name: team-knowledge
description: Structured knowledge layer for agent teams. Lessons, decisions, and tasks with templates and search. Prevents teams from repeating mistakes, losing institutional memory, or making contradictory decisions.
---

# Team Knowledge

A shared knowledge system for agent teams. Three primitives that capture what the team learns, decides, and needs to do.

## The Three Primitives

### Lessons
What we learned from incidents, reviews, and conversations. Prevents repeated mistakes.

**Location:** `~/.openclaw/shared-knowledge/lessons/`

**When to write a lesson:**
- After any incident or unexpected failure
- When a user corrects you
- When you discover a pattern that would help other agents
- After any rule change

**Template:**
```yaml
---
date: YYYY-MM-DD
source: [agent-id]
tags: [relevant, keywords]
agents: [affected-agent-ids]
severity: [low, medium, high]
---

# [Brief Title]

## What Happened
[Factual description of the event]

## What We Learned
[The insight - specific enough to change behavior]

## Rule Change
[If this creates a new rule, state it exactly. If not, say "None."]

## Propagation
- [ ] Added to [agent] SOUL.md
- [ ] Added to [agent] MEMORY.md
- [ ] Verified in next session
```

### Decisions
Why we chose X over Y. Institutional memory that survives session resets.

**Location:** `~/.openclaw/shared-knowledge/decisions/`

**When to write a decision:**
- After any significant architectural or strategic choice
- When the user makes a call that affects multiple agents
- When choosing between competing approaches

**Template:**
```yaml
---
date: YYYY-MM-DD
decision_maker: [user or agent-id]
status: [active, superseded, reversed]
tags: [relevant, keywords]
affects: [agent-ids or "all"]
---

# [Decision Title]

## Context
[What prompted this decision]

## Options Considered
1. [Option A] - [pros/cons]
2. [Option B] - [pros/cons]

## Decision
[What was chosen and why]

## Consequences
[What changes as a result]
```

### Tasks
Self-managed work queue. Agents can create, pick up, and close tasks.

**Location:** `~/.openclaw/shared-knowledge/tasks/`

**Template:**
```yaml
---
date: YYYY-MM-DD
owner: [agent-id or "unassigned"]
status: [open, in-progress, done, blocked]
priority: [low, medium, high, critical]
tags: [relevant, keywords]
---

# [Task Title]

## Description
[What needs to be done]

## Acceptance Criteria
- [ ] [Specific criterion 1]
- [ ] [Specific criterion 2]

## Notes
[Any context, blockers, or updates]
```

## Setup

### First Time
Create the directory structure:
```bash
mkdir -p ~/.openclaw/shared-knowledge/{lessons,decisions,tasks,templates}
```

Copy the three templates above into `templates/` as `lesson.md`, `decision.md`, `task.md`.

### Adding to QMD (Recommended)
If semantic memory (QMD) is configured, add shared-knowledge as an indexed path:

```json
{
  "memory": {
    "qmd": {
      "paths": [
        {
          "path": "~/.openclaw/shared-knowledge",
          "name": "shared-knowledge",
          "pattern": "**/*.md"
        }
      ]
    }
  }
}
```

Apply via `gateway config.patch`. This enables semantic search across all team knowledge.

## How to Search

```bash
# Search everything
grep -r "keyword" ~/.openclaw/shared-knowledge/

# Find by tag
grep -rl "tags:.*keyword" ~/.openclaw/shared-knowledge/

# Find by agent
grep -rl "agents:.*agent-name" ~/.openclaw/shared-knowledge/lessons/

# Find open tasks
grep -rl "status: open" ~/.openclaw/shared-knowledge/tasks/
```

With QMD configured, agents can also use semantic memory search to find relevant knowledge automatically.

## Maintenance

During nightly compound loops:
- Check for open tasks that are stale (> 7 days, no updates)
- Write lessons from any incidents or corrections that day
- Verify decisions are still active (not superseded by newer ones)
- Archive completed tasks older than 30 days to `~/.openclaw/shared-knowledge/archive/`

## Who Can Write

Any agent can write lessons and tasks. Decisions should note who made the call (user or agent). The knowledge base is shared across the entire team - that is the point.

## Naming Convention

Files: `YYYY-MM-DD-brief-description.md`
Keep names lowercase, hyphenated, descriptive.
