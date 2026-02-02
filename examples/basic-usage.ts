/**
 * Basic OM-Lite Usage Example
 *
 * This example demonstrates the core functionality of OM-Lite:
 * - Initializing the memory system
 * - Extracting clauses from text
 * - Searching and retrieving memory
 * - Working with confidence and decay
 */

import { OMLite } from 'om-lite';

async function main() {
  // Initialize OM-Lite with custom config
  const om = new OMLite({
    dbPath: './example-memory.db',
    decay: {
      enabled: true,
      defaultRate: 0.001,
      minConfidence: 0.1,
    },
    deduplication: {
      enabled: true,
      similarityThreshold: 0.85,
      onDuplicate: 'reinforce',
    },
  });

  await om.init();
  console.log('OM-Lite initialized');

  // Extract clauses from a conversation
  console.log('\n--- Extracting from conversation ---');
  const extraction = await om.extract(
    `I just moved to Denver from Seattle.
     I prefer window seats when flying, and I usually book with United Airlines.
     My favorite coffee shop is the one on Market Street.`,
    { context: 'User onboarding conversation' }
  );

  console.log(`Extracted ${extraction.clauses.length} clauses:`);
  for (const clause of extraction.clauses) {
    console.log(`  - [${clause.type}] ${clause.natural_form} (${Math.round(clause.confidence * 100)}%)`);
  }

  if (extraction.conflicts.length > 0) {
    console.log(`Detected ${extraction.conflicts.length} conflicts`);
  }

  // Search memory
  console.log('\n--- Searching memory ---');
  const searchResults = await om.searchClauses('travel preferences', {
    types: ['preference'],
    minConfidence: 0.5,
    limit: 5,
  });

  console.log(`Found ${searchResults.length} matching clauses:`);
  for (const clause of searchResults) {
    console.log(`  - ${clause.natural_form}`);
  }

  // Retrieve with scoring
  console.log('\n--- Retrieving relevant memory ---');
  const retrieval = await om.retrieve('booking a flight', {
    limit: 5,
  });

  console.log(`Retrieved ${retrieval.clauses.length} relevant clauses:`);
  for (const clause of retrieval.clauses) {
    console.log(`  - [score: ${clause.score.toFixed(2)}] ${clause.natural_form}`);
  }

  // Reinforce a clause
  if (extraction.clauses.length > 0) {
    console.log('\n--- Reinforcing clause ---');
    const clauseId = extraction.clauses[0].id;
    const before = await om.getClause(clauseId);
    console.log(`Before: ${before?.confidence.toFixed(3)}`);

    await om.reinforceClause(clauseId, 0.05);

    const after = await om.getClause(clauseId);
    console.log(`After: ${after?.confidence.toFixed(3)}`);
  }

  // Get statistics
  console.log('\n--- Memory Statistics ---');
  const stats = await om.getStats();
  console.log(`Total clauses: ${stats.totalClauses}`);
  console.log(`Active clauses: ${stats.activeClauses}`);
  console.log(`Average confidence: ${Math.round(stats.avgConfidence * 100)}%`);
  console.log(`Pending conflicts: ${stats.pendingConflicts}`);

  // Run decay (dry run)
  console.log('\n--- Decay Preview ---');
  const decayReport = await om.runDecay(true);
  console.log(`Would process: ${decayReport.processed} clauses`);
  console.log(`Would decay: ${decayReport.decayed} clauses`);
  console.log(`Would archive: ${decayReport.archived} clauses`);

  // Generate MEMORY.md
  console.log('\n--- Generated MEMORY.md ---');
  const memoryMd = await om.generateMemoryMd();
  console.log(memoryMd.slice(0, 500) + '...');

  // Clean up
  await om.close();
  console.log('\nDone!');
}

main().catch(console.error);
