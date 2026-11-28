// TRIAL (stage 23, off unless MARK_BY_SECTION=1): cuts a script's text
// into one section per whole question, using the question labels the
// student wrote ("Q3", "Question 3", "3a)", "3(b)", "No. 3"), so a marking
// request can carry only the sections for its own questions instead of the
// whole script.
//
// Only clear labels count. A plain "3." or "3)" is NOT taken as a label,
// because answers are full of numbered lists (the twelve steps in ECE 542
// 5a would look like questions 1 to 12). A label must name a question that
// is in the guide. A section runs from its label to the next label, so a
// part continued on a later page stays with it.
//
// When the script is not clearly labelled (fewer than two questions found),
// splitScript returns null and marking sends the whole script as before.

const LABEL = new RegExp(
  [
    // Q3, Q.3, Q 3b, Question 3, QUESTION 3(a), No. 3, Ans 3
    String.raw`^[\s*#>(\[]*(?:q(?:uestion|tn|s)?|no|ans(?:wer)?)\s*[.:\-]?\s*(\d{1,2})(?![0-9])`,
    // 3a, 3a), 3(a), 3 (b), 3b. , 3(ii), 3ii)  at the start of a line
    String.raw`^[\s*#>(\[]*(\d{1,2})\s*\(?\s*(?:[a-h]|i{1,3}|iv|vi{0,3}|ix|x)\s*[).:\]](?=\s|$)`,
    String.raw`^[\s*#>(\[]*(\d{1,2})(?:[a-h])(?=[\s).:]|$)`,
  ].join('|'),
  'i'
)

function labelNumber(line) {
  const m = LABEL.exec(line)
  if (!m) return null
  return String(Number(m[1] || m[2] || m[3]))
}

// Returns { sections: Map(questionNumber -> text), unlabelled: text } or
// null when the script is not clearly labelled.
export function splitScript(text, questions) {
  const numbers = new Set((questions || []).map((q) => String(Number(q.number))))
  const lines = String(text || '').split('\n')
  const sections = new Map()
  const unlabelled = []
  let current = null
  for (const line of lines) {
    const n = labelNumber(line)
    if (n && numbers.has(n)) current = n
    if (current === null) {
      unlabelled.push(line)
      continue
    }
    if (!sections.has(current)) sections.set(current, [])
    sections.get(current).push(line)
  }
  if (sections.size < 2) return null
  const join = (ls) => ls.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return {
    sections: new Map([...sections].map(([k, v]) => [k, join(v)])),
    unlabelled: join(unlabelled),
  }
}

// The text to send with these questions: their own sections, in guide
// order. A question with no section of its own may still be answered under
// a label OCR missed, so then the unlabelled text (front page and anything
// before the first label) goes too, and the model is told no labelled
// answer was found for it, so a missing answer still scores 0 "Not
// answered" exactly as before.
export function sectionTextFor(split, questions) {
  const wanted = [...new Set(questions.map((q) => String(Number(q.number))))]
  const parts = []
  const missing = []
  for (const n of wanted) {
    if (split.sections.has(n)) parts.push(`[Student's answer labelled Question ${n}]\n${split.sections.get(n)}`)
    else missing.push(n)
  }
  if (missing.length) {
    parts.push(
      `[No answer labelled Question ${missing.join(', ')} was found in the script. Text not under any question label:]\n${split.unlabelled || '(none)'}`
    )
  }
  return parts.join('\n\n')
}
