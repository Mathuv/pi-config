---
name: rust-review
description: Code review for Rust projects. Use when reviewing Rust code, a PR, or before marking an implementation task complete. Enforces the full enhanced Rust standard: API Guidelines naming, typestate pattern, vertical TDD, interface testability, deep modules, all 18 NEVER_DO prohibitions and 31 ALWAYS_DO practices from rust-architect. Supersedes the generic superpowers:code-reviewer for Rust work.
---

# Rust Code Review

Comprehensive review against the full Rust quality standard. Work through each section in order. Mark each item ✅ (pass), ❌ (violation — must fix), or N/A.

**A single ❌ blocks approval.** Summarise findings at the end with: overall verdict, list of required fixes (❌), and optional suggestions.

---

## 0. Quick Gates (run first — fail fast)

```bash
cargo test                        # must pass with zero failures
cargo clippy -- -D warnings       # must produce zero warnings
cargo fmt --check                 # must be clean
```

If any of these fail, stop. Return the output and request a fix before continuing the review.

---

## 1. NEVER_DO Violations

Check for any of the 18 prohibitions. Each is a hard ❌.

- [ ] No `f64`/`f32` for money — only `rust_decimal::Decimal` or `i64` cents
- [ ] No `.unwrap()` or `.expect()` in production code — only in tests and provably-safe locations
- [ ] No blocking the async runtime — `tokio::time::sleep` not `std::thread::sleep`; no synchronous I/O on async threads
- [ ] No user input interpolated in SQL — only `sqlx::query!` macro or `.bind()`
- [ ] No `.clone()` without justification — prefer `&T`; if cloning, it should be obvious why
- [ ] No stringly-typed APIs — enums for constrained value sets, newtypes for domain identifiers
- [ ] No errors silently discarded — no `let _ = result` for `Result`/`Option`
- [ ] No `unsafe` without `// SAFETY:` comment proving soundness
- [ ] No `#[deny(warnings)]` in library crates — only allowed in application crates or enforced via CI flags
- [ ] No Deref polymorphism — `Deref` is for smart pointers only, not method inheritance
- [ ] No boolean flags where an enum represents state — `is_open: bool, is_authenticated: bool` → `enum ConnectionState`
- [ ] No returning references to local data — would be caught by the compiler, but flag any `unsafe` that works around this
- [ ] No `Arc<Mutex<T>>` as default for shared state — `AtomicT` for counters, `RwLock` for read-heavy, channels for message passing
- [ ] No collecting when iteration suffices — `for x in iter` not `let v: Vec<_> = iter.collect(); for x in v`
- [ ] No `String` parameter where `&str` suffices
- [ ] No errors without context — every `?` should have `.context("...")` or `.with_context(|| ...)`
- [ ] No `transmute` without `#[repr(C)]` on involved types
- [ ] No directly interpolated user input anywhere (not just SQL — shell commands, paths, log messages that feed interpreters)

---

## 2. API Design (for library crates)

Skip this section if the crate is an application binary with no public API.

**Naming conventions (Rust API Guidelines):**
- [ ] Types and traits: `UpperCamelCase`; acronyms count as one word (`Uuid` not `UUID`, `HttpClient` not `HTTPClient`)
- [ ] No `get_` prefix on getters — use `.name()` not `.get_name()`
- [ ] Iterator methods named `iter()`, `iter_mut()`, `into_iter()` — not `items()`, `get_items()`, etc.
- [ ] Conversion methods: `as_X()` (cheap borrow), `to_X()` (potentially allocating), `into_X()` (consuming)
- [ ] Constructor convention: `new()` for the primary zero-argument or simple constructor

**Trait implementation completeness:**
- [ ] All public types derive or implement `Debug`
- [ ] Types that should be copyable derive `Clone` (and `Copy` if cheap)
- [ ] Types used as map keys derive `Hash`, `PartialEq`, `Eq`
- [ ] Types with a sensible zero-value implement `Default`
- [ ] User-facing types implement `Display` (not just `Debug`)
- [ ] Types that cross serialization boundaries derive `serde::Serialize`/`Deserialize`

**Future-proofing (library crates):**
- [ ] Public enums are marked `#[non_exhaustive]` — adding a variant should not break downstream `match`
- [ ] Consider sealing traits that should not be implemented externally

---

## 3. TDD Compliance

- [ ] **Vertical slices**: no evidence of horizontal slicing (all tests written before any implementation). Check commit history if available — each commit should show test + implementation together, not a batch of tests followed by a batch of implementations.
- [ ] **Behavior tests, not implementation tests**: tests use public interfaces only. No `pub(crate)` methods that exist solely to enable testing. No assertions on call counts unless count is part of the contract.
- [ ] **Test names describe behavior**: `rejects_password_shorter_than_eight_chars` not `test_validate_password_length_check`
- [ ] **Mocking at boundaries only**: mocks/stubs are used only for external systems (payment APIs, email, filesystem, time). Own repositories and domain logic use real implementations or in-memory fakes — never mocked.
- [ ] **Tests survive refactor**: would these tests break if you renamed an internal function or restructured a private module? If yes, the test is testing implementation.
- [ ] **One logical assertion per test** (or tightly related assertions for a single behavior)
- [ ] **Error paths tested**: not just the happy path
- [ ] **Async tests use `#[tokio::test]`**, not `#[test]`

---

## 4. Interface Design & Testability

- [ ] External dependencies injected as `&dyn Trait` or `Arc<dyn Trait>` — not constructed inside functions
- [ ] Pure functions return `Result<T, E>` — don't produce side effects and return `()`  when the result could be observed
- [ ] **Deep modules**: does each public type/trait have a small surface (few methods, simple params) hiding complex implementation? Flag shallow types that just pass-through to internal helpers.
- [ ] No `pub(crate)` solely to allow testing — redesign the interface instead
- [ ] Trait boundaries match use cases — no single mega-trait where multiple focused traits would enable better composition

---

## 5. Ownership & Async Patterns

**Ownership:**
- [ ] Borrows preferred over clones at function boundaries
- [ ] `Arc` only where shared ownership across threads is genuinely needed — not used by default
- [ ] Typestate pattern applied where the type has a meaningful lifecycle (connection, request, transaction) — or flag where it's missing and would prevent a class of bugs
- [ ] Newtype wrappers used for domain identifiers (`UserId`, `OrderId`) — not bare `u64`/`Uuid`

**Async:**
- [ ] No blocking calls (file I/O, `std::thread::sleep`, CPU-bound work) on the tokio executor — use `spawn_blocking`
- [ ] No `.await` inside tight loops where `futures::join_all` or `FuturesUnordered` would be appropriate
- [ ] `tokio::time::sleep` not `std::thread::sleep` everywhere in async context
- [ ] Connection pools configured (min/max) — not creating new connections per request

---

## 6. Error Handling

- [ ] Library crates use `thiserror` for typed errors
- [ ] Application crates use `anyhow::Result` at the boundary
- [ ] Every `?` has `.context()` or `.with_context()` — "Failed to open config file: {path}" not bare propagation
- [ ] Error variants are meaningful — not a single `Error(String)` catch-all in a library
- [ ] `# Errors` section in rustdoc for all fallible public functions

---

## 7. Documentation

- [ ] Public functions have `///` rustdoc comments
- [ ] Rustdoc sections present where applicable: `# Examples`, `# Panics`, `# Errors`, `# Safety`
- [ ] `# Examples` code compiles (`cargo test --doc`)
- [ ] `# Panics` documents every panic condition
- [ ] Comments explain WHY, not WHAT — no comments that restate what the code already says
- [ ] No TODO comments without a tracking reference

---

## 8. Financial Integrity (if applicable)

Skip if no money, prices, balances, or financial calculations are present.

- [ ] All monetary values use `rust_decimal::Decimal` or `i64` cents — no `f32`/`f64` anywhere in the money path
- [ ] Database columns for money use `NUMERIC` or `BIGINT` — never `REAL`/`DOUBLE PRECISION`
- [ ] Rounding is explicit and commented with business justification
- [ ] Financial operations are idempotent
- [ ] Audit trail: every mutation logs timestamp, actor, before/after values

---

## 9. Security

- [ ] All SQL uses parameterized queries — no string concatenation
- [ ] Passwords hashed with argon2/bcrypt — never stored plaintext or with MD5/SHA1
- [ ] No secrets in source code — env vars or secret manager only
- [ ] JWT tokens have expiration
- [ ] Authorization checked on every protected endpoint — not just at the route level
- [ ] CORS is restrictive — not `allow_origin("*")` in production

---

## 10. Architecture Consistency

- [ ] Domain logic is pure — no I/O, no HTTP calls, no DB queries in the `*_core` crate
- [ ] Dependencies flow inward: `*_api` → `*_core`, `*_db` → `*_core`; no reverse dependencies
- [ ] No circular dependencies between crates
- [ ] Changes are consistent with the ADRs in `docs/decisions/` (if present)
- [ ] No architectural decisions made silently — if the implementation diverges from the design doc, flag it

---

## Review Summary

After completing all sections, provide:

```
## Review Result: [APPROVED | CHANGES REQUIRED | REJECTED]

### Required fixes (❌)
1. [file:line] [violation] — [what to do instead]
2. ...

### Suggestions (optional, non-blocking)
- ...

### Notes
- ...
```

**APPROVED**: all items ✅ or N/A, quick gates pass.
**CHANGES REQUIRED**: one or more ❌ that are fixable without redesign.
**REJECTED**: architectural violation, missing tests for critical paths, or NEVER_DO violation in financial/security code.
