// src/index.ts
import { config } from './config.js';
import { createLogger } from './logger.js';
import { fetchAllArticles } from './feeds.js';
import { filterByRelevance } from './relevance.js';
import { enrichEntry } from './extractor.js';
import { summarizeEntry } from './summarizer.js';
import {
  loadArticleQueue,
  saveArticleQueue,
  getQueue,
  isKnown,
  discoverArticles,
  handleColdStart,
  getEntriesByState,
  transitionEntry,
  markFailed,
  removeEntry,
  countByState,
} from './queue.js';
import { sendNotification, sendArticleNotification } from './pushover.js';
import type { PollMetrics } from './types.js';

const log = createLogger('main');

function validateConfig(): void {
  if (!config.openrouterApiKey) {
    log.error('OPENROUTER_API_KEY is required. Set it in .env file.');
    process.exit(1);
  }
  if (!config.pushoverUserKey || !config.pushoverAppToken) {
    log.error('PUSHOVER_USER_KEY and PUSHOVER_APP_TOKEN are required. Set them in .env file.');
    process.exit(1);
  }
}

let pollCycleCount = 0;

function emitMetrics(metrics: PollMetrics): void {
  const parts = Object.entries(metrics)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  log.info(`[METRICS] poll_cycle=${pollCycleCount} ${parts}`);
}

async function pollAndNotify(): Promise<void> {
  pollCycleCount++;
  log.info('Starting poll cycle...');

  const metrics: PollMetrics = {
    discovered: 0,
    enriched: 0,
    enrichment_scraped: 0,
    enrichment_snippet: 0,
    relevance_passed: 0,
    relevance_dropped: 0,
    relevance_bypassed: 0,
    summarized: 0,
    summary_failed: 0,
    sent: 0,
    send_failed: 0,
    truncated: 0,
    queue_pending: 0,
    queue_failed: 0,
  };

  try {
    // Load queue
    loadArticleQueue();

    // 1. Fetch all articles from RSS
    const allArticles = await fetchAllArticles();

    // 2. Cold start check
    if (handleColdStart(allArticles)) {
      log.info('Cold start complete — no notifications this cycle');
      emitMetrics(metrics);
      return;
    }

    // 3. Discover new articles (add to queue)
    const newCount = discoverArticles(allArticles);
    metrics.discovered = newCount;
    saveArticleQueue();

    if (newCount === 0 && getEntriesByState('discovered').length === 0) {
      log.info('No new or pending articles');
      emitMetrics(metrics);
      return;
    }

    // 4. Relevance filter on discovered entries
    //    Collect IDs of entries that passed relevance (used to gate enrichment)
    const relevancePassedIds = new Set<string>();
    const discovered = getEntriesByState('discovered');

    if (discovered.length > 0) {
      const result = await filterByRelevance(discovered);

      metrics.relevance_bypassed = result.bypassed.length;
      metrics.relevance_passed = result.passed.length;
      metrics.relevance_dropped = result.dropped.length;

      // Remove dropped entries from queue
      for (const { entry } of result.dropped) {
        removeEntry(entry.id);
      }

      // Track which entries passed (only these proceed to enrichment)
      for (const entry of result.passed) relevancePassedIds.add(entry.id);
      for (const entry of result.bypassed) relevancePassedIds.add(entry.id);

      // If parse error, no entries are added to relevancePassedIds,
      // so they stay discovered and skip enrichment this cycle (retry next poll)
      if (result.parseError) {
        log.warn('Relevance parse error — skipping enrichment for affected entries this cycle');
      }

      saveArticleQueue();
    }

    // 5. Enrich only entries that passed relevance (limited per poll)
    const isArxiv = (name: string) => name.startsWith(config.arxivFeedPrefix);
    const eligibleForEnrich = getEntriesByState('discovered').filter(e => relevancePassedIds.has(e.id));
    const regularToEnrich = eligibleForEnrich.filter(e => !isArxiv(e.feedName));
    const arxivToEnrich = eligibleForEnrich.filter(e => isArxiv(e.feedName));

    const enrichBatch = [
      ...regularToEnrich.slice(0, config.maxArticlesPerPoll),
      ...arxivToEnrich.slice(0, config.arxivMaxPerPoll),
    ];

    for (const entry of enrichBatch) {
      try {
        const { enrichedContent, wasScraped } = await enrichEntry(entry);
        transitionEntry(entry.id, 'enriched', { enrichedContent });
        metrics.enriched++;
        if (wasScraped) metrics.enrichment_scraped++;
        else metrics.enrichment_snippet++;
      } catch (err) {
        markFailed(entry.id, `Enrichment error: ${err}`);
      }
    }
    saveArticleQueue();

    // 6. Summarize enriched entries
    const toSummarize = getEntriesByState('enriched');
    for (const entry of toSummarize) {
      const summary = await summarizeEntry(entry);
      if (summary) {
        transitionEntry(entry.id, 'summarized', { structuredSummary: summary });
        metrics.summarized++;
      } else {
        markFailed(entry.id, 'Summarization failed');
        metrics.summary_failed++;
      }
      // Rate limit between API calls
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    saveArticleQueue();

    // 7. Send summarized entries
    const toSend = getEntriesByState('summarized');
    for (const entry of toSend) {
      if (!entry.structuredSummary) {
        markFailed(entry.id, 'No structured summary available');
        metrics.send_failed++;
        continue;
      }

      const { success, truncated } = await sendArticleNotification(entry, entry.structuredSummary);
      if (success) {
        transitionEntry(entry.id, 'sent');
        metrics.sent++;
        if (truncated) metrics.truncated++;
      } else {
        markFailed(entry.id, 'Pushover send failed');
        metrics.send_failed++;
      }

      // Rate limit between notifications
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    saveArticleQueue();

    // 8. Emit metrics
    const counts = countByState();
    metrics.queue_pending = counts.discovered + counts.enriched + counts.summarized;
    metrics.queue_failed = counts.failed;

    emitMetrics(metrics);
    log.info(`Poll cycle complete: ${metrics.sent} sent, ${metrics.queue_pending} pending`);
  } catch (err) {
    log.error('Error in poll cycle', err);
    saveArticleQueue(); // Save any partial progress
  }
}

function scheduleNextPoll(): void {
  const intervalMs = config.pollIntervalMinutes * 60 * 1000;
  log.info(`Next poll in ${config.pollIntervalMinutes} minutes`);
  setTimeout(async () => {
    await pollAndNotify();
    scheduleNextPoll();
  }, intervalMs);
}

function setupShutdown(): void {
  const shutdown = (signal: string) => {
    log.info(`Received ${signal}, shutting down...`);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function main(): Promise<void> {
  log.info('RSSfeedy-Pi v2.0 starting...');
  validateConfig();
  setupShutdown();

  // Startup notification
  const startupSent = await sendNotification(
    '🚀 RSSfeedy-Pi',
    'RSSfeedy-Pi v2.0 başlatıldı! Yapılandırılmış AI haber bildirimleri aktif.',
  );

  if (startupSent) {
    log.info('Startup notification sent');
  } else {
    log.error('Failed to send startup notification — check Pushover credentials');
  }

  // Run first poll immediately
  await pollAndNotify();

  // Schedule recurring polls
  scheduleNextPoll();
}

main().catch((err) => {
  log.error('Fatal error', err);
  process.exit(1);
});
