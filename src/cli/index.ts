#!/usr/bin/env node

/**
 * OM-Lite CLI
 * Command-line interface for Orbital Mind Lite
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { OMLite } from '../index.js';
import { BackupManager } from '../core/backup.js';
import { migrateFromFile, migrateFromMemoryMd, detectFormat } from '../core/migration.js';
import { homedir } from 'os';
import { existsSync } from 'fs';

const program = new Command();

// Helper to get OMLite instance
async function getOMLite(options: { db?: string } = {}): Promise<OMLite> {
  const dbPath = options.db ?? '~/.openclaw/memory/om-lite.db';
  const om = new OMLite({ dbPath });
  await om.init();
  return om;
}

// Helper to format confidence as percentage
function formatConfidence(conf: number): string {
  const pct = Math.round(conf * 100);
  if (pct >= 80) return chalk.green(`${pct}%`);
  if (pct >= 50) return chalk.yellow(`${pct}%`);
  return chalk.red(`${pct}%`);
}

// ========== Main Program ==========

program
  .name('om-lite')
  .description('Structured, decay-aware external memory for OpenClaw agents')
  .version('0.1.0')
  .option('--db <path>', 'Database path', '~/.openclaw/memory/om-lite.db')
  .option('--json', 'Output as JSON')
  .option('--verbose', 'Verbose output');

// ========== Init Command ==========

program
  .command('init')
  .description('Initialize OM-Lite in current directory')
  .action(async () => {
    const spinner = ora('Initializing OM-Lite...').start();
    try {
      const om = await getOMLite(program.opts());
      await om.close();
      spinner.succeed('OM-Lite initialized successfully');
      console.log(chalk.dim(`Database: ${program.opts().db}`));
    } catch (error) {
      spinner.fail('Failed to initialize');
      console.error(chalk.red(error));
      process.exit(1);
    }
  });

// ========== Memory Commands ==========

const memory = program
  .command('memory')
  .description('Memory operations');

memory
  .command('list')
  .description('List all active clauses')
  .option('-t, --type <type>', 'Filter by type')
  .option('-l, --limit <n>', 'Limit results', '20')
  .option('--include-expired', 'Include expired clauses')
  .action(async (options) => {
    const om = await getOMLite(program.opts());
    try {
      const clauses = await om.searchClauses('', {
        types: options.type ? [options.type] : undefined,
        limit: parseInt(options.limit),
        includeExpired: options.includeExpired,
      });
      
      if (program.opts().json) {
        console.log(JSON.stringify(clauses, null, 2));
      } else {
        if (clauses.length === 0) {
          console.log(chalk.dim('No clauses found'));
        } else {
          for (const clause of clauses) {
            const status = clause.valid_to ? chalk.red('✗') : chalk.green('✓');
            console.log(`${status} ${chalk.bold(clause.natural_form)}`);
            console.log(`  ${chalk.dim(`[${clause.type}]`)} ${formatConfidence(clause.confidence)} · ${clause.id.slice(0, 8)}`);
          }
          console.log(chalk.dim(`\nShowing ${clauses.length} clause(s)`));
        }
      }
    } finally {
      await om.close();
    }
  });

memory
  .command('search <query>')
  .description('Search memory with query')
  .option('-t, --type <type>', 'Filter by type')
  .option('-l, --limit <n>', 'Limit results', '10')
  .action(async (query, options) => {
    const om = await getOMLite(program.opts());
    try {
      const result = await om.retrieve(query, {
        types: options.type ? [options.type] : undefined,
        limit: parseInt(options.limit),
      });
      
      if (program.opts().json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(chalk.bold(`Found ${result.totalMatches} match(es)\n`));
        for (const clause of result.clauses) {
          console.log(`${chalk.green('●')} ${clause.natural_form}`);
          console.log(`  ${chalk.dim(`[${clause.type}]`)} ${formatConfidence(clause.confidence)} · score: ${clause.score.toFixed(2)}`);
        }
      }
    } finally {
      await om.close();
    }
  });

memory
  .command('show <id>')
  .description('Show clause details')
  .action(async (id) => {
    const om = await getOMLite(program.opts());
    try {
      const clause = await om.getClause(id);
      if (!clause) {
        console.log(chalk.red('Clause not found'));
        process.exit(1);
      }
      
      if (program.opts().json) {
        console.log(JSON.stringify(clause, null, 2));
      } else {
        console.log(chalk.bold(clause.natural_form));
        console.log();
        console.log(`${chalk.dim('ID:')}          ${clause.id}`);
        console.log(`${chalk.dim('Type:')}        ${clause.type}`);
        console.log(`${chalk.dim('Subject:')}     ${clause.subject}`);
        console.log(`${chalk.dim('Predicate:')}   ${clause.predicate}`);
        console.log(`${chalk.dim('Object:')}      ${clause.object}`);
        console.log(`${chalk.dim('Confidence:')}  ${formatConfidence(clause.confidence)}`);
        console.log(`${chalk.dim('Valid From:')}  ${clause.valid_from}`);
        console.log(`${chalk.dim('Valid To:')}    ${clause.valid_to ?? 'current'}`);
        console.log(`${chalk.dim('Source:')}      ${clause.source_id}`);
        console.log(`${chalk.dim('Accesses:')}    ${clause.access_count}`);
        console.log(`${chalk.dim('Last Access:')} ${clause.last_accessed}`);
      }
    } finally {
      await om.close();
    }
  });

memory
  .command('export')
  .description('Export memory')
  .option('-f, --format <format>', 'Format (json, markdown, full)', 'markdown')
  .option('-o, --output <path>', 'Output file path (default: stdout)')
  .option('--include-expired', 'Include expired clauses')
  .action(async (options) => {
    const om = await getOMLite(program.opts());
    try {
      let content: string;

      if (options.format === 'markdown') {
        content = await om.generateMemoryMd();
      } else if (options.format === 'full') {
        content = await om['clauseStore'].generateFullExport();
      } else {
        content = await om['clauseStore'].exportAsJson({
          includeExpired: options.includeExpired,
        });
      }

      if (options.output) {
        const { writeFileSync, mkdirSync, existsSync } = await import('fs');
        const { dirname, join } = await import('path');
        const { homedir } = await import('os');

        // Expand ~ to home directory
        let outputPath = options.output;
        if (outputPath.startsWith('~')) {
          outputPath = outputPath.replace('~', homedir());
        }

        // Create exports directory if saving to default location
        if (!outputPath.includes('/') && !outputPath.includes('\\')) {
          const exportsDir = join(homedir(), '.openclaw', 'memory', 'exports');
          if (!existsSync(exportsDir)) {
            mkdirSync(exportsDir, { recursive: true });
          }
          outputPath = join(exportsDir, outputPath);
        }

        // Ensure parent directory exists
        const parentDir = dirname(outputPath);
        if (!existsSync(parentDir)) {
          mkdirSync(parentDir, { recursive: true });
        }

        writeFileSync(outputPath, content, 'utf-8');
        console.log(chalk.green(`Exported to: ${outputPath}`));
      } else {
        console.log(content);
      }
    } finally {
      await om.close();
    }
  });

// ========== Stats Command ==========

program
  .command('stats')
  .description('Show memory statistics')
  .action(async () => {
    const om = await getOMLite(program.opts());
    try {
      const stats = await om.getStats();
      
      if (program.opts().json) {
        console.log(JSON.stringify(stats, null, 2));
      } else {
        console.log(chalk.bold('OM-Lite Statistics\n'));
        console.log(`${chalk.dim('Total Clauses:')}    ${stats.totalClauses}`);
        console.log(`${chalk.dim('Active:')}           ${chalk.green(stats.activeClauses)}`);
        console.log(`${chalk.dim('Expired:')}          ${chalk.red(stats.expiredClauses)}`);
        console.log(`${chalk.dim('Avg Confidence:')}   ${formatConfidence(stats.avgConfidence)}`);
        console.log(`${chalk.dim('Total Sources:')}    ${stats.totalSources}`);
        console.log(`${chalk.dim('Pending Conflicts:')} ${stats.pendingConflicts}`);
        console.log(`${chalk.dim('Installed Packs:')}  ${stats.installedPacks}`);
        console.log(`${chalk.dim('Database Size:')}    ${(stats.dbSizeBytes / 1024).toFixed(1)} KB`);
        console.log();
        console.log(chalk.dim('By Type:'));
        for (const [type, count] of Object.entries(stats.clausesByType)) {
          if (count > 0) {
            console.log(`  ${type}: ${count}`);
          }
        }
      }
    } finally {
      await om.close();
    }
  });

// ========== Packs Commands ==========

const packs = program
  .command('packs')
  .description('Knowledge pack operations');

packs
  .command('list')
  .description('List installed packs')
  .action(async () => {
    const om = await getOMLite(program.opts());
    try {
      const installed = await om.packs.list();
      
      if (program.opts().json) {
        console.log(JSON.stringify(installed, null, 2));
      } else {
        if (installed.length === 0) {
          console.log(chalk.dim('No packs installed'));
          console.log(chalk.dim('Run: om-lite packs install travel-core'));
        } else {
          console.log(chalk.bold('Installed Packs\n'));
          for (const pack of installed) {
            console.log(`${chalk.green('●')} ${chalk.bold(pack.pack_id)} v${pack.version}`);
            console.log(`  ${pack.claims_loaded} claims · installed ${pack.installed_at}`);
          }
        }
      }
    } finally {
      await om.close();
    }
  });

packs
  .command('install <pack>')
  .description('Install a knowledge pack')
  .option('--regions <regions>', 'Filter by regions (comma-separated)')
  .option('--dry-run', 'Preview without installing')
  .option('--remote', 'Download from remote registry')
  .action(async (pack, options) => {
    const om = await getOMLite(program.opts());
    try {
      // Handle dry-run
      if (options.dryRun) {
        const spinner = ora(`Analyzing ${pack}...`).start();

        // Get pack metadata to preview
        const validation = await om.packs.validate(pack);

        spinner.info(`Dry run for ${pack}`);
        if (validation.valid) {
          console.log(chalk.green('  Pack is valid'));
        } else {
          console.log(chalk.red('  Pack has errors:'));
          for (const err of validation.errors) {
            console.log(`    - ${err}`);
          }
        }
        if (validation.warnings.length > 0) {
          console.log(chalk.yellow('  Warnings:'));
          for (const warn of validation.warnings) {
            console.log(`    - ${warn}`);
          }
        }
        console.log(chalk.dim('\n  Use without --dry-run to install'));
        return;
      }

      const spinner = ora(`Installing ${pack}...`).start();
      const report = await om.packs.install(pack, {
        regions: options.regions?.split(','),
      });

      spinner.succeed(`Installed ${pack} v${report.version}`);
      console.log(`  ${chalk.green(report.loaded)} claims loaded`);
      if (report.skipped > 0) {
        console.log(`  ${chalk.yellow(report.skipped)} skipped`);
      }
      if (report.conflicts > 0) {
        console.log(`  ${chalk.red(report.conflicts)} conflicts detected`);
      }
    } catch (error) {
      console.error(chalk.red(`Failed to install ${pack}:`), error);
      process.exit(1);
    } finally {
      await om.close();
    }
  });

packs
  .command('remove <pack>')
  .description('Remove a knowledge pack')
  .action(async (pack) => {
    const spinner = ora(`Removing ${pack}...`).start();
    const om = await getOMLite(program.opts());
    try {
      await om.packs.remove(pack);
      spinner.succeed(`Removed ${pack}`);
    } catch (error) {
      spinner.fail(`Failed to remove ${pack}`);
      console.error(chalk.red(error));
      process.exit(1);
    } finally {
      await om.close();
    }
  });

// ========== Decay Command ==========

program
  .command('decay')
  .description('Run confidence decay')
  .option('--dry-run', 'Preview changes without applying')
  .action(async (options) => {
    const spinner = ora('Running decay...').start();
    const om = await getOMLite(program.opts());
    try {
      const report = await om.runDecay(options.dryRun);
      
      if (options.dryRun) {
        spinner.info('Dry run complete');
      } else {
        spinner.succeed('Decay complete');
      }
      
      console.log(`  Processed: ${report.processed}`);
      console.log(`  Decayed: ${chalk.yellow(report.decayed)}`);
      console.log(`  Archived: ${chalk.red(report.archived)}`);
    } finally {
      await om.close();
    }
  });

// ========== Sync Command ==========

program
  .command('sync')
  .description('Regenerate MEMORY.md')
  .option('-o, --output <path>', 'Output path', '~/.openclaw/MEMORY.md')
  .action(async (options) => {
    const spinner = ora('Generating MEMORY.md...').start();
    const om = await getOMLite(program.opts());
    try {
      const md = await om.generateMemoryMd();
      const outPath = options.output.replace(/^~/, homedir());
      
      const { writeFileSync } = await import('fs');
      writeFileSync(outPath, md);
      
      spinner.succeed(`Generated ${outPath}`);
    } finally {
      await om.close();
    }
  });

// ========== Backup Command ==========

const backup = program
  .command('backup')
  .description('Backup and restore operations');

backup
  .command('create')
  .description('Create database backup')
  .option('-o, --output <path>', 'Output path')
  .option('-t, --type <type>', 'Backup type: daily, weekly, manual', 'manual')
  .action(async (options) => {
    const spinner = ora('Creating backup...').start();
    const om = await getOMLite(program.opts());
    try {
      const backupManager = new BackupManager(om['db'], {
        backupDir: '~/.om-lite/backups',
      });
      await backupManager.init();

      const result = await backupManager.backup({
        type: options.type,
        customPath: options.output,
      });

      if (result.success) {
        spinner.succeed(`Backup created: ${result.path}`);
        console.log(`  Size: ${((result.sizeBytes ?? 0) / 1024).toFixed(1)} KB`);
      } else {
        spinner.fail(`Backup failed: ${result.error}`);
        process.exit(1);
      }
    } finally {
      await om.close();
    }
  });

backup
  .command('restore <path>')
  .description('Restore from backup')
  .action(async (backupPath) => {
    const spinner = ora('Restoring from backup...').start();
    const om = await getOMLite(program.opts());
    try {
      const backupManager = new BackupManager(om['db'], {
        backupDir: '~/.om-lite/backups',
      });

      // Validate backup first
      const validation = await backupManager.validateBackup(backupPath);
      if (!validation.valid) {
        spinner.fail(`Invalid backup: ${validation.error}`);
        process.exit(1);
      }

      const result = await backupManager.restore(backupPath);

      if (result.success) {
        spinner.succeed('Restore completed');
        console.log(`  Clauses restored: ${result.clausesRestored}`);
      } else {
        spinner.fail(`Restore failed: ${result.error}`);
        process.exit(1);
      }
    } finally {
      await om.close();
    }
  });

backup
  .command('list')
  .description('List available backups')
  .action(async () => {
    const om = await getOMLite(program.opts());
    try {
      const backupManager = new BackupManager(om['db'], {
        backupDir: '~/.om-lite/backups',
      });
      await backupManager.init();

      const backups = await backupManager.listBackups();

      if (program.opts().json) {
        console.log(JSON.stringify(backups, null, 2));
      } else {
        if (backups.length === 0) {
          console.log(chalk.dim('No backups found'));
          console.log(chalk.dim('Run: om-lite backup create'));
        } else {
          console.log(chalk.bold('Available Backups\n'));
          for (const b of backups) {
            const typeColor = b.type === 'manual' ? chalk.blue : b.type === 'weekly' ? chalk.magenta : chalk.cyan;
            console.log(`${typeColor(`[${b.type}]`)} ${b.filename}`);
            console.log(`  ${chalk.dim('Date:')} ${b.timestamp.toISOString()}`);
            console.log(`  ${chalk.dim('Size:')} ${(b.sizeBytes / 1024).toFixed(1)} KB`);
          }
        }
      }
    } finally {
      await om.close();
    }
  });

backup
  .command('validate <path>')
  .description('Validate a backup file')
  .action(async (backupPath) => {
    const spinner = ora('Validating backup...').start();
    const om = await getOMLite(program.opts());
    try {
      const backupManager = new BackupManager(om['db']);
      const result = await backupManager.validateBackup(backupPath);

      if (result.valid) {
        spinner.succeed('Backup is valid');
        console.log(`  Clauses: ${result.clauseCount}`);
        console.log(`  Schema version: ${result.schemaVersion}`);
      } else {
        spinner.fail(`Invalid backup: ${result.error}`);
        process.exit(1);
      }
    } finally {
      await om.close();
    }
  });

// ========== Conflicts Commands ==========

const conflicts = program
  .command('conflicts')
  .description('Conflict resolution operations');

conflicts
  .command('list')
  .description('List pending conflicts')
  .action(async () => {
    const om = await getOMLite(program.opts());
    try {
      const pending = await om.conflicts.list();

      if (program.opts().json) {
        console.log(JSON.stringify(pending, null, 2));
      } else {
        if (pending.length === 0) {
          console.log(chalk.green('No pending conflicts'));
        } else {
          console.log(chalk.bold(`Pending Conflicts (${pending.length})\n`));
          for (const conflict of pending) {
            console.log(`${chalk.yellow('⚠')} ${conflict.description}`);
            console.log(`  ${chalk.dim('ID:')} ${conflict.id.slice(0, 8)}`);
            console.log(`  ${chalk.dim('Type:')} ${conflict.conflict_type}`);
            console.log(`  ${chalk.dim('Detected:')} ${conflict.detected_at}`);
            console.log();
          }
        }
      }
    } finally {
      await om.close();
    }
  });

conflicts
  .command('resolve [id]')
  .description('Resolve conflict(s)')
  .option('-s, --strategy <strategy>', 'Strategy: newest_wins, highest_confidence, merge_history, manual', 'merge_history')
  .option('--all', 'Resolve all pending conflicts')
  .action(async (id, options) => {
    const om = await getOMLite(program.opts());
    try {
      if (options.all) {
        const spinner = ora('Resolving all conflicts...').start();
        const result = await om.conflicts.resolveAll(options.strategy);
        spinner.succeed(`Resolved ${result.resolved} conflicts`);
        if (result.skipped > 0) {
          console.log(chalk.yellow(`  Skipped: ${result.skipped}`));
        }
        if (result.errors > 0) {
          console.log(chalk.red(`  Errors: ${result.errors}`));
        }
      } else if (id) {
        const result = await om.conflicts.resolve(id, options.strategy);
        if (result.resolved) {
          console.log(chalk.green(`Resolved: ${result.action}`));
          if (result.keptClauseId) {
            console.log(chalk.dim(`Kept clause: ${result.keptClauseId}`));
          }
        } else {
          console.log(chalk.yellow(`Not resolved: ${result.action}`));
        }
      } else {
        console.log(chalk.red('Provide conflict ID or use --all'));
      }
    } finally {
      await om.close();
    }
  });

conflicts
  .command('config')
  .description('Show/set conflict resolution config')
  .option('-s, --strategy <strategy>', 'Set strategy: newest_wins, highest_confidence, merge_history, manual')
  .action(async (options) => {
    const om = await getOMLite(program.opts());
    try {
      if (options.strategy) {
        om.conflicts.setStrategy({ strategy: options.strategy });
        console.log(chalk.green(`Strategy set to: ${options.strategy}`));
      } else {
        console.log(chalk.bold('Conflict Resolution Config'));
        console.log(`  Strategy: ${om.config.conflictResolution.strategy}`);
        console.log(`  Auto-resolve threshold: ${om.config.conflictResolution.autoResolveThreshold}`);
        console.log(`  Preserve history: ${om.config.conflictResolution.preserveHistory}`);
      }
    } finally {
      await om.close();
    }
  });

// ========== Retention Commands ==========

program
  .command('retention')
  .description('Enforce source retention policy')
  .option('--days <days>', 'Retention period in days', '90')
  .option('--dry-run', 'Preview without deleting')
  .action(async (options) => {
    const om = await getOMLite(program.opts());
    try {
      const days = parseInt(options.days, 10);

      if (options.dryRun) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);

        const oldSources = om['db'].all<{ id: string; file_path: string; occurred_at: string }>(
          `SELECT id, file_path, occurred_at FROM sources
           WHERE occurred_at < ?
             AND file_path IS NOT NULL
             AND file_path != ''
             AND file_path != '[archived]'`,
          [cutoff.toISOString()]
        );

        console.log(chalk.bold(`Retention Preview (${days} days)\n`));
        console.log(`Sources to archive: ${oldSources.length}`);

        if (oldSources.length > 0) {
          console.log(chalk.dim('\nOldest sources:'));
          for (const source of oldSources.slice(0, 5)) {
            console.log(`  ${source.id} - ${source.occurred_at}`);
          }
          if (oldSources.length > 5) {
            console.log(chalk.dim(`  ... and ${oldSources.length - 5} more`));
          }
        }
        console.log(chalk.dim('\nUse without --dry-run to delete'));
      } else {
        const spinner = ora('Enforcing retention policy...').start();
        const result = await om['clauseStore'].enforceRetention(days);
        spinner.succeed('Retention complete');
        console.log(`  Archived: ${chalk.green(result.deleted)}`);
        if (result.errors > 0) {
          console.log(`  Errors: ${chalk.red(result.errors)}`);
        }
      }
    } finally {
      await om.close();
    }
  });

// ========== Scheduler Commands ==========

const scheduler = program
  .command('scheduler')
  .description('Scheduled job management');

scheduler
  .command('status')
  .description('Show scheduler status')
  .action(async () => {
    console.log(chalk.bold('Scheduler Configuration\n'));
    console.log('To enable automatic scheduling, add to your config:\n');
    console.log(chalk.dim('memory:'));
    console.log(chalk.dim('  scheduler:'));
    console.log(chalk.dim('    decay_enabled: true'));
    console.log(chalk.dim('    decay_hour: 3  # 3 AM'));
    console.log(chalk.dim('    backup_enabled: true'));
    console.log(chalk.dim('    retention_enabled: true'));
    console.log(chalk.dim('    retention_days: 90'));
    console.log();
    console.log('Or run jobs manually:');
    console.log(`  ${chalk.cyan('om-lite decay run')} - Run decay job`);
    console.log(`  ${chalk.cyan('om-lite backup create')} - Create backup`);
    console.log(`  ${chalk.cyan('om-lite retention')} - Enforce retention`);
  });

scheduler
  .command('cron')
  .description('Generate cron schedule for external schedulers')
  .action(async () => {
    console.log(chalk.bold('Cron Schedule for OM-Lite Jobs\n'));
    console.log('Add these to your crontab (crontab -e):\n');
    console.log('# Decay job - runs daily at 3 AM');
    console.log(chalk.cyan('0 3 * * * om-lite decay run'));
    console.log();
    console.log('# Backup job - runs daily at 5 AM');
    console.log(chalk.cyan('0 5 * * * om-lite backup create'));
    console.log();
    console.log('# Retention job - runs weekly on Sunday at 4 AM');
    console.log(chalk.cyan('0 4 * * 0 om-lite retention --days 90'));
  });

// ========== Skills Commands ==========

const skills = program
  .command('skills')
  .description('Skill integration operations');

skills
  .command('list')
  .description('List skills with memory bindings')
  .action(async () => {
    const om = await getOMLite(program.opts());
    try {
      // Get skills with bindings from skill_preference_bindings table
      const bindingsRows = om['db'].all<{
        skill_id: string;
        parameter_name: string;
        clause_id: string;
      }>('SELECT DISTINCT skill_id, parameter_name, clause_id FROM skill_preference_bindings');

      // Get skills from skill_capabilities
      const capsRows = om['db'].all<{
        skill_id: string;
        skill_version: string;
        clause_id: string;
      }>('SELECT DISTINCT skill_id, skill_version, clause_id FROM skill_capabilities');

      // Combine and group by skill_id
      const skillMap = new Map<string, {
        version?: string;
        bindings: string[];
        capabilities: number;
      }>();

      for (const cap of capsRows) {
        if (!skillMap.has(cap.skill_id)) {
          skillMap.set(cap.skill_id, { version: cap.skill_version, bindings: [], capabilities: 0 });
        }
        skillMap.get(cap.skill_id)!.capabilities++;
      }

      for (const binding of bindingsRows) {
        if (!skillMap.has(binding.skill_id)) {
          skillMap.set(binding.skill_id, { bindings: [], capabilities: 0 });
        }
        skillMap.get(binding.skill_id)!.bindings.push(binding.parameter_name);
      }

      if (program.opts().json) {
        const result = Array.from(skillMap.entries()).map(([id, data]) => ({
          skill_id: id,
          ...data,
        }));
        console.log(JSON.stringify(result, null, 2));
      } else {
        if (skillMap.size === 0) {
          console.log(chalk.dim('No skills registered'));
          console.log(chalk.dim('Skills are registered when agents install them'));
        } else {
          console.log(chalk.bold('Registered Skills\n'));
          for (const [skillId, data] of skillMap) {
            console.log(`${chalk.green('●')} ${chalk.bold(skillId)}${data.version ? ` v${data.version}` : ''}`);
            console.log(`  ${chalk.dim('Capabilities:')} ${data.capabilities}`);
            if (data.bindings.length > 0) {
              console.log(`  ${chalk.dim('Bindings:')} ${data.bindings.join(', ')}`);
            }
          }
        }
      }
    } finally {
      await om.close();
    }
  });

skills
  .command('performance')
  .description('Show skill performance stats')
  .option('-s, --skill <id>', 'Filter by skill')
  .action(async (options) => {
    const om = await getOMLite(program.opts());
    try {
      const perf = await om.skills.getPerformance(options.skill);
      
      if (program.opts().json) {
        console.log(JSON.stringify(perf, null, 2));
      } else {
        if (perf.length === 0) {
          console.log(chalk.dim('No performance data yet'));
        } else {
          console.log(chalk.bold('Skill Performance\n'));
          for (const p of perf) {
            const successRate = p.success_count / (p.success_count + p.failure_count);
            console.log(`${chalk.bold(p.skill_id)} (${p.task_category})`);
            console.log(`  Success: ${formatConfidence(successRate)} (${p.success_count}/${p.success_count + p.failure_count})`);
            console.log(`  Avg time: ${p.avg_execution_time_ms}ms`);
          }
        }
      }
    } finally {
      await om.close();
    }
  });

// ========== Migrate Command ==========

const migrate = program
  .command('migrate')
  .description('Import memory from other formats');

migrate
  .command('memory-md <path>')
  .description('Migrate from MEMORY.md file')
  .option('--confidence <multiplier>', 'Confidence multiplier for imported items', '0.8')
  .option('--dry-run', 'Preview without importing')
  .action(async (filePath, options) => {
    const spinner = ora('Parsing MEMORY.md...').start();

    if (!existsSync(filePath)) {
      spinner.fail(`File not found: ${filePath}`);
      process.exit(1);
    }

    const result = migrateFromMemoryMd(filePath, {
      confidenceMultiplier: parseFloat(options.confidence),
      dryRun: options.dryRun,
    });

    if (result.errors.length > 0) {
      spinner.fail('Migration errors');
      for (const err of result.errors) {
        console.log(chalk.red(`  ${err}`));
      }
      process.exit(1);
    }

    spinner.info(`Parsed ${result.totalParsed} items from ${filePath}`);

    if (options.dryRun) {
      console.log(chalk.dim('\nDry run - preview of clauses to import:\n'));
      for (const clause of result.clauses.slice(0, 10)) {
        console.log(`  [${clause.type}] ${clause.natural_form}`);
      }
      if (result.clauses.length > 10) {
        console.log(chalk.dim(`  ... and ${result.clauses.length - 10} more`));
      }
      console.log(chalk.dim('\nUse without --dry-run to import'));
      return;
    }

    // Actually import the clauses
    const om = await getOMLite(program.opts());
    try {
      const importSpinner = ora('Importing clauses...').start();

      let imported = 0;
      let conflicts = 0;

      // Create source for migration
      const sourceId = await om['clauseStore'].createSource({
        type: 'document',
        content: `Migrated from ${filePath}`,
        channel: 'migration:memory_md',
        metadata: {
          source_file: filePath,
          migrated_at: new Date().toISOString(),
        },
      });

      for (const clause of result.clauses) {
        try {
          const processResult = await om['clauseStore'].processNewClause({
            ...clause,
            source_id: sourceId,
          });

          if (processResult.action === 'insert' || processResult.action === 'superseded') {
            imported++;
          }
          if (processResult.conflict) {
            conflicts++;
          }
        } catch (error) {
          console.warn(chalk.yellow(`  Warning: ${error}`));
        }
      }

      importSpinner.succeed('Migration complete');
      console.log(`  ${chalk.green(imported)} clauses imported`);
      console.log(`  ${chalk.yellow(result.skipped)} skipped`);
      if (conflicts > 0) {
        console.log(`  ${chalk.red(conflicts)} conflicts detected`);
      }
    } finally {
      await om.close();
    }
  });

migrate
  .command('json <path>')
  .description('Migrate from JSON export file')
  .option('--confidence <multiplier>', 'Confidence multiplier for imported items', '0.8')
  .option('--dry-run', 'Preview without importing')
  .action(async (filePath, options) => {
    const spinner = ora('Parsing JSON file...').start();

    if (!existsSync(filePath)) {
      spinner.fail(`File not found: ${filePath}`);
      process.exit(1);
    }

    const result = migrateFromFile(filePath, {
      confidenceMultiplier: parseFloat(options.confidence),
      dryRun: options.dryRun,
    });

    if (result.errors.length > 0) {
      spinner.fail('Migration errors');
      for (const err of result.errors) {
        console.log(chalk.red(`  ${err}`));
      }
      if (result.clauses.length === 0) {
        process.exit(1);
      }
    }

    spinner.info(`Parsed ${result.totalParsed} items`);

    if (options.dryRun) {
      console.log(chalk.dim('\nDry run - preview of clauses to import:\n'));
      for (const clause of result.clauses.slice(0, 10)) {
        console.log(`  [${clause.type}] ${clause.natural_form}`);
      }
      if (result.clauses.length > 10) {
        console.log(chalk.dim(`  ... and ${result.clauses.length - 10} more`));
      }
      console.log(chalk.dim('\nUse without --dry-run to import'));
      return;
    }

    // Import using same logic as memory-md
    const om = await getOMLite(program.opts());
    try {
      const importSpinner = ora('Importing clauses...').start();
      let imported = 0;

      const sourceId = await om['clauseStore'].createSource({
        type: 'document',
        content: `Migrated from ${filePath}`,
        channel: 'migration:json',
      });

      for (const clause of result.clauses) {
        try {
          const processResult = await om['clauseStore'].processNewClause({
            ...clause,
            source_id: sourceId,
          });
          if (processResult.action === 'insert' || processResult.action === 'superseded') {
            imported++;
          }
        } catch {
          // Skip errors
        }
      }

      importSpinner.succeed(`Imported ${imported} clauses`);
    } finally {
      await om.close();
    }
  });

migrate
  .command('detect <path>')
  .description('Detect format of a memory file')
  .action(async (filePath) => {
    if (!existsSync(filePath)) {
      console.log(chalk.red(`File not found: ${filePath}`));
      process.exit(1);
    }

    const format = detectFormat(filePath);
    console.log(`Detected format: ${chalk.bold(format)}`);
  });

// ========== Source Commands ==========

const source = program
  .command('source')
  .description('Inspect memory sources');

source
  .command('list')
  .description('List all sources')
  .option('-t, --type <type>', 'Filter by type')
  .option('-l, --limit <n>', 'Limit results', '20')
  .action(async (options) => {
    const om = await getOMLite(program.opts());
    try {
      let sql = 'SELECT * FROM sources';
      const params: unknown[] = [];

      if (options.type) {
        sql += ' WHERE type = ?';
        params.push(options.type);
      }

      sql += ' ORDER BY occurred_at DESC LIMIT ?';
      params.push(parseInt(options.limit));

      const sources = om['db'].all<{
        id: string;
        type: string;
        channel: string | null;
        file_path: string;
        occurred_at: string;
        message_count: number;
      }>(sql, params);

      if (program.opts().json) {
        console.log(JSON.stringify(sources, null, 2));
      } else {
        if (sources.length === 0) {
          console.log(chalk.dim('No sources found'));
        } else {
          console.log(chalk.bold('Memory Sources\n'));
          for (const src of sources) {
            console.log(`${chalk.cyan(`[${src.type}]`)} ${src.id.slice(0, 8)}`);
            if (src.channel) {
              console.log(`  ${chalk.dim('Channel:')} ${src.channel}`);
            }
            console.log(`  ${chalk.dim('Date:')} ${src.occurred_at}`);
            if (src.message_count > 0) {
              console.log(`  ${chalk.dim('Messages:')} ${src.message_count}`);
            }
          }
        }
      }
    } finally {
      await om.close();
    }
  });

source
  .command('show <id>')
  .description('Show source details')
  .action(async (id) => {
    const om = await getOMLite(program.opts());
    try {
      // Find source by full ID or partial match
      const src = om['db'].get<{
        id: string;
        type: string;
        channel: string | null;
        file_path: string;
        content_hash: string;
        occurred_at: string;
        recorded_at: string;
        participant_count: number;
        message_count: number;
        metadata: string;
      }>(
        'SELECT * FROM sources WHERE id = ? OR id LIKE ?',
        [id, `${id}%`]
      );

      if (!src) {
        console.log(chalk.red('Source not found'));
        process.exit(1);
      }

      // Get clauses from this source
      const clauseCount = om['db'].get<{ count: number }>(
        'SELECT COUNT(*) as count FROM clauses WHERE source_id = ?',
        [src.id]
      );

      if (program.opts().json) {
        console.log(JSON.stringify({ ...src, clauseCount: clauseCount?.count }, null, 2));
      } else {
        console.log(chalk.bold(`Source: ${src.id}\n`));
        console.log(`${chalk.dim('Type:')}         ${src.type}`);
        console.log(`${chalk.dim('Channel:')}      ${src.channel ?? 'none'}`);
        console.log(`${chalk.dim('File:')}         ${src.file_path}`);
        console.log(`${chalk.dim('Hash:')}         ${src.content_hash.slice(0, 16)}...`);
        console.log(`${chalk.dim('Occurred:')}     ${src.occurred_at}`);
        console.log(`${chalk.dim('Recorded:')}     ${src.recorded_at}`);
        console.log(`${chalk.dim('Participants:')} ${src.participant_count}`);
        console.log(`${chalk.dim('Messages:')}     ${src.message_count}`);
        console.log(`${chalk.dim('Clauses:')}      ${clauseCount?.count ?? 0}`);

        const metadata = JSON.parse(src.metadata || '{}');
        if (Object.keys(metadata).length > 0) {
          console.log(`${chalk.dim('Metadata:')}     ${JSON.stringify(metadata, null, 2)}`);
        }
      }
    } finally {
      await om.close();
    }
  });

source
  .command('clauses <id>')
  .description('List clauses from a source')
  .action(async (id) => {
    const om = await getOMLite(program.opts());
    try {
      const clauses = om['db'].all<{
        id: string;
        type: string;
        natural_form: string;
        confidence: number;
      }>(
        `SELECT id, type, natural_form, confidence FROM clauses
         WHERE source_id = ? OR source_id LIKE ?
         ORDER BY recorded_at DESC`,
        [id, `${id}%`]
      );

      if (program.opts().json) {
        console.log(JSON.stringify(clauses, null, 2));
      } else {
        if (clauses.length === 0) {
          console.log(chalk.dim('No clauses from this source'));
        } else {
          console.log(chalk.bold(`Clauses from source ${id.slice(0, 8)}\n`));
          for (const clause of clauses) {
            console.log(`${chalk.dim(`[${clause.type}]`)} ${clause.natural_form}`);
            console.log(`  ${formatConfidence(clause.confidence)} · ${clause.id.slice(0, 8)}`);
          }
        }
      }
    } finally {
      await om.close();
    }
  });

// ========== Run ==========

program.parse();
