// Background jobs. Each job is skipped while its previous run is still going.
export function startScheduler({ posts, inbox, metrics, media, config, log = console }) {
  const timers = [];
  function every(ms, name, fn) {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try { await fn(); } catch (err) { log.error(`[${name}] ${err.stack || err.message}`); } finally { running = false; }
    };
    timers.push(setInterval(tick, ms));
    setTimeout(tick, 2_000);
  }
  posts.recoverStuck();
  every(30_000, 'publish', () => posts.runDue());
  // Checked every minute; each run only touches accounts whose interval has passed.
  every(60_000, 'mentions', () => inbox.pollDue(config.mentionsPollMinutes * 60_000));
  every(60_000, 'metrics', () => metrics.refreshDue(config.metricsPollMinutes * 60_000));
  every(6 * 60 * 60_000, 'media-cleanup', () => media.cleanup());
  return () => timers.forEach(clearInterval);
}
