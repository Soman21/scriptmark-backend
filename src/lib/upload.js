import multer from 'multer'

// File uploads held in memory, with a size limit in MB. Multer reports a
// file over the limit by passing an error on to Express, which used to end
// at the general "Unexpected server error." handler, so a lecturer whose
// PDF was too big had no idea why the split failed. These wrappers answer
// such errors here, with a message that names the limit.
export function fileUpload(limitMb) {
  const m = multer({ storage: multer.memoryStorage(), limits: { fileSize: limitMb * 1024 * 1024 } })
  const wrap = (middleware) => (req, res, next) =>
    middleware(req, res, (err) => {
      if (!err) return next()
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `File is larger than ${limitMb} MB.`, code: 'FILE_TOO_LARGE', limitMb })
      }
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ error: `Upload failed: ${err.message}.` })
      }
      next(err)
    })
  return {
    single: (field) => wrap(m.single(field)),
    array: (field, maxCount) => wrap(m.array(field, maxCount)),
  }
}
