/**
 * Conflict Resolution Example
 *
 * This example demonstrates OM-Lite's conflict detection and resolution:
 * - Detecting contradicting information
 * - Different resolution strategies
 * - Preserving history
 */

import { OMLite } from 'om-lite';

async function main() {
  const om = new OMLite({
    dbPath: './conflict-example.db',
    conflictResolution: {
      strategy: 'merge_history', // Default strategy
      autoResolveThreshold: 0.2,
      preserveHistory: true,
    },
  });

  await om.init();
  console.log('OM-Lite initialized for conflict resolution demo');

  // Add initial information
  console.log('\n--- Adding initial information ---');
  await om.extract('User lives in Seattle. User works at Microsoft.', {
    context: 'Initial profile',
  });

  const stats1 = await om.getStats();
  console.log(`Clauses: ${stats1.totalClauses}, Conflicts: ${stats1.pendingConflicts}`);

  // Add contradicting information
  console.log('\n--- Adding contradicting information ---');
  const result = await om.extract(
    'User moved to Denver last month. User now works at Google.',
    { context: 'Profile update' }
  );

  console.log(`Extracted ${result.clauses.length} clauses`);
  console.log(`Detected ${result.conflicts.length} conflicts`);

  for (const conflict of result.conflicts) {
    console.log(`  - ${conflict.conflict_type}: ${conflict.description}`);
  }

  // List pending conflicts
  console.log('\n--- Pending conflicts ---');
  const pending = await om.conflicts.list();
  console.log(`${pending.length} pending conflicts`);

  // Resolve with different strategies
  console.log('\n--- Resolution strategies ---');

  // Strategy 1: newest_wins
  console.log('Strategy: newest_wins - Most recent information wins');

  // Strategy 2: highest_confidence
  console.log('Strategy: highest_confidence - Higher confidence wins');

  // Strategy 3: merge_history
  console.log('Strategy: merge_history - Keep new, archive old with link');

  // Resolve all conflicts with default strategy
  console.log('\n--- Resolving all conflicts ---');
  const resolved = await om.conflicts.resolveAll();
  console.log(`Resolved ${resolved} conflicts`);

  // Check final state
  console.log('\n--- Final state ---');
  const stats2 = await om.getStats();
  console.log(`Total clauses: ${stats2.totalClauses}`);
  console.log(`Active clauses: ${stats2.activeClauses}`);
  console.log(`Expired clauses: ${stats2.expiredClauses}`);
  console.log(`Pending conflicts: ${stats2.pendingConflicts}`);

  // Search for current location
  console.log('\n--- Current location ---');
  const locationClauses = await om.searchClauses('lives in', {
    types: ['fact'],
    includeExpired: false,
  });

  for (const clause of locationClauses) {
    console.log(`  - ${clause.natural_form} (${Math.round(clause.confidence * 100)}%)`);
  }

  // Change resolution strategy at runtime
  console.log('\n--- Changing strategy ---');
  om.conflicts.setStrategy({ strategy: 'highest_confidence' });
  console.log('Strategy changed to: highest_confidence');

  await om.close();
  console.log('\nDone!');
}

main().catch(console.error);
