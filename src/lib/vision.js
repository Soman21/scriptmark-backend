import vision from '@google-cloud/vision'
import { linesFromAnnotation } from './ocrLines.js'

const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)

const client = new vision.ImageAnnotatorClient({ credentials })

// lines: where each line of text sits on the page (see ocrLines.js). Vision
// sends these positions in the same reply as the text, so keeping them
// costs no extra call.
export async function extractTextFromImage(imageUrl) {
  const [result] = await client.documentTextDetection(imageUrl)
  const fullTextAnnotation = result.fullTextAnnotation

  if (!fullTextAnnotation || !fullTextAnnotation.text) {
    return { text: '', confidence: 0, lines: [] }
  }

  const confidence = fullTextAnnotation.pages?.[0]?.confidence ?? 0.9

  return { text: fullTextAnnotation.text.trim(), confidence, lines: linesFromAnnotation(fullTextAnnotation) }
}
