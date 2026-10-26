// Runs fn over every item with at most `limit` calls in flight at once, and
// returns the results in the same order as the items. Used to read a
// script's pages a few at a time instead of one by one, without firing all
// of them together and tripping the OCR service's rate limits.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
