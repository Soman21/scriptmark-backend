import vision from '@google-cloud/vision'

// The service account key (downloaded as a .json file from Google Cloud) is stored
// as a single-line JSON string in the GOOGLE_CREDENTIALS_JSON env variable — this
// avoids needing to commit a credentials file, and works the same locally and on Railway.
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)

const client = new vision.ImageAnnotatorClient({ credentials })

// Runs OCR on an image (given its public URL) and returns the extracted text + a rough confidence score.
// documentTextDetection is used instead of textDetection because it's tuned for dense
// pages of text (like exam scripts) rather than short text in photos (like signs).
export async function extractTextFromImage(imageUrl) {
  const [result] = await client.documentTextDetection(imageUrl)
  const fullTextAnnotation = result.fullTextAnnotation

  if (!fullTextAnnotation || !fullTextAnnotation.text) {
    return { text: '', confidence: 0 }
  }

  // documentTextDetection gives a real page-level confidence score, unlike textDetection.
  const confidence = fullTextAnnotation.pages?.[0]?.confidence ?? 0.9

  return { text: fullTextAnnotation.text.trim(), confidence }
}
