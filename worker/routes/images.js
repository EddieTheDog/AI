// worker/routes/images.js

import { json, err, newId } from '../lib/response.js';

const ALLOWED_TYPES = ['image/jpeg','image/png','image/webp','image/gif'];
const MAX_BYTES     = 10 * 1024 * 1024; // 10MB

export async function handleImages(path, method, request, env, user) {
  if (path === '/images/upload' && method === 'POST') return uploadImage(request, env, user);
  return err('Not found', 404);
}

async function uploadImage(request, env, user) {
  let formData;
  try { formData = await request.formData(); } catch { return err('Invalid form data'); }

  const file = formData.get('file');
  if (!file || typeof file === 'string') return err('No file provided');

  if (!ALLOWED_TYPES.includes(file.type)) return err('Only JPEG, PNG, WebP, or GIF images allowed');
  if (file.size > MAX_BYTES) return err('Image must be under 10MB');

  const id         = newId('img');
  const ext        = file.type.split('/')[1].replace('jpeg','jpg');
  const storageKey = `images/${user.id}/${id}.${ext}`;
  const now        = new Date().toISOString();

  // If R2 is available use it, otherwise store as base64 data URL in D1
  // (D1-only mode for platforms without R2)
  let url;

  if (env.R2) {
    const arrayBuffer = await file.arrayBuffer();
    await env.R2.put(storageKey, arrayBuffer, {
      httpMetadata: { contentType: file.type },
    });
    url = `${env.R2_PUBLIC_URL ?? ''}/${storageKey}`;
  } else {
    // Fallback: store as base64 data URL — fine for small images
    const arrayBuffer = await file.arrayBuffer();
    const b64         = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
    url               = `data:${file.type};base64,${b64}`;
  }

  await env.DB.prepare(
    `INSERT INTO image_meta (id, user_id, filename, mime_type, size_bytes, storage_key, url, created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(id, user.id, file.name, file.type, file.size, storageKey, url, now).run();

  return json({ id, url, filename: file.name }, 201);
}
