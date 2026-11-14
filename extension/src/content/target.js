const ATTRS = ['class', 'id', 'role', 'aria-label', 'href', 'src', 'alt', 'name', 'type', 'placeholder', 'data-testid', 'data-slot', 'data-component', 'title'];
const compact = value => String(value ?? '').replace(/\s+/g, ' ').trim();

export function parentElement(el) {
  return el?.parentElement || el?.getRootNode().host || null;
}

// The id attribute, not the `id` property: on a form, a field named "id" replaces that property.
const idOf = el => el.getAttribute('id');

export function shortName(el) {
  const tag = el.localName, id = idOf(el);
  if (id) return `${tag}#${id}`.slice(0, 100);
  const name = el.classList?.item(0);
  return (name ? `${tag}.${name}` : tag).slice(0, 100);
}

export function labelFor(el) {
  const text = compact(el.localName === 'img' ? el.getAttribute('alt') : el.innerText);
  return (text ? `${el.localName} "${text}"` : shortName(el)).slice(0, 160);
}

function unique(root, selector, el) {
  try {
    return root.querySelector(selector) === el && root.querySelectorAll(selector).length === 1;
  } catch { return false; }
}

// Each candidate is checked against the live DOM, including duplicate IDs.
export function selectorInRoot(el, root = el.getRootNode()) {
  let tail = '';
  for (let node = el; node && node !== root; node = node.parentElement) {
    const anchors = [];
    const id = idOf(node);
    if (id) anchors.push(`#${CSS.escape(id)}`);
    const testId = node.getAttribute('data-testid');
    if (testId) anchors.push(`[data-testid="${CSS.escape(testId)}"]`);
    const tag = CSS.escape(node.localName);
    const classes = Array.from(node.classList).slice(0, 2).map(c => `.${CSS.escape(c)}`).join('');
    anchors.push(tag + classes);
    let nth = 1;
    for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
      if (sibling.localName === node.localName) nth++;
    }
    const segment = `${tag}${classes}:nth-of-type(${nth})`;
    anchors.push(segment);
    for (const anchor of anchors) {
      const candidate = anchor + tail;
      if (candidate.length <= 500 && unique(root, candidate, el)) return candidate;
    }
    tail = ` > ${segment}${tail}`;
  }
  throw new Error('This element needs a shorter unique selector.');
}

// Inside an open shadow root the selector is "host selector >>> inner selector"; each part
// is relative to the shadow root of the element the previous part matched.
export function selectorFor(el) {
  const root = el.getRootNode();
  const selector = root === document ? selectorInRoot(el, document)
    : root.host ? `${selectorFor(root.host)} >>> ${selectorInRoot(el, root)}`
    : null;
  if (!selector || selector.length > 500) throw new Error('This element needs a shorter unique selector.');
  return selector;
}

export function resolveTarget(target) {
  try {
    let scope = document, node = null;
    for (const part of target.selector.split(' >>> ')) {
      node = scope?.querySelector(part) ?? null;
      scope = node?.shadowRoot;
    }
    return node;
  } catch { return null; }
}

export function describeTarget(el) {
  if (!el.isConnected) throw new Error('The selected element is no longer on this page.');
  const box = el.getBoundingClientRect();
  const css = getComputedStyle(el);
  const styles = {
    font: css.font || `${css.fontWeight} ${css.fontSize} / ${css.lineHeight} ${css.fontFamily}`,
    color: css.color, background: css.backgroundColor, margin: css.margin,
    padding: css.padding, display: css.display, gap: css.gap, radius: css.borderRadius,
  };
  if (['img', 'video', 'audio', 'canvas', 'svg'].includes(el.localName)) {
    styles.width = css.width;
    styles.height = css.height;
  }
  if (css.opacity !== '1') styles.opacity = css.opacity;
  const attrs = {};
  for (const key of ATTRS) {
    if (el.hasAttribute(key)) attrs[key] = el.getAttribute(key).slice(0, 1000);
  }
  const ancestors = [];
  for (let node = parentElement(el); node && ancestors.length < 6; node = parentElement(node)) {
    if (node.localName === 'html' || node.localName === 'body') continue;
    ancestors.push(shortName(node));
  }
  return {
    selector: selectorFor(el), label: labelFor(el), tag: el.localName,
    text: compact(el.innerText).slice(0, 300), attrs,
    rect: { x: Math.round(box.left + scrollX), y: Math.round(box.top + scrollY), w: Math.round(box.width), h: Math.round(box.height) },
    styles, ancestors,
  };
}

export function elementAt(x, y, host) {
  let el = document.elementsFromPoint(x, y).find(node => node !== host && !host.contains(node));
  const visited = new Set();
  while (el?.shadowRoot && !visited.has(el)) {
    visited.add(el);
    const root = el.shadowRoot;
    const next = root.elementsFromPoint?.(x, y).find(node => node !== el && node.getRootNode() === root)
      || root.elementFromPoint?.(x, y);
    if (!next || next === el) break;
    el = next;
  }
  return el || null;
}
