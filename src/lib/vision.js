import vision from '@google-cloud/vision'

const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)

const client = new vision.ImageAnnotatorClient({ credentials })

export async function extractTextFromImage(imageUrl) {
  const [result] = await client.documentTextDetection(imageUrl)
  const fullTextAnnotation = result.fullTextAnnotation

  if (!fullTextAnnotation || !fullTextAnnotation.text) {
    return { text: '', confidence: 0 }
  }

  const confidence = fullTextAnnotation.pages?.[0]?.confidence ?? 0.9

  return { text: fullTextAnnotation.text.trim(), confidence }
}
