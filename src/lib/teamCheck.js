// Decides whether to ask the coordinator about adding lecturers when they
// finish uploading scripts. The ask only makes sense while they are marking
// alone and the guide still has questions nobody holds; once anyone else
// joins, or every question has a lecturer, it stops appearing.
//
// markers:   APPROVED SessionMarker rows for the session ({ userId })
// questions: the guide's questions ({ assignedMarkerId })
// userId:    the person finishing the upload
export function teamCheck({ markers = [], questions = [], userId }) {
  const otherLecturers = markers.filter((m) => m.userId !== userId).length
  const unclaimed = questions.filter((q) => !q.assignedMarkerId).length
  return {
    otherLecturers,
    unclaimed,
    askToAddLecturers: otherLecturers === 0 && unclaimed > 0,
  }
}
