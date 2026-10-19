import { normalizeRegNumber } from './roster.js'

// Two scripts in one session with the same reg number are almost always the
// same booklet scanned twice, which would give that student two rows on the
// result sheet. The slash is ignored, so 2021/245678 and 2021245678 match.
export function duplicateKey(regNumber) {
  return normalizeRegNumber(regNumber).replace(/\//g, '')
}

// Adds duplicateOf (the ids of the other scripts sharing the reg number) to
// each script; an empty list means it is the only one.
export function withDuplicateFlags(scripts) {
  const groups = new Map()
  for (const s of scripts) {
    const key = duplicateKey(s.regNumber)
    if (!key) continue
    groups.set(key, [...(groups.get(key) || []), s.id])
  }
  return scripts.map((s) => {
    const ids = groups.get(duplicateKey(s.regNumber)) || []
    return { ...s, duplicateOf: ids.filter((id) => id !== s.id) }
  })
}

// The other scripts in the session already holding this script's reg number.
export async function findDuplicates(prisma, script) {
  const key = duplicateKey(script.regNumber)
  if (!key) return []
  const others = await prisma.script.findMany({
    where: { sessionId: script.sessionId, id: { not: script.id }, regNumber: { not: null } },
    select: { id: true, studentName: true, regNumber: true },
  })
  return others.filter((o) => duplicateKey(o.regNumber) === key)
}
