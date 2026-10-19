import prisma from './prisma.js'
import { computeGrade } from './grading.js'

// Agreement between the AI's suggested scores and the lecturer's confirmed
// scores, for the thesis evaluation (Chapter 4). Ground truth is a score a
// human actually confirmed: answers auto accepted on high confidence are
// left out, since their confirmed score is the AI's own suggestion and
// would inflate every metric. The pure functions below take plain pairs so
// they can be tested without a database.

const EPS = 1e-9

function round(x, dp = 3) {
  if (x == null || !Number.isFinite(x)) return null
  const f = 10 ** dp
  return Math.round(x * f) / f
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
}

// Pearson correlation; null when either side has no variance (r is
// undefined there, not zero).
export function pearson(xs, ys) {
  if (xs.length < 2) return null
  const mx = mean(xs)
  const my = mean(ys)
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my)
    sxx += (xs[i] - mx) ** 2
    syy += (ys[i] - my) ** 2
  }
  if (sxx < EPS || syy < EPS) return null
  return sxy / Math.sqrt(sxx * syy)
}

// Cohen's kappa over ordinal score categories. Scores are put in half mark
// steps (a 2.5 is its own category) and every step between the lowest and
// highest observed score counts as a category, so the quadratic weights
// follow the real distance between marks. weights: 'none' | 'quadratic'.
export function cohensKappa(xs, ys, weights = 'none') {
  if (xs.length === 0) return null
  const a = xs.map((v) => Math.round(v * 2))
  const b = ys.map((v) => Math.round(v * 2))
  const lo = Math.min(...a, ...b)
  const hi = Math.max(...a, ...b)
  const k = hi - lo + 1
  if (k === 1) return null // everyone gave the same single score, so chance agreement is total
  const observed = Array.from({ length: k }, () => Array(k).fill(0))
  const histA = Array(k).fill(0)
  const histB = Array(k).fill(0)
  for (let i = 0; i < a.length; i++) {
    observed[a[i] - lo][b[i] - lo]++
    histA[a[i] - lo]++
    histB[b[i] - lo]++
  }
  const n = a.length
  let num = 0
  let den = 0
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      const w = weights === 'quadratic' ? ((i - j) / (k - 1)) ** 2 : i === j ? 0 : 1
      num += w * observed[i][j]
      den += (w * histA[i] * histB[j]) / n
    }
  }
  if (den < EPS) return null
  return 1 - num / den
}

// Pass means at least half of the question's marks. The lecturer's
// decision is the actual class and the AI's the predicted one, with pass
// as the positive class.
export function passFailMetrics(pairs) {
  let tp = 0
  let fp = 0
  let fn = 0
  let tn = 0
  for (const p of pairs) {
    const aiPass = p.suggested >= p.maxMarks / 2
    const humanPass = p.confirmed >= p.maxMarks / 2
    if (aiPass && humanPass) tp++
    else if (aiPass && !humanPass) fp++
    else if (!aiPass && humanPass) fn++
    else tn++
  }
  const precision = tp + fp ? tp / (tp + fp) : null
  const recall = tp + fn ? tp / (tp + fn) : null
  const f1 = precision != null && recall != null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null
  const n = tp + fp + fn + tn
  return {
    accuracy: n ? round((tp + tn) / n) : null,
    precision: round(precision),
    recall: round(recall),
    f1: round(f1),
    confusion: { truePass: tp, falsePass: fp, falseFail: fn, trueFail: tn },
  }
}

// Core agreement numbers for any set of { suggested, confirmed, maxMarks }.
export function agreementStats(pairs) {
  const n = pairs.length
  if (n === 0) return { n: 0 }
  const s = pairs.map((p) => p.suggested)
  const c = pairs.map((p) => p.confirmed)
  const diffs = pairs.map((p) => p.suggested - p.confirmed)
  const abs = diffs.map(Math.abs)
  const pctAbs = pairs.map((p, i) => (p.maxMarks ? (abs[i] / p.maxMarks) * 100 : 0))
  return {
    n,
    exactAgreement: round(abs.filter((d) => d < EPS).length / n),
    withinOneMark: round(abs.filter((d) => d <= 1 + EPS).length / n),
    mae: round(mean(abs)),
    rmse: round(Math.sqrt(mean(diffs.map((d) => d * d)))),
    maePercentOfMax: round(mean(pctAbs), 1),
    meanBias: round(mean(diffs)), // positive: the AI tends to award more than the lecturer
    pearson: round(pearson(s, c)),
    kappa: round(cohensKappa(s, c, 'none')),
    quadraticKappa: round(cohensKappa(s, c, 'quadratic')),
  }
}

// Builds the full report from answer rows shaped like
// { scriptId, regNumber, questionId, questionLabel, maxMarks, confidence,
//   suggested, confirmed, autoAccepted, overridden }.
export function buildEvaluationReport(rows) {
  const scored = rows.filter((r) => r.suggested != null && r.confirmed != null)
  const human = scored.filter((r) => !r.autoAccepted)

  const byConfidence = {}
  for (const level of ['high', 'medium', 'low']) {
    const group = human.filter((r) => (r.confidence || 'low') === level)
    byConfidence[level] = group.length ? agreementStats(group) : { n: 0 }
  }

  const questionMap = new Map()
  for (const r of human) {
    if (!questionMap.has(r.questionId)) questionMap.set(r.questionId, { label: r.questionLabel, maxMarks: r.maxMarks, pairs: [] })
    questionMap.get(r.questionId).pairs.push(r)
  }
  const perQuestion = [...questionMap.values()].map((q) => {
    const st = agreementStats(q.pairs)
    return { question: q.label, maxMarks: q.maxMarks, n: st.n, exactAgreement: st.exactAgreement, mae: st.mae, quadraticKappa: st.quadraticKappa }
  })

  // Script level: only scripts where a human confirmed every scored answer,
  // so the totals compare a fully AI marked script with a fully human one.
  const scriptMap = new Map()
  for (const r of scored) {
    if (!scriptMap.has(r.scriptId)) scriptMap.set(r.scriptId, [])
    scriptMap.get(r.scriptId).push(r)
  }
  const scriptPairs = []
  for (const answers of scriptMap.values()) {
    if (answers.some((a) => a.autoAccepted)) continue
    const max = answers.reduce((sum, a) => sum + (a.maxMarks || 0), 0)
    if (!max) continue
    const ai = (answers.reduce((sum, a) => sum + a.suggested, 0) / max) * 100
    const lecturer = (answers.reduce((sum, a) => sum + a.confirmed, 0) / max) * 100
    scriptPairs.push({ ai, lecturer })
  }
  const grades = 'ABCDEF'
  const gradeGap = scriptPairs.map((p) => Math.abs(grades.indexOf(computeGrade(p.ai)) - grades.indexOf(computeGrade(p.lecturer))))
  const scriptAbs = scriptPairs.map((p) => Math.abs(p.ai - p.lecturer))

  return {
    answersScored: scored.length,
    humanConfirmed: human.length,
    autoAcceptedExcluded: scored.length - human.length,
    overriddenAfterConfirm: rows.filter((r) => r.overridden).length,
    overall: agreementStats(human),
    passFail: passFailMetrics(human),
    byConfidence,
    perQuestion,
    scripts: {
      n: scriptPairs.length,
      maePercent: round(mean(scriptAbs), 1),
      rmsePercent: round(Math.sqrt(mean(scriptPairs.map((p) => (p.ai - p.lecturer) ** 2))), 1),
      pearson: round(pearson(scriptPairs.map((p) => p.ai), scriptPairs.map((p) => p.lecturer))),
      sameGrade: scriptPairs.length ? round(gradeGap.filter((g) => g === 0).length / scriptPairs.length) : null,
      withinOneGrade: scriptPairs.length ? round(gradeGap.filter((g) => g <= 1).length / scriptPairs.length) : null,
    },
  }
}

function questionLabel(q) {
  return `Q${q.number}${q.subLabel ? q.subLabel : ''}`
}

export async function loadEvaluationRows(sessionId) {
  const answers = await prisma.scriptAnswer.findMany({
    where: { script: { sessionId } },
    include: { question: true, script: { select: { id: true, regNumber: true, ocrConfidence: true } } },
  })
  return answers.map((a) => ({
    scriptId: a.script.id,
    regNumber: a.script.regNumber,
    ocrConfidence: a.script.ocrConfidence,
    questionId: a.questionId,
    questionLabel: a.question ? questionLabel(a.question) : a.questionId,
    maxMarks: a.question?.maxMarks ?? null,
    confidence: a.confidence,
    suggested: a.suggestedScore,
    confirmed: a.confirmedScore,
    autoAccepted: a.autoAccepted,
    overridden: a.previousScore != null,
  }))
}

// One row per answer, for re running the analysis in Excel or SPSS, or
// pooling several sessions together.
export function evaluationCsv(rows) {
  const header = ['script_id', 'reg_number', 'question', 'max_marks', 'confidence', 'ai_score', 'lecturer_score', 'abs_difference', 'auto_accepted', 'overridden', 'ocr_confidence']
  const esc = (v) => {
    if (v == null) return ''
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = rows
    .filter((r) => r.suggested != null && r.confirmed != null)
    .map((r) =>
      [r.scriptId, r.regNumber, r.questionLabel, r.maxMarks, r.confidence, r.suggested, r.confirmed, round(Math.abs(r.suggested - r.confirmed)), r.autoAccepted, r.overridden, round(r.ocrConfidence)]
        .map(esc)
        .join(',')
    )
  return [header.join(','), ...lines].join('\n') + '\n'
}
