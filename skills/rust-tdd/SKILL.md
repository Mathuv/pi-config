---
name: rust-tdd
description: Test-driven development for Rust projects. Use when implementing any Rust feature or bugfix using TDD, red-green-refactor, tracer bullet development, or when designing testable Rust interfaces. Rust-specific translation of the tdd skill — covers vertical slices, behavior testing through public interfaces, trait-based mocking at system boundaries, deep modules, and interface design for testability.
---

# Rust TDD

## Philosophy

**Core principle**: Tests verify behavior through public interfaces, not implementation details. Code can change entirely; tests should not need to.

**Good tests** exercise real Rust code paths through public APIs. They describe *what* the system does. A good test reads like a specification — `test_user_can_checkout_with_valid_cart` tells you exactly what capability exists. These tests survive refactors because they don't care about internal structure.

**Bad tests** are coupled to implementation. They mock internal collaborators, call methods only made `pub(crate)` to enable testing, or verify through back-channels (querying the DB directly instead of using the repository interface). The warning sign: your test breaks when you refactor, but observable behavior hasn't changed.

See [tests.md](tests.md) for Rust examples, [mocking.md](mocking.md) for trait-based mocking guidelines, [deep-modules.md](deep-modules.md) for interface depth, and [interface-design.md](interface-design.md) for testability patterns.

## Anti-Pattern: Horizontal Slices

**DO NOT write all tests first, then all implementation.** This is horizontal slicing — treating RED as "write all tests" and GREEN as "write all code."

This produces bad tests:
- Tests written in bulk verify *imagined* behavior, not *actual* behavior
- You end up testing the *shape* of things (struct fields, function signatures) rather than user-facing behavior
- Tests become insensitive to real changes — they pass when behavior breaks, fail when behavior is fine

**Correct approach**: Vertical slices via tracer bullets. One test → one implementation → repeat.

```
WRONG (horizontal):
  RED:   test_validate_length, test_no_number, test_no_special_char, test_too_long
  GREEN: implement validate_password (all cases)

RIGHT (vertical):
  RED→GREEN: test_validate_length → implement length check
  RED→GREEN: test_no_number      → add number check
  RED→GREEN: test_no_special_char → add special char check
  ...
```

## Workflow

### 1. Planning

Before writing any code:

- [ ] Confirm which interface changes are needed
- [ ] Confirm which behaviors to test (prioritize — you can't test everything)
- [ ] Identify opportunities for [deep modules](deep-modules.md) — small Rust trait surface, deep implementation
- [ ] Design interfaces for [testability](interface-design.md) — pass `&dyn Trait`, return `Result<T, E>`
- [ ] List the behaviors to test (not implementation steps)
- [ ] Get user approval on the plan

Ask: "What should the public interface look like? Which behaviors are most important to test?"

### 2. Tracer Bullet

Write ONE test that confirms ONE thing about the system:

```rust
// RED: write the test first — it won't compile yet
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_password_rejects_short_input() {
        let result = validate_password("hi");
        assert!(result.is_err());
    }
}
```

Run `cargo test` → compile error or test failure. That's your RED.

```rust
// GREEN: minimum code to make this one test pass
pub fn validate_password(password: &str) -> Result<(), PasswordError> {
    if password.len() < 8 {
        return Err(PasswordError::TooShort);
    }
    Ok(())
}
```

Run `cargo test` → passes. That's your GREEN. Now move to the next behavior.

### 3. Incremental Loop

For each remaining behavior:

```
RED:   Write next test → cargo test fails
GREEN: Minimal code to pass → cargo test passes
```

Rules:
- One test at a time
- Only enough code to pass the current test
- Don't anticipate future tests
- Keep tests focused on observable behavior, not internal state

### 4. Refactor

After all tests pass:

- [ ] Extract duplication
- [ ] Deepen modules — move complexity behind simpler interfaces
- [ ] Consider `impl Trait` boundaries over concrete types where it improves testability
- [ ] Run `cargo test` after each refactor step

**Never refactor while RED.** Get to GREEN first.

### 5. Quality Gates (before marking any task complete)

```bash
cargo test                        # all pass
cargo clippy -- -D warnings       # no warnings
cargo fmt --all                   # formatted
```

## Checklist Per Cycle

```
[ ] Test describes behavior, not implementation
[ ] Test uses public interface only — no pub(crate) just for tests
[ ] Test would survive an internal refactor
[ ] Code is minimal for this test — no speculative features
[ ] No unwrap() in production code added to make the test pass
```

## Integration Tests vs Unit Tests

- **Unit tests** (`#[cfg(test)] mod tests` inside the module): for pure logic, domain functions, fast feedback
- **Integration tests** (`tests/` directory at crate root): for public API contracts, cross-module behavior, repository patterns
- **Doc tests** (`/// # Examples` in rustdoc): for demonstrating public API usage — these compile and run as tests

Prefer integration-style tests even in unit test position: test through the public function, not internal helpers.
