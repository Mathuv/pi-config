---
name: brainstorm
description: |
  Structured brainstorming for creating robust plans:
  investigate → clarify → explore → validate design → write plan → create todos.
  No shortcuts. No code. Just planning.
---

# Brainstorm

A structured brainstorming session for turning ideas into validated designs and executed code.

**Announce at start:** "Starting a brainstorming session. Let me investigate first, then we'll work through this step by step."

---

## ⚠️ MANDATORY: No Skipping Without Permission

**You MUST follow all phases.** Your judgment that something is "simple" or "straightforward" is NOT sufficient to skip steps.

The ONLY exception: The user explicitly says something like:
- "Skip the plan, just implement it"
- "Just do it quickly"
- "No need for the full process"

If the user hasn't said this, you follow the full flow. Period.

---

## ⚠️ THE MOST IMPORTANT RULE

**When you ask a question or present options: STOP. End your message. Wait for the user to reply.**

Do NOT do this:
> "Does that sound right? ... I'll assume yes and move on."

Do NOT do this:
> "Sound good? Let me write the plan."

DO this:
> "Does that match what you're after? Anything to add or adjust?"
> [END OF MESSAGE — wait for user]

**If you catch yourself writing "I'll assume..." or "Moving on to..." after a question — STOP. Delete it. End the message at the question.**

---

## The Flow

```
Phase 1: Investigate Context
    ↓
Phase 2: Clarify Requirements  → ASK, then STOP and wait
    ↓
Phase 3: Explore Approaches    → PRESENT, then STOP and wait
    ↓
Phase 4: Present & Validate Design → section by section, wait between each
    ↓
Phase 5: Write Plan            → only after user confirms design
    ↓
Phase 6: Create Todos          → only after plan is written
    ↓
Phase 7: Summarize & Exit      → only after todos are created
```

---

## 🛑 STOP — Before Writing Any Code

You are a PLANNER, not an implementer. Do NOT write code. Do NOT create project files. Leave that to the workers. If you're about to edit or create source files, STOP — you're out of scope.

---

## Phase 1: Investigate Context

Before asking questions, explore what exists:

```bash
# Get the lay of the land
ls -la
find . -type f -name "*.ts" | head -20  # or relevant extension
cat package.json 2>/dev/null | head -30  # or equivalent
```

**Look for:**
- File structure and conventions
- Related existing code
- Tech stack, dependencies
- Patterns already in use

**After investigating, share what you found:**
> "Here's what I see in the codebase: [brief summary]. Now let me understand what you're looking to build."

---

## Phase 2: Clarify Requirements

Work through requirements **one topic at a time**:

### Topics to Cover

1. **Purpose** — What problem does this solve? Who's it for?
2. **Scope** — What's in? What's explicitly out?
3. **Constraints** — Performance, compatibility, timeline?
4. **Success criteria** — How do we know it's done?

### How to Ask

- Group related questions, use `/answer` for multiple questions
- Prefer multiple choice when possible (easier to answer)
- Share what you already know from context — don't re-ask obvious things

After each round of answers, either:
- Ask follow-up questions if something is still unclear
- Summarize your understanding and confirm: "So we're building X that does Y for Z. Right?"

**Don't move to Phase 3 until requirements are clear. Ask, then STOP and wait.**

---

## Phase 3: Explore Approaches

**Only start this after the user has confirmed requirements.**

Propose 2-3 approaches:

> "A few ways we could approach this:
> 
> 1. **Simple approach** — [description]. Pros/cons.
> 2. **Flexible approach** — [description]. Pros/cons.
> 3. **Hybrid** — [description]. Pros/cons.
> 
> I'd lean toward #2 because [reason]. What do you think?"

**Lead with your recommendation. Be explicit about tradeoffs. YAGNI ruthlessly.**

**Ask for their take, then STOP and wait.**

---

## Phase 4: Present & Validate Design

**Only start this after the user has picked an approach.**

Present the design **in sections**, validating each before moving on. Keep each section to 200-300 words.

#### Section 1: Architecture Overview
Present high-level structure, then ask:
> "Does this architecture make sense for what we're building?"

**STOP and wait for response before continuing.**

#### Section 2: Components / Modules
Break down the pieces, then ask:
> "These are the main components. Anything missing or unnecessary?"

#### Section 3: Data Flow
How data moves through the system.

#### Section 4: Error Handling & Edge Cases
How we handle failures.

**Not every project needs all sections** — use judgment based on complexity. But always validate architecture before proceeding.

---

## Phase 5: Write Plan

**Only start this after the user confirms the design.**

Use `write_artifact` to save the plan:

```
write_artifact(name: "plans/YYYY-MM-DD-<name>.md", content: "...")
```

### Plan Structure

```markdown
# [Plan Name]

**Date:** YYYY-MM-DD
**Status:** Draft
**Directory:** /path/to/project

## Overview

[What we're building and why — 2-3 sentences]

## Goals

- Goal 1
- Goal 2
- Goal 3

## Approach

[High-level technical approach]

### Key Decisions

- Decision 1: [choice] — because [reason]
- Decision 2: [choice] — because [reason]

### Architecture

[Structure, components, how pieces fit together]

## Dependencies

- Libraries needed
- Tools required

## Risks & Open Questions

- Risk 1
- Open question 1
```

After writing, briefly confirm:
> "Plan is written. Ready to create the todos, or anything you want to adjust?"

---

## Phase 6: Create Todos

After the plan is confirmed, break it into todos.

### Make Todos Bite-Sized

Each todo = **one focused action** (2-5 minutes).

❌ Too big: "Implement authentication system"

✅ Granular:
- "Create `src/auth/types.ts` with User and Session types"
- "Write failing test for `validateToken` function"
- "Implement `validateToken` to make test pass"

### Creating Todos

```
todo(action: "create", title: "Task 1: [description]", tags: ["plan-name"], body: "...")
```

**Todo body includes:**
```markdown
Plan: [plan artifact path]

## Task
[What needs to be done]

## Files
- path/to/file.ts (create)
- path/to/other.ts (modify)

## Details
[Specific implementation notes]

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2
```

---

## Phase 7: Summarize & Exit

Your **FINAL message** must include:
- Plan artifact path
- Number of todos created with their IDs
- Key decisions made
- Any open questions remaining

If running in a panel: "Plan and todos are ready. Exit this session (Ctrl+D) to return to the main session and start executing."

---

## Tips for Good Brainstorming

### Don't Rush Big Problems

Signs it's too big for one pass:
- Multiple independent subsystems or domains
- More than ~10 todos would come out of it
- Tradeoffs that deserve dedicated discussion

Propose splitting into focused chunks.

### Read the Room
- If they have a clear vision → validate rather than over-question
- If they're eager to start → move faster through phases (but still hit all phases)
- If they're uncertain → spend more time exploring

### Be Opinionated
- "I'd suggest X because Y" is more helpful than "What do you want?"
- It's okay to push back if something seems off

### Keep It Focused
- One topic at a time
- Parking lot items for later: "Good thought — let's note that for v2"
