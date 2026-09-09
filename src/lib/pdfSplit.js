import * as mupdf from 'mupdf'

// Converts every page of a PDF into a PNG buffer. Uses mupdf's WASM build —
// no native compilation, so this works the same locally and on Railway.
export function pdfToPageImages(pdfBuffer) {
  const doc = mupdf.Document.openDocument(pdfBuffer, 'application/pdf')
  const pageCount = doc.countPages()

  const images = []
  for (let i = 0; i < pageCount; i++) {
    const page = doc.loadPage(i)
    // 2x scale gives a good balance of OCR-readable resolution vs file size.
    const pixmap = page.toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB)
    const png = pixmap.asPNG()
    images.push(Buffer.from(png))
  }

  return images
}
