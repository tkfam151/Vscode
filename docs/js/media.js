// Images in a workspace.
//
// Workspace files are stored as text, so an uploaded picture is kept as a
// "data URL" (data:image/png;base64,...). SVG images are ordinary text files.
// Large photos are scaled down on upload so they stay small.

export const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
export const MAX_STORED = 3_000_000; // characters per file (about 2.2 MB of image)
const MAX_SIDE = 1600; // photos larger than this (in pixels) are scaled down
const TEXT_EXT = /\.(py|js|mjs|cjs|ts|mts|html?|css|md|markdown|txt|json|csv|tsv|xml|ya?ml|toml|ini|cfg|sql|lua|sh|bash|java|c|h|cpp|cc|hpp|cs|go|rs|rb|php|kt|swift|r|scala|dart|pl|vb|svg|log|env|gitignore)$/i;

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
};
export const mimeFor = (path) => MIME[(path.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase()] || 'application/octet-stream';

export const isImage = (path) => IMAGE_RE.test(path);
export const isDataUrl = (content) => typeof content === 'string' && content.startsWith('data:');

/** A URL a browser can show for this workspace file, or null if it isn't an image. */
export function imageUrl(path, content) {
  if (!isImage(path) || typeof content !== 'string') return null;
  if (isDataUrl(content)) return content;
  if (/\.svg$/i.test(path)) return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(content);
  return null;
}

export const sizeLabel = (chars) => {
  const bytes = Math.round(chars * 0.75);
  return bytes < 1024 ? `${bytes} bytes` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
};

const readAs = (file, how) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r[how](file);
  });

/** Scale a big photo down and re-encode it. Returns a data URL. */
async function shrink(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const type = file.type === 'image/png' ? 'image/png' : file.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
  let url = canvas.toDataURL(type, 0.85);
  if (url.length > MAX_STORED && type !== 'image/jpeg') url = canvas.toDataURL('image/jpeg', 0.85);
  return url;
}

/**
 * Turn an uploaded file into workspace content.
 * Returns { content, note } or throws an Error with a message for the person.
 */
export async function readUpload(file) {
  if (isImage(file.name)) {
    if (/\.svg$/i.test(file.name)) return { content: await readAs(file, 'readAsText') };
    let url = await readAs(file, 'readAsDataURL');
    let note = '';
    const resizable = /\.(png|jpe?g|webp|bmp)$/i.test(file.name);
    if (resizable && url.length > 1_000_000) {
      try {
        url = await shrink(file);
        note = 'made smaller';
      } catch {}
    }
    if (url.length > MAX_STORED) throw new Error(`${file.name} is too big (${sizeLabel(url.length)}). Images can be up to about 2 MB.`);
    // the browser sometimes leaves the type blank: use the file extension's
    // (a scaled-down photo keeps the type it was re-encoded as)
    if (!note) url = url.replace(/^data:[^;,]*/, 'data:' + mimeFor(file.name));
    return { content: url, note };
  }
  const buf = new Uint8Array(await readAs(file, 'readAsArrayBuffer'));
  if (buf.length > 256 * 1024) throw new Error(`${file.name} is too big. Text files can be up to 256 KB.`);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    if (!TEXT_EXT.test(file.name) && /[\x00-\x08\x0e-\x1f]/.test(text.slice(0, 2000))) throw new Error();
    return { content: text };
  } catch {
    throw new Error(`${file.name} can't be added: only images (PNG, JPG, GIF, WebP, SVG...) and text or code files can be uploaded.`);
  }
}
