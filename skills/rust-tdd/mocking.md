# When to Mock in Rust

Mock at **system boundaries** only:

- External HTTP APIs (payment providers, email services, etc.)
- Databases — prefer a real test database, but mock when integration setup is too heavy
- Time and randomness (`std::time::Instant`, `uuid::Uuid::new_v4`)
- Filesystem (sometimes — prefer `tempfile` crate for real FS tests)

**Don't mock:**
- Your own modules, structs, or domain logic
- Internal collaborators
- Anything you control and can test directly

## The Rust Approach: Traits as Boundaries

In Rust, mockable boundaries are expressed as traits. Inject `Arc<dyn Trait>` or `&dyn Trait` rather than concrete types.

```rust
// Define the boundary as a trait
#[async_trait]
pub trait PaymentGateway: Send + Sync {
    async fn charge(&self, amount: Decimal) -> Result<ChargeId, PaymentError>;
}

// Production implementation
pub struct StripeGateway { client: StripeClient }

#[async_trait]
impl PaymentGateway for StripeGateway {
    async fn charge(&self, amount: Decimal) -> Result<ChargeId, PaymentError> {
        self.client.charge(amount).await.map_err(Into::into)
    }
}

// Function accepts the trait, not the concrete type
pub async fn process_order(
    order: &Order,
    payment: &dyn PaymentGateway,
) -> Result<OrderConfirmation, AppError> {
    let charge_id = payment.charge(order.total).await?;
    Ok(OrderConfirmation { charge_id })
}
```

## Using `mockall`

Add to `Cargo.toml`:
```toml
[dev-dependencies]
mockall = "0.13"
```

Use `#[cfg_attr(test, automock)]` on the trait so the mock only exists in test builds:

```rust
#[cfg_attr(test, mockall::automock)]
#[async_trait]
pub trait PaymentGateway: Send + Sync {
    async fn charge(&self, amount: Decimal) -> Result<ChargeId, PaymentError>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockall::predicate::*;

    #[tokio::test]
    async fn process_order_returns_confirmation_on_successful_charge() {
        let mut mock_payment = MockPaymentGateway::new();
        mock_payment
            .expect_charge()
            .with(eq(dec!(99.99)))
            .once()
            .returning(|_| Ok(ChargeId::new("ch_test_123")));

        let order = Order::new(dec!(99.99));
        let result = process_order(&order, &mock_payment).await;

        assert!(result.is_ok());
    }
}
```

**Note**: only assert on call count (`.once()`, `.times(n)`) when the count is part of the observable contract — e.g. "charge must happen exactly once." Don't assert on it just because you can.

## Mocking Time

For code that uses `tokio::time`, use `tokio::time::pause()` in tests:

```rust
#[tokio::test]
async fn token_expires_after_one_hour() {
    tokio::time::pause();  // freezes the clock

    let token = Token::new();
    assert!(!token.is_expired());

    tokio::time::advance(Duration::from_secs(3601)).await;
    assert!(token.is_expired());
}
```

For non-async code or more control, inject time as a trait:

```rust
pub trait Clock: Send + Sync {
    fn now(&self) -> DateTime<Utc>;
}

pub struct SystemClock;
impl Clock for SystemClock {
    fn now(&self) -> DateTime<Utc> { Utc::now() }
}

#[cfg(test)]
pub struct FixedClock(pub DateTime<Utc>);
#[cfg(test)]
impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> { self.0 }
}
```

## SDK-Style Trait Interfaces

Prefer specific methods per operation over generic dispatchers — each method is independently mockable and type-safe per response shape:

```rust
// ✅ GOOD: each operation is its own method
#[cfg_attr(test, mockall::automock)]
#[async_trait]
pub trait UserRepository: Send + Sync {
    async fn find_by_id(&self, id: UserId) -> Result<Option<User>, DbError>;
    async fn find_by_email(&self, email: &str) -> Result<Option<User>, DbError>;
    async fn save(&self, user: &User) -> Result<(), DbError>;
}

// ❌ BAD: generic dispatcher requires conditional mock logic
#[async_trait]
pub trait Repository: Send + Sync {
    async fn execute(&self, query: &str, params: &[Value]) -> Result<Vec<Row>, DbError>;
}
```

## Prefer Real Implementations in Tests

Where possible, use in-memory implementations over mocks:

```rust
pub struct InMemoryUserRepo {
    users: Arc<Mutex<HashMap<UserId, User>>>,
}

impl InMemoryUserRepo {
    pub fn new() -> Self {
        Self { users: Arc::new(Mutex::new(HashMap::new())) }
    }
}

#[async_trait]
impl UserRepository for InMemoryUserRepo {
    async fn find_by_id(&self, id: UserId) -> Result<Option<User>, DbError> {
        Ok(self.users.lock().unwrap().get(&id).cloned())
    }
    // ...
}
```

In-memory impls exercise real interface contracts, are fast, and don't require `mockall` setup. Use mocks only when you need to assert specific error conditions or need to verify an interaction that can't be observed through the interface.
