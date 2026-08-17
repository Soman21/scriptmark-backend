// Institution grading scale: 70-100=A, 60-69=B, 50-59=C, 45-49=D, 40-44=E, below 40=F
export function computeGrade(total) {
  if (total == null) return ''
  if (total >= 70) return 'A'
  if (total >= 60) return 'B'
  if (total >= 50) return 'C'
  if (total >= 45) return 'D'
  if (total >= 40) return 'E'
  return 'F'
}
