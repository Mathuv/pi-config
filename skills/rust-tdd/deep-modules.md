# Deep Modules in Rust

From *A Philosophy of Software Design* (Ousterhout):

**Deep module** = small interface + lots of implementation

```
┌─────────────────────┐
│   Small Interface   │  ← Few methods, simple params (a focused trait)
├─────────────────────┤
│                     │
│                     │
│  Deep Implementation│  ← Complex logic hidden behind it
│                     │
│                     │
└─────────────────────┘
```

**Shallow module** = large interface + little implementation (avoid)

```
┌─────────────────────────────────┐
│       Large Interface           │  ← Many methods, complex params
├─────────────────────────────────┤
│  Thin Implementation            │  ← Just passes through to something else
└─────────────────────────────────┘
```

## In Rust: Traits and Structs

A deep module in Rust is a trait with few methods backed by rich logic, or a struct that hides complex state behind a clean API.

```rust
// ✅ DEEP: small trait surface, complex implementation hidden
pub trait OrderProcessor: Send + Sync {
    async fn process(&self, order: Order) -> Result<OrderConfirmation, ProcessError>;
}

// The impl handles: validation, inventory check, payment, persistence,
// event emission — all hidden from callers
pub struct DefaultOrderProcessor {
    inventory: Arc<dyn InventoryService>,
    payment: Arc<dyn PaymentGateway>,
    repo: Arc<dyn OrderRepository>,
    events: Arc<dyn EventBus>,
}

impl OrderProcessor for DefaultOrderProcessor {
    async fn process(&self, order: Order) -> Result<OrderConfirmation, ProcessError> {
        // 50 lines of orchestration logic — none visible to callers
    }
}
```

```rust
// ❌ SHALLOW: large interface, thin passthrough
pub trait OrderProcessor {
    async fn validate(&self, order: &Order) -> Result<(), ValidationError>;
    async fn check_inventory(&self, order: &Order) -> Result<(), InventoryError>;
    async fn charge_payment(&self, order: &Order) -> Result<ChargeId, PaymentError>;
    async fn persist(&self, order: &Order, charge: ChargeId) -> Result<OrderId, DbError>;
    async fn emit_event(&self, order_id: OrderId) -> Result<(), EventError>;
    // Caller must know and orchestrate all five steps — nothing is hidden
}
```

The shallow version pushes complexity onto callers. Every caller must call all five methods in the right order and handle errors from each. The deep version hides that orchestration — callers just call `process()`.

## When Designing Interfaces, Ask:

- Can I reduce the number of methods?
- Can I simplify the parameters? (fewer `Option<_>`, fewer booleans)
- Can I hide more complexity inside?
- Would a caller understand what this does without reading the implementation?

## Deep Modules and Testability

Deep modules are *easier* to test — there are fewer entry points, and each test exercises a meaningful behavior:

```rust
// One test per meaningful behavior, not per internal step
#[tokio::test]
async fn process_order_confirms_and_decrements_inventory() { ... }

#[tokio::test]
async fn process_order_returns_error_when_payment_fails() { ... }

#[tokio::test]
async fn process_order_does_not_persist_when_payment_fails() { ... }
```
