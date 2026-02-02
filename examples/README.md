# OM-Lite Examples

This directory contains example scripts demonstrating OM-Lite functionality.

## Running Examples

First, build OM-Lite:

```bash
npm run build
```

Then run any example with ts-node or after compiling:

```bash
# With ts-node (recommended for development)
npx ts-node examples/basic-usage.ts

# Or compile and run
npx tsc examples/basic-usage.ts --outDir examples/dist
node examples/dist/basic-usage.js
```

## Examples

### basic-usage.ts

Core functionality demonstration:
- Initializing OM-Lite
- Extracting clauses from text
- Searching and retrieving memory
- Reinforcing clauses
- Running decay
- Generating MEMORY.md

### skill-integration.ts

OpenClaw skill integration:
- Registering skills with capabilities
- Binding user preferences to parameters
- Recording execution outcomes
- Performance tracking
- Skill selection

### conflict-resolution.ts

Handling contradicting information:
- Detecting conflicts
- Resolution strategies
- Preserving history
- Runtime strategy changes

## Notes

- Examples create local `.db` files in the current directory
- Clean up by deleting the `.db` files after running
- These examples require OM-Lite to be built (`npm run build`)
