---
name: rust-brainstorming
description: Use when brainstorming, designing, or architecting a new Rust project or feature. Combines the superpowers brainstorming dialogue flow with Rust-specific requirements gathering, tech stack decisions, and documentation output (architecture docs, ADRs, guardrails). Supersedes invoking rust-architect and brainstorming separately for Rust work.
---

# Rust Brainstorming

Turns Rust project ideas into fully formed designs and specs through structured dialogue, then produces the complete documentation package needed for Director/Implementor AI collaboration.

This skill merges the `superpowers:brainstorming` process flow with `rust-architect` content knowledge. Follow the brainstorming checklist exactly, using the Rust-specific guidance at each step.

<HARD-GATE>
Do NOT write any code, scaffold any project, or create any files until you have presented a design and the user has approved it. This applies to every project regardless of perceived simplicity.
</HARD-GATE>

## Checklist

Complete these steps in order:

1. **Explore project context** — detect Rust markers, check existing structure
2. **Ask Rust clarifying questions** — one at a time, using Phase 1 questions below
3. **Propose 2-3 approaches** — with Rust-specific trade-offs and your recommendation
4. **Present design** — covering architecture, ownership strategy, async patterns, error handling
5. **Write design doc + documentation package** — spec plus full `docs/` tree
6. **Spec self-review** — scan for placeholders, contradictions, ambiguity
7. **User reviews written spec** — wait for approval before proceeding
8. **Transition** — invoke `superpowers:writing-plans`

---

## Step 1: Explore Project Context

Check for:
- `Cargo.toml` or `Cargo.lock` (existing workspace or crate)
- `.rs` source files (understand what's already there)
- `docs/` directory (existing architecture docs)
- `CLAUDE.md` (project-specific AI context)
- Recent git commits for direction

If it's a greenfield project, note that and proceed to clarifying questions.

---

## Step 2: Rust Clarifying Questions

Ask these one at a time. Prefer multiple-choice where options are known. **For each question, state your recommended answer** — this lets the user validate your assumption or redirect you, rather than answering from scratch.

1. **Project domain**: What is this system for?
   - (a) Web service / API
   - (b) CLI tool
   - (c) Data processing pipeline
   - (d) Embedded / systems
   - (e) Other — describe

2. **Structure style**: How should the code be organized?
   - (a) Single crate
   - (b) Binary + library (`src/main.rs` + `src/lib.rs`)
   - (c) Multi-crate Cargo workspace

3. **Async runtime**: Is async I/O needed?
   - (a) Yes — tokio (default recommendation)
   - (b) Yes — async-std
   - (c) No — synchronous only

4. **Web framework** (if web service): Which?
   - (a) axum (recommended — tower ecosystem, excellent middleware composability)
   - (b) actix-web (highest raw throughput, actor model)
   - (c) warp / rocket
   - (d) Not applicable

5. **Database**: Which backend?
   - (a) PostgreSQL + sqlx (recommended — compile-time query checking)
   - (b) PostgreSQL + diesel (ORM approach)
   - (c) SQLite
   - (d) None

6. **Error handling strategy**:
   - (a) `thiserror` for library crates + `anyhow` for application crates (recommended)
   - (b) Custom error types throughout
   - (c) `anyhow` only

7. **Crate type**: Is this a library crate (published/shared) or an application crate (binary, end product)?
   - (a) Library — public API stability matters; apply API Guidelines naming, `#[non_exhaustive]`, sealed traits, no `#[deny(warnings)]`
   - (b) Application — ergonomics over API formality; `anyhow` throughout is fine

8. **Scale targets**: Expected load, users, requests/sec? (Informs concurrency design)

9. **AI collaboration**: Will Director/Implementor AI agents be used for implementation? (Determines whether to generate guardrail docs)

---

## Step 3: Propose 2-3 Approaches

After gathering requirements, propose architectural approaches with trade-offs. Always cover:

**Axis 1 — Workspace structure**
- Single crate: simpler, fine for small-to-medium projects
- Workspace (recommended for services): separates domain logic (`*_core`) from I/O (`*_api`, `*_db`, `*_worker`) — testable, maintainable, parallel compilation

**Axis 2 — Async model** (if async)
- Task-per-request (axum default): simple, scales well to thousands of concurrent connections
- Actor model (actix): better for stateful entities, more complex

**Axis 3 — Data access**
- sqlx with compile-time checked queries (recommended): catches SQL errors at compile time, no ORM magic
- diesel: full ORM, type-safe but more boilerplate

Lead with your recommended combination and explain why given the stated requirements.

---

## Step 4: Present Design

Present in sections, ask for approval after each. Cover:

### Architecture Section
- Workspace layout (crate names, responsibilities)
- Dependency graph between crates (core has no I/O deps; api/db depend on core)
- External service boundaries

### Ownership & Borrowing Strategy
- Where owned data flows vs. shared references
- Arc/Mutex use cases (be explicit — document *why* not just *where*)
- Clone policy: borrow by default, clone only at system boundaries

### Async Patterns
- Tokio task spawning strategy (short-lived vs. long-running tasks)
- Channel types: `mpsc` for work queues, `broadcast` for fan-out, `watch` for state
- Blocking I/O isolation: `tokio::task::spawn_blocking` for CPU-bound work

### Error Handling Design
- Library crates: typed errors with `thiserror`
- Application layer: `anyhow` with `.context()` everywhere
- No `.unwrap()` in production code — panic only in tests and provably-safe locations

### API Design (if library crate)
- Naming: no `get_` prefix for getters; use `iter()`/`iter_mut()`/`into_iter()` for iterators; `as_`/`to_`/`into_` for conversions; acronyms as one word (`Uuid` not `UUID`)
- Implement common traits eagerly on all public types: `Debug`, `Clone`, `PartialEq`, `Eq`, `Hash`, `Default`, `Display` where applicable — missing traits break downstream silently
- Mark public enums `#[non_exhaustive]` so new variants don't break downstream `match` arms
- No `#[deny(warnings)]` in library crates — it breaks downstream users on compiler upgrades

### Domain Model Outline
- Core entities and their ownership (owned vs. Arc-wrapped)
- Key invariants enforced by the type system (newtype wrappers, enums over stringly-typed values)
- **Typestate pattern** where applicable: encode valid lifecycle transitions in generic type parameters using `PhantomData` so invalid state calls don't compile (e.g. `Connection<Disconnected>` vs `Connection<Authenticated>`)
- Money/financial values: always `rust_decimal::Decimal` or `i64` cents — never `f64`

### Testing Strategy
- **Vertical slices only** (see `rust-tdd` skill): one test → one implementation → repeat. Never write all tests before any code.
- Tests verify behavior through public interfaces — no `pub(crate)` just to enable testing, no asserting on call counts
- Mock only at system boundaries (`Arc<dyn Trait>`): external APIs, time, filesystem. Use in-memory implementations for your own repositories.
- Unit tests co-located with code (`#[cfg(test)] mod tests`); integration tests in `tests/`
- Property-based tests with `proptest` for complex invariants
- Target: ≥80% coverage; 100% for financial logic
- See [rust-tdd/tests.md](../rust-tdd/tests.md), [rust-tdd/mocking.md](../rust-tdd/mocking.md), [rust-tdd/interface-design.md](../rust-tdd/interface-design.md) for detailed guidance

---

## Step 4.5: Grill the Design

Before writing anything to disk, adversarially stress-test the design. Walk the decision tree branch by branch — one question at a time — and **provide your recommended answer for each**. The user confirms, redirects, or overrides.

Cover at minimum:
- **Ownership boundaries**: "I'd make `X` owned by `Y` because Z — does that hold when W happens?"
- **Async model**: "My recommendation is tokio multi-thread scheduler because [reason] — is there a case for single-threaded?"
- **Error strategy**: "I'd use `thiserror` in the core crate and `anyhow` at the API layer — should any errors be user-visible?"
- **Workspace split**: "I'd put X in `*_core` and Y in `*_api` — is there logic that could be shared across both?"
- **Testability**: "I'd inject `Arc<dyn Repository>` here rather than a concrete type — is there any reason to prefer a concrete type?"
- **Scaling assumption**: "I'm designing for N concurrent connections with M average latency — is that consistent with your scale targets?"

Stop when you've resolved all branches that affect the spec. Don't grill for the sake of it — stop when the decisions are settled.

---

## Step 5: Write Design Doc + Documentation Package

Once the user approves the design, create two things:

### 5a. Spec document
Write to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` (standard brainstorming output).

### 5b. Rust documentation package
Create this directory structure at the project root (or agreed location):

```
docs/
├── architecture/
│   ├── 00_SYSTEM_OVERVIEW.md      — what the system does, component map
│   ├── 01_DOMAIN_MODEL.md         — entities, relationships, ownership patterns
│   ├── 02_DATA_LAYER.md           — DB schema, sqlx patterns, migration strategy
│   ├── 03_CORE_LOGIC.md           — business rules, pure functions, invariants
│   ├── 04_BOUNDARIES.md           — API contracts, external interfaces
│   ├── 05_CONCURRENCY.md          — task topology, channel usage, shared state
│   ├── 06_ASYNC_PATTERNS.md       — tokio patterns, spawn_blocking policy
│   └── 07_INTEGRATION_PATTERNS.md — external service clients, retry strategy
├── decisions/
│   ├── ADR-001-framework-choice.md
│   ├── ADR-002-error-strategy.md
│   └── ADR-003-ownership-patterns.md
└── guardrails/                    — only if AI collaboration requested
    ├── NEVER_DO.md
    ├── ALWAYS_DO.md
    ├── DIRECTOR_ROLE.md
    ├── IMPLEMENTOR_ROLE.md
    └── CODE_REVIEW_CHECKLIST.md
```

**Populate only what the design has determined.** Don't create placeholder files — write the actual content derived from the approved design.

#### NEVER_DO.md must include at minimum:
- Never use `f64`/`f32` for money — use `rust_decimal::Decimal` or `i64` cents
- Never `.unwrap()` in library code — return `Result<T, E>`
- Never block the async runtime — use `tokio::time::sleep`, not `std::thread::sleep`
- Never interpolate user input in SQL — use sqlx's `query!` macro or `.bind()`
- Never clone without justification — prefer `&T` references
- Never use stringly-typed APIs — use enums for constrained value sets
- Never ignore errors with `let _ =` — always propagate or handle explicitly
- Never use `unsafe` without a `// SAFETY:` comment proving soundness
- Never use `#[deny(warnings)]` in library crates — breaks downstream on compiler upgrades
- Never use Deref polymorphism for method inheritance — Deref is for smart pointers only
- Never use boolean flags when an enum can represent the state — prevents impossible combinations

#### ALWAYS_DO.md must include at minimum:
- Always prefer borrowing over cloning
- Always use `thiserror` for library errors, `anyhow` for application errors
- Always add `.context()` to every `?` propagation
- Always write the test before the implementation (TDD)
- Always run `cargo clippy -- -D warnings` and `cargo fmt --all` before commit
- Always use `Vec::with_capacity` when size is known in advance
- Always separate pure domain logic from I/O (core crate has no network/disk deps)
- Always implement common traits eagerly on public types: `Debug`, `Clone`, `PartialEq`, `Eq`, `Hash`, `Default`, `Display`
- Always follow API naming conventions: no `get_` prefix, `iter()`/`iter_mut()`/`into_iter()`, `as_`/`to_`/`into_` for conversions
- Always use typestate pattern for types with meaningful lifecycles
- Always use `let-else` for early returns on `Option`/`Result` (stable since 1.65)
- Always mark public enums `#[non_exhaustive]` in library crates
- Always structure rustdoc with `# Examples`, `# Panics`, `# Errors`, `# Safety` sections

#### ADR format:
```markdown
# ADR-00N: <Decision Title>

## Status
Accepted

## Context
<Why this decision was needed>

## Decision
<What was decided>

## Consequences
<Trade-offs accepted>
```

---

## Step 6: Spec Self-Review

After writing all files, check:

1. **Placeholder scan**: Any "TBD", "TODO", vague requirements? Fix them.
2. **Internal consistency**: Does the architecture in `00_SYSTEM_OVERVIEW` match `01_DOMAIN_MODEL`? Do the ADRs match the design?
3. **Scope check**: Is this a single deliverable, or does it need decomposition?
4. **Rust invariant check**: Any design decision that violates the core principles (ownership, zero-cost, fearless concurrency, Result-only errors)?

Fix issues inline — no need to re-review after fixing.

---

## Step 7: User Review Gate

After self-review passes:

> "Spec and documentation package written. Please review the files before we write the implementation plan:
> - Spec: `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
> - Architecture docs: `docs/architecture/`
> - ADRs: `docs/decisions/`
> - Guardrails: `docs/guardrails/` (if created)
>
> Let me know if you want changes before we proceed."

Wait for approval. Make requested changes and re-run self-review if needed.

---

## Step 8: Transition to Implementation

Once the user approves, invoke `superpowers:writing-plans` to create the implementation plan.

Do NOT invoke any other skill. `writing-plans` is the only next step.

---

## Rust Core Principles (always apply)

1. **Ownership & Borrowing** — memory safety without a GC; borrow by default, own when needed
2. **Zero-Cost Abstractions** — high-level code should compile to the same machine code as the low-level equivalent
3. **Fearless Concurrency** — the type system prevents data races at compile time
4. **Result-Only Error Handling** — no exceptions; `Result<T, E>` propagated with `?`
5. **Type Safety** — use the type system to make invalid states unrepresentable
6. **Cargo Workspaces** — separate concerns into focused crates with clear dependency directions
7. **Test-Driven Development** — failing test first, always

## Key Principles (inherited from brainstorming)

- **One question at a time** — never overwhelm with a list
- **YAGNI ruthlessly** — remove features that aren't in the requirements
- **Explore alternatives** — always propose 2-3 approaches before settling
- **Incremental validation** — present each design section, get approval before moving on
- **Design for isolation** — each unit has one purpose, communicates through defined interfaces, can be tested independently
