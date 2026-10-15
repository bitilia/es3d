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

focusableScrollers();
phoneMenu();
