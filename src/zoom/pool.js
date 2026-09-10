// Runs an async mapper over a list with a ceiling on how many are in flight at once.
//
// This exists because the live account has ~480 phone users across ~190 call queues: mapping
// them with a bare Promise.all opens hundreds of simultaneous Zoom requests on every poll
// tick, which trips Zoom's per-second rate limit long before it finishes. Keeping a fixed
// number in flight turns that burst into a steady stream.
async function mapPool(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await mapper(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  return results;
}

module.exports = { mapPool };
