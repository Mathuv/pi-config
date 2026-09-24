# Good and Bad Tests in Rust

## Good Tests

**Integration-style**: test through real interfaces, not internal state.

```rust
// GOOD: tests observable behavior through public API
#[tokio::test]
async fn user_can_checkout_with_valid_cart() {
    let repo = InMemoryOrderRepo::new();
    let cart = Cart::new();
    cart.add(Product::new("book", dec!(12.99)));

    let result = checkout(&cart, &FakePayment::always_ok(), &repo).await;

    assert!(result.is_ok());
    assert_eq!(result.unwrap().status, OrderStatus::Confirmed);
}
```

Characteristics:
- Tests behavior callers care about
- Uses the public API only
- Survives internal refactors
- Describes WHAT, not HOW
- One logical assertion per test (or tightly related assertions for one behavior)

## Bad Tests

**Implementation-detail tests**: coupled to internal structure.

```rust
// BAD: tests that a specific internal method was called
#[test]
fn checkout_calls_payment_processor() {
    let mut mock = MockPaymentProcessor::new();
    mock.expect_process()
        .with(eq(dec!(12.99)))
        .times(1)           // ← asserting on call count: implementation detail
        .returning(|_| Ok(()));

    checkout(&cart, &mock).unwrap();
    mock.checkpoint();      // ← test breaks if you rename process() internally
}
```

Red flags:
- Asserting on call counts or call order
- Making methods `pub(crate)` only to test them directly
- Test breaks when refactoring without behavior change
- Test name describes HOW not WHAT

```rust
// BAD: bypasses the interface to verify via back-channel
#[tokio::test]
async fn create_user_saves_to_database() {
    create_user(NewUser { name: "Alice".into() }).await.unwrap();
    // querying DB directly instead of using the interface
    let row = sqlx::query!("SELECT * FROM users WHERE name = 'Alice'")
        .fetch_one(&pool).await.unwrap();
    assert!(row.id > 0);
}

// GOOD: verifies through the public interface
#[tokio::test]
async fn create_user_makes_user_retrievable() {
    let repo = Arc::new(InMemoryUserRepo::new());
    let user = create_user(NewUser { name: "Alice".into() }, &*repo).await.unwrap();
    let retrieved = repo.find_by_id(user.id).await.unwrap();
    assert_eq!(retrieved.name, "Alice");
}
```

## Test Organization in Rust

```rust
// Unit tests: co-located, inside the module
// src/domain/password.rs
pub fn validate_password(password: &str) -> Result<(), PasswordError> { ... }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_passwords_shorter_than_eight_chars() {
        assert!(validate_password("short").is_err());
    }
}

// Integration tests: in tests/ directory, use the crate as a black box
// tests/checkout.rs
use myapp::{checkout, Cart, Product};

#[tokio::test]
async fn confirmed_order_is_retrievable() { ... }
```

## Naming Convention

Test names should complete the sentence "this test verifies that...":

```rust
// ✅ Behavior-oriented names
fn rejects_empty_password() { }
fn returns_error_when_user_not_found() { }
fn confirmed_order_increments_inventory_count() { }

// ❌ Implementation-oriented names
fn test_validate_password_calls_length_check() { }
fn test_password_struct_field() { }
```
