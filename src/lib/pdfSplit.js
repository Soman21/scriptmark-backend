import * as mupdf from 'mupdf'

// Page images are saved as colour JPEG. A PNG of a scanned page is about
// 1.5 MB; the same page as JPEG at this quality is about 0.35 MB and looks
// the same, and Google Vision reads it just as well since the size in
// pixels does not change. Colour is kept so ink colours, corrections and
// stamps stay visible for moderation and appeals.
export const PAGE_JPEG_QUALITY = 85
export const PAGE_MIME_TYPE = 'image/jpeg'

// Renders the pages of a PDF ONE AT A TIME, as JPEG buffers. Uses mupdf's
// WASM build, so no native compilation is needed.
//
// This is a generator: each page is rendered only when the caller asks for
// the next one, and its memory is freed straight after. Upload each page
// before moving on, and memory stays flat whatever the page count. The old
// version rendered every page as PNG into one array first, which needed
// about 11 MB per page and crashed a 512 MB server on PDFs over ~20 pages.
//
//   for (const page of pageImages(pdfBuffer)) await upload(page)
export function* pageImages(pdfBuffer) {
  const doc = mupdf.Document.openDocument(pdfBuffer, 'application/pdf')
  try {
    const pageCount = doc.countPages()
    for (let i = 0; i < pageCount; i++) {
      const page = doc.loadPage(i)
      // 2x scale gives a good balance of OCR-readable resolution vs file size.
      const pixmap = page.toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB)
      const jpeg = Buffer.from(pixmap.asJPEG(PAGE_JPEG_QUALITY))
      pixmap.destroy()
      page.destroy()
      yield jpeg
    }
  } finally {
    doc.destroy()
  }
}
