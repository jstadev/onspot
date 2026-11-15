// The card of one pin: its thread, the steps and shots of its run, and what he can do with it.
import { ext, MSG, RUN_URL, SHOT_KINDS } from '../shared/protocol.js';
import { HOST, SHOT_CACHE, SHOT_WIDTH } from './env.js';
import { resolveTarget } from './target.js';
import { ABOUT, SCOPE } from './prefs.js';
import { elapsed, goBack, isOpen, modelName, revertTag, statusText, when } from './format.js';
import { announce, button, el, errorNode, link, panelShell, setTitle, textarea } from './dom.js';
import { schedule, setError, showFlash, syncWatchers } from './layout.js';
import { api } from './live.js';
import { pinButton } from './capsule.js';
import { closePopup } from './notes.js';
import { IMAGE_WAIT, attachedReply, attachImages } from './images.js';
import { acceptPin, markers, markSeen, pins, questions, renderMarkers, revision, revisions, seeIt } from './pins.js';
import { dropToast } from './toasts.js';
import { closeLog } from './log.js';
import { closeSettings } from './settings.js';

export let card = null;
// Shot and pin-image bitmaps. One cache, same as the shots: the oldest leaves at the limit.
const bitmaps = new Map();

function syncQuestion(instance) {
  const text = instance.pin?.status === 'waiting' ? latestAgentBody(instance.replies) : '';
  instance.question.textContent = text;
  instance.question.hidden = !text;
}
function latestAgentBody(replies) {
  let best = null;
  for (const item of replies.values()) if (item.kind === 'agent' && (!best || item.id > best.id)) best = item;
  return best?.body || '';
}
// The background sends the bytes. They go into a canvas, so the page never holds an image URL.
function loadBitmap(key, message) {
  if (!bitmaps.has(key)) {
    bitmaps.set(key, ext.runtime.sendMessage(message).then(response => {
      if (!response?.ok || typeof response.data !== 'string') throw new Error('No image');
      return createImageBitmap(new Blob([Uint8Array.from(atob(response.data), char => char.charCodeAt(0))], { type: response.type }));
    }).catch(() => { bitmaps.delete(key); return null; }));
    if (bitmaps.size > SHOT_CACHE) bitmaps.delete(bitmaps.keys().next().value);
  }
  return bitmaps.get(key);
}
function zoom(container, node, closeTitle) {
  const full = node.dataset.full !== 'true';
  for (const item of container.children) {
    const on = full && item === node;
    item.dataset.full = String(on);
    item.hidden = full && item !== node;
    setTitle(item, on ? closeTitle : item.dataset.open);
  }
  schedule();
}
// Shots and attached images share this strip: a click shows one image at the full card width.
function renderStrip(container, entries, closeTitle) {
  const signature = entries.map(entry => entry.key).join();
  if (container.dataset.signature === signature) return;
  container.dataset.signature = signature;
  container.hidden = !entries.length;
  container.replaceChildren(...entries.map(entry => {
    const node = button(entry.title, undefined, () => zoom(container, node, closeTitle), 'shot');
    node.dataset.open = entry.title;
    if (entry.kind) node.dataset.kind = entry.kind;
    const canvas = el('canvas');
    if (entry.name) node.append(el('span', 'shot-name', entry.name));
    node.append(canvas);
    loadBitmap(entry.key, entry.message).then(bitmap => {
      if (!node.isConnected) return;
      if (!bitmap) { node.remove(); if (!container.children.length) container.hidden = true; return; }
      const scale = Math.min(1, SHOT_WIDTH / bitmap.width);
      canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      schedule();
    });
    return node;
  }));
}
function renderShots(instance, pin) {
  const entries = SHOT_KINDS.filter(kind => pin.shots?.[kind]).map(kind => {
    const name = kind === 'before' ? 'Before' : 'After';
    return { key: `${pin.id}:${kind}:${pin.shots[kind]}`, message: { t: MSG.SHOT, id: pin.id, kind }, title: `Show the ${name} image at full width`, kind, name };
  });
  renderStrip(instance.shots, entries, 'Show both images side by side');
}
function imageEntries(images) {
  return images.map((image, index) => ({ key: `image:${image.id}`, message: { t: MSG.IMAGE, id: image.id }, title: `Show image ${index + 1} at full width` }));
}
const pinImages = pin => (Array.isArray(pin?.images) ? pin.images : []).filter(image => image?.id && image.replyId == null);
function replyImages(pin, reply) {
  const own = Array.isArray(reply?.images) ? reply.images.filter(image => image?.id) : [];
  return own.length ? own : (Array.isArray(pin?.images) ? pin.images : []).filter(image => image?.replyId === reply?.id);
}
function renderPinImages(instance, pin) {
  renderStrip(instance.pinImages, imageEntries(pinImages(pin)), 'Show the images in a row');
}
function syncReplyStrips(instance) {
  for (const li of instance.list.children) {
    const reply = instance.replies.get(Number(li.dataset.id));
    const images = reply ? replyImages(instance.pin, reply) : [];
    let strip = [...li.children].find(item => item.classList.contains('images'));
    if (!images.length) { strip?.remove(); continue; }
    if (!strip) { strip = el('div', 'images'); li.append(strip); }
    renderStrip(strip, imageEntries(images), 'Show the images in a row');
  }
}
export function refreshCard(instance, pin) {
  if (card !== instance) return;
  instance.pin = pin;
  instance.title.textContent = `Pin ${pin.id}`;
  instance.status.textContent = statusText(pin);
  instance.status.title = instance.status.textContent;
  instance.status.dataset.status = pin.status;
  instance.accepted.hidden = pin.status !== 'done' || !pin.acceptedAt;
  instance.accepted.title = pin.acceptedAt ? `You accepted it ${when(pin.acceptedAt)}` : '';
  instance.tag.textContent = revertTag(pin); instance.tag.hidden = !instance.tag.textContent;
  instance.note.textContent = pin.note;
  const tags = [ABOUT[pin.intent]?.[0], SCOPE[pin.scope]?.[0]].filter(Boolean).map(text => el('span', 'chip', text));
  for (const preset of Array.isArray(pin.presets) ? pin.presets : []) {
    const tag = el('span', 'chip preset', preset?.label);
    tag.title = preset?.text ?? '';
    tags.push(tag);
  }
  instance.tags.replaceChildren(...tags); instance.tags.hidden = !tags.length;
  instance.quote.textContent = pin.quote || ''; instance.quote.hidden = !pin.quote;
  instance.target.textContent = pin.targets.map(target => target.label).join(' · ');
  // While the run works: the elapsed time (it ticks only here), its steps and the live view.
  const working = pin.status === 'working', task = /^triad:([\w.-]{1,80})$/.exec(pin.run || '')?.[1];
  const count = pin.progress?.count || 0;
  if (count !== instance.count) { instance.count = count; if (count) loadCard(instance); else instance.steps = []; }
  instance.run.hidden = !working;
  instance.watch.hidden = !task; instance.watch.href = task ? RUN_URL + task : '';
  clearInterval(instance.timer); instance.timer = 0;
  if (working) {
    const tick = () => { instance.elapsed.textContent = elapsed(pin); };
    tick(); instance.timer = setInterval(tick, 1000);
    instance.stepList.replaceChildren(...instance.steps.map(step => {
      const item = el('li', 'step');
      item.append(el('time', '', when(step.createdAt)), el('span', '', step.body));
      return item;
    }));
  }
  renderShots(instance, pin);
  renderPinImages(instance, pin);
  syncReplyStrips(instance);
  const who = [modelName(pin), pin.agent].filter(Boolean).join(' · ');
  instance.agent.textContent = who ? `By ${who}` : ''; instance.agent.hidden = !who || pin.status === 'queued';
  instance.summary.textContent = pin.summary || ''; instance.summary.hidden = !pin.summary;
  instance.commit.textContent = pin.commit ? `Commit ${pin.commit}` : ''; instance.commit.hidden = !pin.commit;
  if (!instance.busy) instance.panel.querySelectorAll('button').forEach(node => { node.disabled = false; });
  const closed = pin.status === 'done' || pin.status === 'dismissed';
  instance.edit.hidden = pin.status !== 'queued' || Boolean(pin.revert);
  instance.dismiss.hidden = !isOpen(pin);
  instance.reopen.hidden = pin.status !== 'working' && pin.status !== 'waiting';
  instance.see.hidden = pin.status !== 'done';
  instance.good.hidden = pin.status !== 'done' || Boolean(pin.acceptedAt);
  const back = Boolean(goBack(pin));
  instance.backOpen &&= back;
  instance.back.hidden = !back || instance.backOpen; instance.backBox.hidden = !instance.backOpen;
  // Open pins take replies. A closed pin shows "Not right", which opens the reply box.
  instance.replyForm.hidden = closed && !instance.wrongOpen;
  instance.wrong.hidden = !closed || instance.wrongOpen;
  instance.reply.placeholder = instance.wrongOpen ? 'What is still wrong?' : pin.status === 'waiting' ? 'Your answer…' : 'Add a reply…';
  instance.sendReply.textContent = instance.wrongOpen ? 'Fix again' : 'Reply';
  instance.sendReply.title = instance.wrongOpen ? 'Send this and fix the pin again' : 'Send your reply';
  if (pin.status !== 'queued') { instance.editor.hidden = true; instance.note.hidden = false; }
  syncQuestion(instance);
  schedule();
}
export function appendReply(instance, reply) {
  if (!reply || instance.replies.has(reply.id)) return;
  instance.replies.set(reply.id, reply);
  if (reply.kind === 'agent') questions.set(instance.id, reply.body);
  instance.list.replaceChildren();
  for (const item of [...instance.replies.values()].sort((a, b) => a.id - b.id)) {
    const li = el('li', 'reply');
    const meta = el('div', 'reply-meta');
    meta.append(el('span', '', item.kind === 'agent' ? item.author || 'agent' : 'you'));
    const date = new Date(item.createdAt);
    if (!Number.isNaN(date.getTime())) {
      const time = el('time', '', date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      time.dateTime = item.createdAt; time.title = date.toLocaleString(); meta.append(time);
    }
    li.dataset.id = String(item.id);
    li.append(meta, el('p', 'reply-body', item.body)); instance.list.append(li);
  }
  syncReplyStrips(instance);
  syncQuestion(instance);
  schedule();
}
export async function loadCard(instance) {
  const started = revision;
  try {
    const data = await api('GET', `/api/pins/${instance.id}`);
    if (card !== instance) return;
    // A link can name any pin (`#kog-pin=<id>`). Only a pin of this site opens here.
    if (data?.pin?.host !== HOST) throw new Error('This pin is not on this site.');
    instance.steps = Array.isArray(data.steps) ? data.steps : [];
    if ((revisions.get(instance.id) || 0) <= started) { pins.set(data.pin.id, data.pin); instance.count = data.pin.progress?.count || 0; }
    refreshCard(instance, pins.get(instance.id) || data.pin); renderMarkers();
    for (const reply of Array.isArray(data.replies) ? data.replies : []) appendReply(instance, reply);
    setError(instance.error);
  } catch (error) {
    if (card !== instance) return;
    setError(instance.error, error.message);
    if (!instance.pin) instance.status.textContent = 'Not loaded';
  }
}
async function cardAction(instance, method, suffix = '', body) {
  if (instance.busy || card !== instance) return false;
  instance.busy = true;
  const submittedReply = instance.reply.value;
  const buttons = [...instance.panel.querySelectorAll('button')].filter(node => node !== instance.close);
  buttons.forEach(node => { node.disabled = true; });
  setError(instance.error);
  try {
    const data = await api(method, `/api/pins/${instance.id}${suffix}`, body);
    if (method === 'DELETE') {
      const pin = instance.pin || pins.get(instance.id);
      if (pin) acceptPin(pin, 'deleted');
      else closeCard();
    } else {
      if (data.reply && card === instance) {
        appendReply(instance, data.reply);
        if (instance.reply.value === submittedReply) instance.reply.value = '';
      }
      if (data.pin) acceptPin(data.pin);
    }
    return true;
  } catch (error) { if (card === instance) setError(instance.error, error.message); return false; }
  finally { instance.busy = false; buttons.forEach(node => { node.disabled = false; }); }
}
// Go back (v3.5): an inline panel. Opening it closes the Not right box and the Delete confirm.
export function setBack(instance, open) {
  instance.backOpen = open;
  if (open) { instance.wrongOpen = false; instance.confirm.hidden = true; renderBack(instance); }
  refreshCard(instance, instance.pin);
  (open ? instance.backBox.querySelector(':checked') || instance.backBox.querySelector('.primary') : instance.back).focus();
}
function renderBack(instance) {
  const { now, ask, choices } = goBack(instance.pin);
  let question = el('p', '', ask);
  if (choices.length > 1) {
    question = el('fieldset');
    question.append(el('legend', '', ask));
    choices.forEach((choice, index) => {
      const label = el('label'), input = el('input');
      Object.assign(input, { type: 'radio', name: 'go-back', value: choice.commit, checked: index === choices.length - 1 });
      label.append(input, el('span', '', choice.label));
      question.append(label);
    });
  }
  const footer = el('div', 'panel-footer');
  footer.append(button('Keep the version that is live now', 'Keep', () => setBack(instance, false)), button('Start a run that ships the chosen version', 'Go back', async () => {
    const commit = instance.backBox.querySelector(':checked')?.value ?? choices.at(-1).commit;
    if (await cardAction(instance, 'POST', '/revert', { commit }) && card === instance) {
      announce(`Pin ${instance.id} goes back to the chosen version.`);
      instance.panel.focus({ preventScroll: true });
    }
  }, 'primary'));
  instance.backBox.replaceChildren(...(now ? [el('p', 'detail', now)] : []), question, footer);
}
export async function openCard(id, scroll = false) {
  closePopup(); closeCard(false); closeLog(); closeSettings(false);
  dropToast(`pin:${id}`);
  const instance = panelShell('thread', `Pin ${id}`, () => closeCard());
  Object.assign(instance, { id, replies: new Map(), busy: false, wrongOpen: false, backOpen: false, steps: [], count: pins.get(id)?.progress?.count || 0, timer: 0 });
  instance.status = el('span', 'status', 'Loading…');
  instance.accepted = el('span', 'accepted', 'Accepted'); instance.accepted.hidden = true;
  instance.tag = el('span', 'revert-tag'); instance.tag.hidden = true;
  for (const node of [instance.status, instance.accepted, instance.tag]) instance.head.insertBefore(node, instance.close);
  const body = el('div', 'panel-body');
  instance.note = el('p', 'note');
  instance.pinImages = el('div', 'images'); instance.pinImages.hidden = true;
  instance.question = el('p', 'question'); instance.question.hidden = true;
  instance.tags = el('div', 'tags'); instance.tags.hidden = true;
  instance.quote = el('blockquote', 'quote'); instance.quote.hidden = true;
  instance.target = el('p', 'target-label');
  instance.run = el('div', 'run'); instance.run.hidden = true;
  instance.elapsed = el('span', 'elapsed');
  instance.watch = link('Watch this run live', '', 'link watch', 'Watch live');
  instance.stepList = el('ol', 'steps');
  instance.stepList.setAttribute('aria-label', 'Steps of this run');
  const runHead = el('div', 'run-head');
  runHead.append(instance.elapsed, instance.watch);
  instance.run.append(runHead, instance.stepList);
  instance.shots = el('div', 'shots'); instance.shots.hidden = true;
  instance.summary = el('p', 'summary'); instance.summary.hidden = true;
  instance.agent = el('p', 'detail'); instance.agent.hidden = true;
  instance.commit = el('p', 'detail'); instance.commit.hidden = true;
  instance.editor = el('div'); instance.editor.hidden = true;
  instance.editInput = textarea('edit-note', 'Edit your note…');
  const saveEdit = async () => {
    const note = instance.editInput.value.trim();
    if (!note) { setError(instance.error, 'Add a note before saving.'); instance.editInput.focus(); return; }
    if (await cardAction(instance, 'PATCH', '', { note })) {
      instance.editor.hidden = true; instance.note.hidden = false; instance.edit.focus(); schedule();
    }
  };
  const editFooter = el('div', 'panel-footer');
  editFooter.append(button('Cancel the note edit', 'Cancel', () => { instance.editor.hidden = true; instance.note.hidden = false; instance.edit.focus(); schedule(); }), button('Save the edited note', 'Save', saveEdit, 'primary'));
  instance.editInput.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); saveEdit(); } });
  instance.editor.append(instance.editInput, editFooter);
  instance.list = el('ol', 'replies');
  instance.list.setAttribute('aria-label', 'Replies');
  instance.reply = textarea('pin-reply', 'Add a reply…');
  instance.error = errorNode('onspot-card-error');
  instance.reply.setAttribute('aria-describedby', instance.error.id);
  instance.replyForm = el('div', 'reply-form');
  instance.images = attachImages({ host: instance.replyForm, box: instance.reply, error: instance.error, kind: 'reply' });
  const sendReply = async () => {
    if (instance.images.busy()) { setError(instance.error, IMAGE_WAIT); return; }
    const images = instance.images.ids();
    const text = instance.reply.value.trim() || (images.length ? attachedReply(images.length) : '');
    if (!text) { setError(instance.error, instance.wrongOpen ? 'Write what is still wrong.' : 'Add a reply before sending.'); instance.reply.focus(); return; }
    const reopen = instance.wrongOpen;
    const payload = { body: text, ...(images.length ? { images } : {}), ...(reopen ? { reopen: true } : {}) };
    if (await cardAction(instance, 'POST', '/replies', payload)) {
      instance.images.clear();
      if (reopen) {
        instance.wrongOpen = false;
        announce(`Pin ${instance.id} goes back for another fix.`);
        if (instance.pin) refreshCard(instance, instance.pin);
      }
    }
  };
  instance.reply.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendReply(); } });
  const footer = el('div', 'panel-footer');
  instance.sendReply = button('Send your reply', 'Reply', sendReply, 'primary');
  footer.append(instance.images.button, instance.sendReply);
  instance.replyForm.append(instance.reply, instance.images.node, footer);
  body.append(instance.note, instance.pinImages, instance.question, instance.editor, instance.tags, instance.quote, instance.target, instance.run, instance.summary, instance.agent, instance.commit, instance.shots, instance.list, instance.replyForm, instance.error);
  const actions = el('div', 'actions');
  instance.see = button('Reload the page and show the change', 'See it', () => { if (instance.pin) seeIt(instance.pin); }, 'primary');
  // Looks good tells the server he accepts the result, then marks the pin seen, also when the call fails.
  instance.good = button('Accept this change', 'Looks good', async () => {
    const ok = await cardAction(instance, 'POST', '/accept', {});
    markSeen(id);
    if (ok) closeCard();
  });
  instance.wrong = button('Send this pin back for another fix', 'Not right', () => {
    instance.wrongOpen = true; instance.backOpen = false; instance.replyForm.hidden = false;
    if (instance.pin) refreshCard(instance, instance.pin);
    instance.reply.focus();
  });
  instance.edit = button('Edit this note', 'Edit', () => {
    instance.editInput.value = instance.pin.note; instance.editor.hidden = false; instance.note.hidden = true;
    instance.editInput.focus(); schedule();
  });
  instance.dismiss = button('Dismiss this pin', 'Dismiss', () => cardAction(instance, 'POST', '/dismiss', {}));
  instance.reopen = button('Reopen this pin', 'Reopen', () => cardAction(instance, 'POST', '/reopen', {}));
  instance.back = button('Go back to an earlier version of this element', 'Go back', () => setBack(instance, true));
  instance.backBox = el('div', 'go-back');
  for (const node of [instance.see, instance.good, instance.wrong, instance.back, instance.backBox, instance.edit, instance.dismiss, instance.reopen]) node.hidden = true;
  const confirm = instance.confirm = el('div', 'confirm'); confirm.hidden = true;
  const deleteButton = button('Delete this pin', 'Delete', () => {
    if (instance.backOpen) setBack(instance, false);
    confirm.hidden = false; confirmDelete.focus(); schedule();
  }, 'danger');
  instance.delete = deleteButton;
  const confirmDelete = button('Confirm deletion of this pin', 'Delete pin', () => cardAction(instance, 'DELETE'), 'danger');
  confirm.append(el('span', '', 'Delete this pin?'), button('Keep this pin', 'Cancel', () => { confirm.hidden = true; deleteButton.focus(); schedule(); }), confirmDelete);
  actions.append(instance.see, instance.good, instance.wrong, instance.back, instance.edit, instance.dismiss, instance.reopen, deleteButton);
  instance.panel.append(body, actions, instance.backBox, confirm);
  card = instance;
  instance.panel.querySelectorAll('button').forEach(node => { if (node !== instance.close) node.disabled = true; });
  if (pins.has(id)) refreshCard(instance, pins.get(id));
  syncWatchers(); schedule();
  instance.close.focus({ preventScroll: true });
  await loadCard(instance);
  if (card !== instance) return;
  if (instance.pin?.status === 'waiting') instance.reply.focus({ preventScroll: true });
  if (scroll && instance.pin) {
    const target = instance.pin.targets[0], element = resolveTarget(target);
    if (element) element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    else window.scrollTo({ left: target.rect?.x || 0, top: Math.max(0, (target.rect?.y || 0) - innerHeight / 3), behavior: 'instant' });
    if (instance.pin.status === 'done') showFlash(target, element);
    schedule();
  }
}
export function closeCard(restoreFocus = true) {
  if (!card) return;
  const previous = card; card = null; previous.panel.remove();
  clearInterval(previous.timer);
  // Closing a done pin's card means it was looked at: its green marker can go.
  if (previous.pin?.status === 'done') markSeen(previous.id);
  if (restoreFocus) (markers.get(String(previous.id))?.node || pinButton).focus({ preventScroll: true });
  syncWatchers(); schedule();
}
