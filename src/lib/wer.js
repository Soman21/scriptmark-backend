// Word and character error rates of the text the AI marked against what
// the answer really says (a lecturer's transcription). WER is
// (substitutions + deletions + insertions) / words in the reference, the
// usual measure for handwriting recognition; CER is the same on characters.

export function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[.,;:!?"()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Levenshtein distance between two sequences, two rows at a time.
export function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}

export function errorRates(hypothesis, reference) {
  const ref = normalise(reference)
  const hyp = normalise(hypothesis)
  const refWords = ref ? ref.split(' ') : []
  const hypWords = hyp ? hyp.split(' ') : []
  return {
    words: refWords.length,
    wordErrors: editDistance(hypWords, refWords),
    chars: ref.length,
    charErrors: editDistance([...hyp], [...ref]),
  }
}

const rate = (errors, total) => (total ? Math.round((errors / total) * 1000) / 1000 : null)

// Pooled over all checked answers (total errors over total reference
// words), so long answers weigh more, as in corpus level WER.
export function summariseRates(items) {
  const sum = (k) => items.reduce((s, x) => s + x[k], 0)
  return { n: items.length, words: sum('words'), wer: rate(sum('wordErrors'), sum('words')), cer: rate(sum('charErrors'), sum('chars')) }
}
