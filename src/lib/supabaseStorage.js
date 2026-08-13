import { createClient } from '@supabase/supabase-js'

// Uses the SECRET key (server-side only, bypasses row-level security).
// Never expose this key or this client to the frontend.
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY)

const BUCKET = 'script-images'

// Uploads a file buffer (from multer) to Supabase Storage and returns its public URL.
export async function uploadScriptImage(fileBuffer, originalName, mimeType) {
  const safeName = `${Date.now()}-${originalName.replace(/[^a-zA-Z0-9.\-_]/g, '')}`

  const { error } = await supabase.storage.from(BUCKET).upload(safeName, fileBuffer, {
    contentType: mimeType,
    upsert: false,
  })

  if (error) {
    throw new Error(`Supabase Storage upload failed: ${error.message}`)
  }

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(safeName)
  return data.publicUrl
}