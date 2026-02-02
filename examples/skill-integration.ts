/**
 * Skill Integration Example
 *
 * This example demonstrates how OM-Lite integrates with OpenClaw skills:
 * - Registering skill capabilities
 * - Binding user preferences to skill parameters
 * - Tracking skill performance
 * - Selecting the best skill for a task
 */

import { OMLite } from 'om-lite';

async function main() {
  const om = new OMLite({
    dbPath: './skill-example.db',
  });

  await om.init();
  console.log('OM-Lite initialized for skill integration');

  // First, add some user preferences
  console.log('\n--- Adding user preferences ---');
  await om.extract(
    `I prefer window seats on flights.
     I usually fly with United Airlines.
     I like vegetarian meals on long flights.`,
    { context: 'User preferences' }
  );

  // Register a skill
  console.log('\n--- Registering skill ---');
  await om.skills.onInstall('flight-booking', {
    name: 'flight-booking',
    version: '1.0.0',
    description: 'Book flights with personalized preferences',
    capabilities: [
      { predicate: 'can_book', object: 'domestic_flights', confidence: 1.0 },
      { predicate: 'can_book', object: 'international_flights', confidence: 0.9 },
      { predicate: 'supports', object: 'multi_city', confidence: 1.0 },
    ],
    parameters: [
      { name: 'seat_preference', type: 'preference', description: 'Preferred seat type' },
      { name: 'preferred_airline', type: 'preference', description: 'Preferred airline' },
      { name: 'meal_preference', type: 'preference', description: 'Dietary requirements' },
    ],
    recommends_packs: ['travel-core'],
  });

  console.log('Skill registered: flight-booking');

  // Get skill capabilities
  console.log('\n--- Skill Capabilities ---');
  const capabilities = await om.skills.getCapabilities('flight-booking');
  console.log('Capabilities:', capabilities);

  // Auto-bind preferences
  console.log('\n--- Auto-binding preferences ---');
  const bindings = await om.skills.bindPreferences('flight-booking');
  console.log('Bindings created:', bindings.length);

  // Get preferences for execution
  console.log('\n--- Preferences for execution ---');
  const prefs = await om.skills.getPreferencesForExecution('flight-booking');
  console.log('Execution preferences:', prefs);

  // Simulate skill execution and record outcome
  console.log('\n--- Recording skill outcome ---');

  // Successful execution
  await om.skills.recordOutcome('flight-booking', {
    success: true,
    taskCategory: 'domestic_flight',
    executionTimeMs: 2500,
    usedClauseIds: [],
  });
  console.log('Recorded successful outcome');

  // Another successful execution
  await om.skills.recordOutcome('flight-booking', {
    success: true,
    taskCategory: 'domestic_flight',
    executionTimeMs: 3200,
  });

  // A failed execution
  await om.skills.recordOutcome('flight-booking', {
    success: false,
    taskCategory: 'international_flight',
    errorType: 'api_error',
    errorMessage: 'Payment gateway timeout',
  });
  console.log('Recorded failed outcome');

  // Get performance stats
  console.log('\n--- Performance Stats ---');
  const performance = await om.skills.getPerformance('flight-booking');
  for (const stat of performance) {
    console.log(`  ${stat.task_category}:`);
    console.log(`    Success: ${stat.success_count}, Failures: ${stat.failure_count}`);
    console.log(`    Avg time: ${stat.avg_execution_time_ms}ms`);
  }

  // Select best skill for a task
  console.log('\n--- Skill Selection ---');
  const bestSkill = await om.skills.selectBest('book a flight to NYC', [
    'flight-booking',
    'travel-agent',
    'generic-booking',
  ]);
  console.log('Best skill:', bestSkill);

  // Clean up
  await om.skills.onUninstall('flight-booking');
  console.log('\nSkill uninstalled');

  await om.close();
  console.log('Done!');
}

main().catch(console.error);
