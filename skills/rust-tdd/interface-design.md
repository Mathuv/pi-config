# Interface Design for Testability in Rust

Good interfaces make testing natural. Three rules:

## 1. Accept Dependencies, Don't Create Them

Pass external dependencies in as trait objects rather than constructing concrete types inside functions.

```rust
// ✅ Testable: dependency injected as trait
pub async fn process_order(
    order: &Order,
    payment: &dyn PaymentGateway,
    repo: &dyn OrderRepository,
) -> Result<OrderConfirmation, AppError> {
    let charge = payment.charge(order.total).await?;
    repo.save(&Order::confirmed(order, charge)).await?;
    Ok(OrderConfirmation::new(charge))
}

// ❌ Hard to test: creates its own dependency internally
pub async fn process_order(order: &Order) -> Result<OrderConfirmation, AppError> {
    let payment = StripeGateway::new(std::env::var("STRIPE_KEY").unwrap());
    let charge = payment.charge(order.total).await?;
    // ...
}
```

In tests, pass a `MockPaymentGateway` or `InMemoryOrderRepository`. In production, pass the real `StripeGateway` and `SqlxOrderRepository`.

## 2. Return Results, Don't Produce Hidden Side Effects

Pure functions that return `Result<T, E>` are directly assertable. Functions that mutate hidden state require back-channel inspection.

```rust
// ✅ Testable: result is directly assertable
pub fn calculate_discount(cart: &Cart, coupon: &str) -> Result<Discount, CouponError> {
    match coupon {
        "SAVE10" => Ok(Discount::percentage(10)),
        "SAVE20" => Ok(Discount::percentage(20)),
        _ => Err(CouponError::Invalid),
    }
}

// ❌ Hard to test: mutates cart in place, no return value to assert on
pub fn apply_discount(cart: &mut Cart, coupon: &str) {
    if coupon == "SAVE10" {
        cart.total = cart.total * dec!(0.9);
    }
}
```

Separate the calculation (pure, returns a value) from the application (impure, mutates state):

```rust
// ✅ Compose: pure calculation + explicit mutation
let discount = calculate_discount(&cart, coupon)?;
cart.apply(discount);
```

## 3. Small Surface Area

Fewer methods = fewer tests needed. Fewer parameters = simpler test setup.

```rust
// ✅ Focused: one method, clear contract
pub trait TokenValidator: Send + Sync {
    fn validate(&self, token: &str) -> Result<Claims, AuthError>;
}

// ❌ Sprawling: requires test setup for methods you don't need
pub trait AuthService: Send + Sync {
    fn validate_token(&self, token: &str) -> Result<Claims, AuthError>;
    fn refresh_token(&self, token: &str) -> Result<String, AuthError>;
    fn revoke_token(&self, token: &str) -> Result<(), AuthError>;
    fn list_active_tokens(&self, user_id: UserId) -> Result<Vec<Token>, DbError>;
    fn rotate_signing_key(&self) -> Result<(), KeyError>;
}
```

When a test only needs `validate`, it shouldn't need to stub `refresh_token`, `revoke_token`, etc. Split traits by use case (Interface Segregation Principle — natural in Rust).

## The Rust Idiom: Builder + Trait Injection

For complex service construction in tests, combine the builder pattern with trait injection:

```rust
// Production
let processor = OrderProcessor::builder()
    .payment(Arc::new(StripeGateway::new(config.stripe_key)))
    .repo(Arc::new(SqlxOrderRepo::new(pool.clone())))
    .build();

// Test
let processor = OrderProcessor::builder()
    .payment(Arc::new(MockPaymentGateway::always_ok()))
    .repo(Arc::new(InMemoryOrderRepo::new()))
    .build();
```

Same call site, different implementations — no `#[cfg(test)]` scattered through production code.
