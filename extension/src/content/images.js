// Paste, drop or pick images for a note or a reply. The bytes go to the background script.
// Thumbnails are canvases: the page never holds an image URL.
import { ext, IMAGE_ID_RE, IMAGES_MAX, MSG, SHOT_MAX } from '../shared/protocol.js';
import { ENCODE_ATTEMPTS, bytesToBase64, cleanImageIds, drawSize, sendAsIs } from '../shared/image.js';
import { el, iconButton } from './dom.js';
import { setError } from './layout.js';

export const IMAGE_WAIT = 'Wait until the image is uploaded.';
export const attachedReply = count => count > 1 ? 'See the attached images.' : 'See the attached image.';
const limitText = kind => kind === 'reply' ? 'A reply takes up to 6 images.' : 'A pin takes up to 6 images.';

function imageFiles(list) {
  return [...list || []].filter(file => file && (!file.type || file.type.startsWith('image/')));
}
function filesOf(data) {
  const listed = [...data?.files || []];
  const items = [];
  if (!listed.length && data?.items) for (const item of data.items) if (item.kind === 'file') items.push(item.getAsFile());
  return imageFiles(listed.length ? listed : items);
}

// A file the browser can decode. A shot type that already fits is sent unchanged. Anything
// else is drawn down to 2560 px and encoded, then scaled by 0.75 at most three more times.
export async function prepareImage(file) {
  let bitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error('That file is not an image this browser can read.'); }
  try {
    if (!bitmap.width || !bitmap.height) throw new Error('That file is not an image this browser can read.');
    if (sendAsIs(file.type, file.size, bitmap.width, bitmap.height)) return { type: file.type, bytes: new Uint8Array(await file.arrayBuffer()), bitmap };
    for (let attempt = 0; attempt < ENCODE_ATTEMPTS; attempt++) {
      const [width, height] = drawSize(bitmap.width, bitmap.height, attempt);
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
      for (const [type, quality] of [['image/webp', 0.9], ['image/jpeg', 0.8]]) {
        const blob = await new Promise(resolve => canvas.toBlob(resolve, type, quality));
        if (blob && blob.size >= 1 && blob.size <= SHOT_MAX) return { type, bytes: new Uint8Array(await blob.arrayBuffer()), bitmap };
      }
    }
    throw new Error('That image is too large.');
  } catch (error) { bitmap.close?.(); throw error; }
}

function paint(canvas, bitmap, side) {
  const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
}

// `host` receives the drop (the popup, or the reply form). `box` receives the paste.
export function attachImages({ host, box, error, kind, ids }) {
  const slots = [];
  const node = el('div', 'thumbs');
  const file = el('input', 'file-input');
  file.type = 'file'; file.accept = 'image/*'; file.multiple = true; file.hidden = true; file.tabIndex = -1;
  file.setAttribute('aria-hidden', 'true');
  const button = iconButton('Add an image. You can also paste or drop one.', 'plus', event => {
    if (!event.isTrusted) return;
    try { file.showPicker(); } catch { /* This browser refused the picker. Paste and drop still work. */ }
  }, 'add-image');
  host.append(file);

  const render = () => node.replaceChildren(...slots.map((slot, index) => {
    const thumb = el('div', 'thumb');
    thumb.setAttribute('aria-busy', slot.busy ? 'true' : 'false');
    const canvas = el('canvas');
    if (slot.bitmap) paint(canvas, slot.bitmap, 48);
    const remove = iconButton(`Remove image ${index + 1}`, 'close', () => {
      slot.bitmap?.close?.();
      const at = slots.indexOf(slot);
      if (at >= 0) slots.splice(at, 1);
      render();
    }, 'thumb-remove');
    thumb.append(canvas, remove);
    return thumb;
  }));
  const drop = id => { const at = slots.indexOf(id); if (at < 0) return false; id.bitmap?.close?.(); slots.splice(at, 1); render(); return true; };

  async function addOne(item) {
    if (slots.length >= IMAGES_MAX) return false;
    const slot = { id: '', busy: true, bitmap: null };
    slots.push(slot); render();
    try {
      const prepared = await prepareImage(item);
      if (!slots.includes(slot)) { prepared.bitmap.close?.(); return true; }
      slot.bitmap = prepared.bitmap; render();
      const response = await ext.runtime.sendMessage({ t: MSG.UPLOAD, type: prepared.type, data: bytesToBase64(prepared.bytes) });
      const imageId = response?.data?.image?.id;
      if (!slots.includes(slot)) return true;
      if (!response?.ok || !IMAGE_ID_RE.test(imageId || '')) throw new Error(response?.error || 'the upload failed');
      slot.id = imageId; slot.busy = false; render();
    } catch (failure) {
      if (drop(slot)) setError(error, `Image not added: ${failure instanceof Error ? failure.message : 'the upload failed'}`);
    }
    return true;
  }
  async function addFiles(list) {
    const files = [...list || []].filter(Boolean);
    if (!files.length) return;
    let room = true;
    for (const item of files) {
      if (!(await addOne(item))) { room = false; break; }
    }
    if (!room) setError(error, limitText(kind));
  }
  async function loadStored(imageId) {
    const slot = { id: imageId, busy: true, bitmap: null };
    slots.push(slot); render();
    try {
      const response = await ext.runtime.sendMessage({ t: MSG.IMAGE, id: imageId });
      if (!response?.ok || typeof response.data !== 'string') throw new Error('it is gone');
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(response.data), char => char.charCodeAt(0))], { type: response.type }));
      if (!slots.includes(slot)) { bitmap.close?.(); return; }
      slot.bitmap = bitmap; slot.busy = false; render();
    } catch (failure) {
      if (drop(slot)) setError(error, `Image not added: ${failure instanceof Error ? failure.message : 'it is gone'}`);
    }
  }

  box.addEventListener('paste', event => {
    if (!event.isTrusted) return;
    const files = filesOf(event.clipboardData);
    if (!files.length) return;
    if (![...event.clipboardData.types].includes('text/plain')) event.preventDefault();
    event.stopPropagation();
    void addFiles(files);
  });
  host.addEventListener('dragover', event => {
    if (!event.isTrusted || !event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault(); event.stopPropagation();
    host.dataset.drop = 'true';
  });
  host.addEventListener('dragleave', event => { if (!host.contains(event.relatedTarget)) delete host.dataset.drop; });
  host.addEventListener('drop', event => {
    delete host.dataset.drop;
    if (!event.isTrusted) return;
    const files = filesOf(event.dataTransfer);
    if (!files.length) return;
    event.preventDefault(); event.stopPropagation();
    void addFiles(files);
  });
  file.addEventListener('change', event => {
    if (!event.isTrusted) return;
    const chosen = [...file.files];
    file.value = '';
    void addFiles(chosen);
  });
  for (const imageId of cleanImageIds(ids)) void loadStored(imageId);
  return {
    node, button,
    busy: () => slots.some(slot => slot.busy),
    ids: () => slots.filter(slot => slot.id).map(slot => slot.id),
    clear() { for (const slot of slots) slot.bitmap?.close?.(); slots.length = 0; render(); },
  };
}
