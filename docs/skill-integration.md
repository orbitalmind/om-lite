# Skill Integration Guide

OM-Lite integrates with OpenClaw Skills to provide personalized, memory-aware execution.

## Overview

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Skill         │────▶│   OM-Lite       │────▶│   Execution     │
│   Metadata      │     │   Bindings      │     │   Context       │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                       │                       │
        ▼                       ▼                       ▼
   Capabilities            Preferences              Personalized
   Parameters              Matched                  Parameters
```

## How It Works

1. **Skills declare capabilities** in their metadata
2. **OM-Lite ingests** these as structured claims
3. **User preferences** are matched to skill parameters
4. **Execution receives** personalized context

## Skill Metadata

Skills declare their capabilities and parameters in `SKILL.md` or programmatically:

```markdown
---
name: flight-booking
version: 1.0.0
description: Book flights with personalized preferences

capabilities:
  - predicate: can_book
    object: domestic_flights
    confidence: 1.0
  - predicate: can_book
    object: international_flights
    confidence: 0.9
  - predicate: supports
    object: multi_city
    confidence: 1.0

parameters:
  - name: seat_preference
    type: preference
    description: Preferred seat type (window, aisle, middle)
  - name: preferred_airline
    type: preference
    description: Preferred airline for bookings
  - name: meal_preference
    type: preference
    description: Dietary requirements for in-flight meals
  - name: loyalty_program
    type: config
    description: Frequent flyer program number
---
```

## Registering Skills

### Automatic (OpenClaw)

OpenClaw automatically registers skills when installed:

```bash
openclaw skills install flight-booking
# OM-Lite automatically ingests capabilities
```

### Programmatic

```typescript
import { OMLite } from 'om-lite';

const om = new OMLite();
await om.init();

// Register skill
await om.skills.onInstall('flight-booking', {
  name: 'flight-booking',
  version: '1.0.0',
  description: 'Book flights with preferences',
  capabilities: [
    { predicate: 'can_book', object: 'domestic_flights', confidence: 1.0 },
    { predicate: 'can_book', object: 'international_flights', confidence: 0.9 },
  ],
  parameters: [
    { name: 'seat_preference', type: 'preference' },
    { name: 'preferred_airline', type: 'preference' },
  ],
  recommends_packs: ['travel-core', 'travel-airports'],
});
```

## Preference Binding

OM-Lite matches user preference clauses to skill parameters.

### Automatic Binding

```typescript
// User has clause: "User prefers window seats"
// Skill has parameter: seat_preference (type: preference)

// OM-Lite automatically binds them
await om.skills.bindPreferences('flight-booking');

// Get bindings
const bindings = await om.skills.getCapabilities('flight-booking');
console.log(bindings);
// {
//   parameters: [
//     { name: 'seat_preference', boundTo: 'clause-uuid-123', value: 'window' }
//   ]
// }
```

### Manual Binding

```typescript
// Explicitly bind a clause to a parameter
await om.skills.bindPreference(
  'flight-booking',
  'seat_preference',
  'clause-uuid-123'
);
```

### Binding Resolution

OM-Lite uses semantic matching to find relevant preferences:

1. **Exact match** - Parameter name matches clause predicate
2. **Semantic match** - Natural form relates to parameter description
3. **Type match** - Clause type is `preference`

## Execution Context

When a skill executes, get personalized parameters:

```typescript
// Before skill execution
const prefs = await om.skills.getPreferencesForExecution('flight-booking');
console.log(prefs);
// {
//   seat_preference: 'window',
//   preferred_airline: 'United',
//   meal_preference: 'vegetarian'
// }

// Pass to skill
await flightBookingSkill.execute({
  destination: 'Tokyo',
  ...prefs
});
```

## Performance Tracking

Track skill outcomes to improve future selection:

### Recording Outcomes

```typescript
// After successful execution
await om.skills.recordOutcome('flight-booking', {
  success: true,
  taskCategory: 'domestic_flight',
  executionTimeMs: 3500,
  usedClauseIds: ['clause-1', 'clause-2'],
});

// After failure
await om.skills.recordOutcome('flight-booking', {
  success: false,
  taskCategory: 'international_flight',
  errorType: 'api_error',
  errorMessage: 'Payment gateway timeout',
});
```

### Skill Selection

Use performance data to choose the best skill:

```typescript
const bestSkill = await om.skills.selectBest(
  'book a flight to Tokyo',
  ['flight-booking', 'travel-agent', 'kayak-direct']
);

console.log(bestSkill);
// {
//   skillId: 'flight-booking',
//   score: 0.92,
//   reason: 'Highest success rate for international flights'
// }
```

### Performance Stats

```typescript
const stats = await om.skills.getPerformance('flight-booking');
console.log(stats);
// [
//   {
//     skill_id: 'flight-booking',
//     task_category: 'domestic_flight',
//     success_count: 45,
//     failure_count: 2,
//     avg_execution_time_ms: 2800,
//     last_used: '2025-01-15T10:30:00Z'
//   },
//   {
//     skill_id: 'flight-booking',
//     task_category: 'international_flight',
//     success_count: 12,
//     failure_count: 3,
//     avg_execution_time_ms: 5200,
//     last_used: '2025-01-14T15:45:00Z'
//   }
// ]
```

## Recommended Packs

Skills can recommend knowledge packs:

```typescript
await om.skills.onInstall('flight-booking', {
  name: 'flight-booking',
  // ...
  recommends_packs: ['travel-core', 'travel-airports'],
});

// User is prompted to install recommended packs
// or they're auto-installed based on config
```

## Uninstalling Skills

```typescript
await om.skills.onUninstall('flight-booking');
// Removes skill capability claims
// Preserves user preference bindings (optional)
```

## CLI Commands

```bash
# List skills with memory bindings
om-lite skills list

# Auto-bind preferences to a skill
om-lite skills bind flight-booking

# Remove bindings
om-lite skills unbind flight-booking

# View performance stats
om-lite skills performance
om-lite skills performance flight-booking
```

## Best Practices

1. **Declare all parameters** - Even optional ones, so preferences can bind
2. **Use semantic names** - `seat_preference` not `param1`
3. **Record all outcomes** - Both success and failure for accurate stats
4. **Recommend relevant packs** - Help users get useful knowledge
5. **Handle missing preferences** - Gracefully default when no binding exists
6. **Track execution time** - Helps with performance optimization

## Example: Complete Integration

```typescript
import { OMLite } from 'om-lite';

async function bookFlight(destination: string) {
  const om = new OMLite();
  await om.init();

  // 1. Select best skill for the task
  const best = await om.skills.selectBest(
    `book flight to ${destination}`,
    ['flight-booking', 'travel-agent']
  );

  // 2. Get personalized preferences
  const prefs = await om.skills.getPreferencesForExecution(best.skillId);

  // 3. Execute skill
  const startTime = Date.now();
  try {
    const result = await executeSkill(best.skillId, {
      destination,
      ...prefs
    });

    // 4. Record success
    await om.skills.recordOutcome(best.skillId, {
      success: true,
      taskCategory: 'flight_booking',
      executionTimeMs: Date.now() - startTime,
    });

    return result;
  } catch (error) {
    // 4. Record failure
    await om.skills.recordOutcome(best.skillId, {
      success: false,
      taskCategory: 'flight_booking',
      executionTimeMs: Date.now() - startTime,
      errorType: error.name,
      errorMessage: error.message,
    });
    throw error;
  }
}
```
