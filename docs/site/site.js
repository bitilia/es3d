// Behaviour shared by the pages built from the site partials. Each part only
// adds to a page that already works without script.

const SCROLLER = 'data-scroll-focus';

/**
 * A code block or table wider than the column scrolls sideways, and a
 * keyboard can only scroll what it can focus. Whatever overflows gets a tab
 * stop (a table also gets a name), and loses it when a wider window shows it
 * whole, so short blocks add no tab stops.
 */
function focusableScrollers(root = document) {
  const boxes = root.querySelectorAll('main pre, main .table-wrap');
  if (!boxes.length || typeof ResizeObserver !== 'function') return;
  const update = (el) => {
    const scrolls = el.scrollWidth > el.clientWidth + 1;
    if (scrolls && !el.hasAttribute('tabindex')) {
      el.setAttribute('tabindex', '0');
      el.setAttribute(SCROLLER, '');
      if (el.classList.contains('table-wrap')) {
        el.setAttribute('role', 'region');
        el.setAttribute('aria-label', tableName(el));
      }
    } else if (!scrolls && el.hasAttribute(SCROLLER)) {
      for (const a of ['tabindex', SCROLLER, 'role', 'aria-label']) el.removeAttribute(a);
    }
  };
  const ro = new ResizeObserver((entries) => entries.forEach((e) => update(e.target)));
  boxes.forEach((el) => ro.observe(el));
}

/**
 * "Table: <the heading above it>", numbered when one heading has several
 * tables ("Table 2 of 2: ..."), so each name is different.
 */
function tableName(wrap) {
  const isHeading = (el) => /^H[1-6]$/.test(el.tagName);
  const isTable = (el) => el.classList.contains('table-wrap');
  let heading = null;
  let index = 1;
  for (let el = wrap.previousElementSibling; el && !heading; el = el.previousElementSibling) {
    if (isHeading(el)) heading = el;
    else if (isTable(el)) index++;
  }
  let count = index;
  for (let el = wrap.nextElementSibling; el && !isHeading(el); el = el.nextElementSibling) if (isTable(el)) count++;
  const name = heading ? heading.textContent.trim() : document.title;
  return count > 1 ? `Table ${index} of ${count}: ${name}` : `Table: ${name}`;
}

/**
 * On a phone the site navigation folds behind a Menu button that names the
 * current page. Without this script the links are all listed instead.
 */
function phoneMenu() {
  const nav = document.querySelector('.nav');
  const button = nav && nav.querySelector('.nav-toggle');
  if (!button) return;
  const current = nav.querySelector('a[aria-current="page"]');
  const label = button.querySelector('.nav-toggle-current');
  if (current && label) {
    const name = current.firstChild.textContent.trim();
    label.textContent = name;
    button.setAttribute('aria-label', `Menu, current page: ${name}`);
  }
  const setOpen = (open) => {
    nav.classList.toggle('open', open);
    button.setAttribute('aria-expanded', String(open));
  };
  nav.classList.add('collapsible');
  button.addEventListener('click', () => setOpen(!nav.classList.contains('open')));
  nav.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && nav.classList.contains('open')) {
      setOpen(false);
      button.focus();
    }
  });
}

/**
 * Blubert, a rag doll who peeks out from behind the page now and then (blubert.js).
 * Loaded once the page is idle, and only with motion allowed and enough
 * margin beside the panel for him to stand in.
 */
function blubert() {
  const param = new URLSearchParams(location.search).get('blubert');
  if (param === 'off') return;
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const panel = document.querySelector('.site');
  if (!panel || (reduced && !param)) return;
  const roomy = () => window.innerWidth - panel.getBoundingClientRect().width >= 2 * 96;
  let started = false;
  const start = () => {
    if (started || !roomy()) return;
    started = true;
    removeEventListener('resize', start);
    import('./blubert.js').then((m) => m.startBlubert({ only: param })).catch(() => {});
  };
  const whenIdle = () => (typeof requestIdleCallback === 'function' ? requestIdleCallback(start, { timeout: 5000 }) : setTimeout(start, 2000));
  const later = () => setTimeout(whenIdle, param ? 0 : 2500);
  if (document.readyState === 'complete') later();
  else addEventListener('load', later, { once: true });
  // a window made wider later gets him too
  addEventListener('resize', start, { passive: true });
}

/**
 * A link to something inside a closed fold (an element of the reference, a
 * question of the FAQ) opens that fold first, so the target can be seen.
 */
function openFoldsForLinks() {
  const reveal = () => {
    const id = decodeURIComponent(location.hash.slice(1));
    const target = id && document.getElementById(id);
    if (!target) return;
    let opened = false;
    for (let el = target; el; el = el.parentElement) {
      if (el.tagName === 'DETAILS' && !el.open) {
        el.open = true;
        opened = true;
      }
    }
    if (opened) target.scrollIntoView();
  };
  addEventListener('hashchange', reveal);
  reveal();
}

focusableScrollers();
phoneMenu();
openFoldsForLinks();
blubert();
