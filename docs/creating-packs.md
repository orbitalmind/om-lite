# Creating Knowledge Packs

Knowledge Packs are pre-built collections of structured claims that accelerate your agent's usefulness in specific domains.

## Pack Structure

```
my-pack/
├── PACK.yaml          # Metadata (required)
├── README.md          # Documentation (recommended)
├── *.claims           # Claim files (at least one required)
└── CHANGELOG.md       # Version history (optional)
```

## PACK.yaml

The manifest file that describes your pack:

```yaml
name: my-pack-name
version: 1.0.0
description: Brief description of the pack
author: your-github-username
license: MIT

# Which skills this pack enhances
enhances_skills:
  - flight-booking
  - travel-planning

# Geographic regions (for filtering)
regions:
  - global
  - north-america
  - europe

# Claim files to load
claim_files:
  - facts.claims
  - relationships.claims
  - tips.claims

# Statistics (updated when pack is built)
stats:
  total_claims: 150
  by_type:
    fact: 100
    relationship: 30
    context: 20

# Optional: schedule for updates
update_schedule: monthly

# Optional: dependencies on other packs
requires_packs:
  - geography-core

# Searchable tags
tags:
  - travel
  - airports
  - airlines
```

## Claim Files (.claims)

Claims are stored in YAML format with the `.claims` extension:

```yaml
# facts.claims
claims:
  - type: fact
    subject: airport:JFK
    predicate: iata_code
    object: JFK
    natural_form: John F. Kennedy International Airport has IATA code JFK
    confidence: 1.0
    tags:
      - airport
      - new-york

  - type: fact
    subject: airport:JFK
    predicate: located_in
    object: New York, USA
    natural_form: JFK Airport is located in New York, USA
    confidence: 1.0

  - type: fact
    subject: airport:JFK
    predicate: terminals
    object: "6"
    natural_form: JFK Airport has 6 terminals
    confidence: 0.95
    metadata:
      as_of: "2025-01"
```

## Claim Types

| Type | Use For | Example |
|------|---------|---------|
| `fact` | Objective, verifiable information | "JFK has IATA code JFK" |
| `relationship` | Connections between entities | "United is a member of Star Alliance" |
| `context` | Situational information | "Peak travel times at LAX are 7-9 AM" |
| `preference` | Common preferences (not personal) | "Most travelers prefer direct flights" |
| `skill` | Skill capabilities | "flight-booking can search multi-city" |

## SPO Structure

Every claim follows Subject-Predicate-Object (SPO) structure:

```yaml
subject: entity:identifier    # Who/what the claim is about
predicate: relationship       # The relationship or property
object: value                 # The value or target entity
natural_form: Human readable  # Natural language version
```

### Subject Naming Conventions

Use namespaced identifiers:

```yaml
# Entities
subject: airport:JFK
subject: airline:united
subject: city:new-york
subject: country:usa

# Concepts
subject: booking:cancellation-policy
subject: travel:peak-season
```

### Common Predicates

```yaml
# Identity
predicate: iata_code
predicate: icao_code
predicate: official_name

# Location
predicate: located_in
predicate: timezone
predicate: coordinates

# Relationships
predicate: member_of
predicate: alliance
predicate: hub_for
predicate: operates_from

# Properties
predicate: terminals
predicate: annual_passengers
predicate: founded_year

# Policies
predicate: baggage_policy
predicate: cancellation_policy
predicate: check_in_time
```

## Confidence Guidelines

| Confidence | Use For |
|------------|---------|
| 1.0 | Definitional facts (IATA codes, country capitals) |
| 0.95 | Highly stable facts (airline alliances, airport locations) |
| 0.85-0.9 | Generally stable (policies, typical times) |
| 0.7-0.8 | Variable/regional (prices, availability) |
| < 0.7 | Avoid in packs - too uncertain |

## Metadata

Add temporal and source metadata for claims that may change:

```yaml
- type: fact
  subject: airline:southwest
  predicate: baggage_policy
  object: "2 free checked bags up to 50 lbs each"
  natural_form: Southwest allows 2 free checked bags up to 50 lbs
  confidence: 0.95
  metadata:
    as_of: "2025-01"
    source: "southwest.com/baggage"
    valid_regions:
      - usa
      - mexico
```

## Validation

Before publishing, validate your pack:

```bash
# Validate structure
om-lite packs validate ./my-pack

# Dry-run installation
om-lite packs install ./my-pack --dry-run

# Check for conflicts with existing packs
om-lite packs check-conflicts ./my-pack
```

## Complete Example

### PACK.yaml

```yaml
name: travel-airports
version: 1.0.0
description: Major world airports with codes, locations, and facilities
author: orbitalmind
license: MIT

enhances_skills:
  - flight-booking
  - travel-planning

regions:
  - global

claim_files:
  - airports-na.claims
  - airports-eu.claims
  - airports-asia.claims

stats:
  total_claims: 450
  by_type:
    fact: 400
    relationship: 50

tags:
  - travel
  - airports
  - aviation
```

### airports-na.claims

```yaml
claims:
  # Los Angeles International
  - type: fact
    subject: airport:LAX
    predicate: iata_code
    object: LAX
    natural_form: Los Angeles International Airport has IATA code LAX
    confidence: 1.0

  - type: fact
    subject: airport:LAX
    predicate: located_in
    object: Los Angeles, California, USA
    natural_form: LAX is located in Los Angeles, California
    confidence: 1.0

  - type: fact
    subject: airport:LAX
    predicate: terminals
    object: "9"
    natural_form: LAX has 9 terminals
    confidence: 0.95

  - type: relationship
    subject: airport:LAX
    predicate: hub_for
    object: airline:united
    natural_form: LAX is a hub for United Airlines
    confidence: 0.95

  - type: relationship
    subject: airport:LAX
    predicate: hub_for
    object: airline:delta
    natural_form: LAX is a hub for Delta Air Lines
    confidence: 0.95
```

## Publishing

1. Create your pack in a directory
2. Validate with `om-lite packs validate`
3. Test installation locally
4. Submit a PR to the [om-lite repository](https://github.com/orbitalmind/om-lite) under `packs/`

## Best Practices

1. **Be specific** - Vague claims aren't useful
2. **Date volatile data** - Use `as_of` metadata
3. **Cite sources** - Add source URLs in metadata
4. **Avoid opinions** - Stick to verifiable facts
5. **Use consistent naming** - Follow the subject naming conventions
6. **Group related claims** - Use multiple .claims files for organization
7. **Keep confidence realistic** - Don't inflate confidence scores
8. **Test with real queries** - Ensure claims are retrievable
