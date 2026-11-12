'use strict';
/* browse-screen.js — the screen that My Videos, My Music, My Pictures, My Computer and
   Settings are all made of: commands ("modes") in one column, tiles or rows in the other,
   one highlight that the arrow keys move between them.

   A screen is described by a spec object:
     watermark      the big faded word behind the content
     sectionLabel   small heading above the commands
     title          [main, sub] shown while the highlight is on a command
     view           'tiles' or 'rows'
     numbered       rows only: true for an ordered list (episodes, tracks)
     modes          [{ label, isOn, run }]            isOn: undefined = no dot
     items          [{ label, sub, value, meta, kind, number, mark, isPlaying,
                       thumb, mosaic, badge, progress, title, run }]
                    mark ('full', 'half' or null) and isPlaying may be functions: they are
                    then read every time the row is drawn, so they are never out of date
     loading        text shown while the items are being found
     empty          { title, hint } or a string, shown when there are no items
     status         one line at the bottom
     extra          function returning an element to add (the About page)
     searchable     true adds a Search command
     heroUrl        picture behind the title in the Netflix theme                        */

/**
 * Creates a browse screen.
 * @param {object} initialSpec see the list above
 * @returns {object} the screen: render, handleKey, updateSpec, repaintItems, paint ...
 */
function createBrowseScreen(initialSpec) {
  const screen = {
    spec: { ...initialSpec },
    focusColumn: 'items', // which side has the highlight: 'items' or 'modes'
    itemIndex: 0,
    modeIndex: 0,
    searchQuery: '',
    element: null,
    itemHost: null,
    renderedPage: -1,
    modesFocusedBecauseEmpty: false,
  };

  // ---------------------------------------------------------------- what is on screen

  const isTileView = () => screen.spec.view === 'tiles';
  const pageSize = () =>
    isTileView() ? currentLayout().tilesPerPage : currentLayout().rowsPerPage;
  const currentPage = () => Math.floor(screen.itemIndex / pageSize());

  /** @returns {boolean} whether an item contains the search text in any of its labels */
  function itemMatchesQuery(item, query) {
    const texts = [item.label, item.sub, ...(item.title || [])];
    return texts.some((text) => typeof text === 'string' && text.toLowerCase().includes(query));
  }

  let filterCache = { items: null, query: '', matches: [] };

  /** The items to show: all of them, or the ones that match the search. */
  function visibleItems() {
    const items = screen.spec.items || [];
    if (!screen.searchQuery) return items;
    if (filterCache.items !== items || filterCache.query !== screen.searchQuery) {
      filterCache = {
        items,
        query: screen.searchQuery,
        matches: items.filter((item) => itemMatchesQuery(item, screen.searchQuery)),
      };
    }
    return filterCache.matches;
  }

  /** The commands to show: the screen's own, plus the search command where it applies. */
  function visibleModes() {
    const modes = [...(screen.spec.modes || [])];
    if (screen.searchQuery) {
      modes.unshift({ label: 'Clear search', run: clearSearch });
    } else if (screen.spec.searchable && (screen.spec.items || []).length > 0) {
      modes.push({ label: 'Search…', run: openSearch });
    }
    return modes;
  }

  /** How many tiles sit side by side, measured from the grid the stylesheet laid out. */
  function columnCount() {
    if (!isTileView()) return 1;
    if (screen.itemHost && screen.itemHost.isConnected) {
      const tracks = getComputedStyle(screen.itemHost).gridTemplateColumns;
      const measuredColumns = tracks === 'none' ? 0 : tracks.split(' ').filter(Boolean).length;
      if (measuredColumns > 0) return measuredColumns;
    }
    return currentLayout().columns;
  }

  // ---------------------------------------------------------------- search

  async function openSearch() {
    const result = await formPanel.openSearch(screen.searchQuery);
    if (!result) return;
    screen.searchQuery = result.query.toLowerCase();
    screen.itemIndex = 0;
    screen.focusColumn = 'items';
    screen.render();
    const matchCount = visibleItems().length;
    showToast(
      matchCount > 0
        ? `${matchCount} found for "${result.query}"`
        : `Nothing matches "${result.query}"`,
    );
  }

  function clearSearch() {
    screen.searchQuery = '';
    screen.itemIndex = 0;
    screen.modeIndex = 0;
    screen.render();
  }

  // ---------------------------------------------------------------- building the parts

  /** Moves the highlight to an item (mouse hover or click). */
  function focusItem(index) {
    screen.focusColumn = 'items';
    screen.itemIndex = index;
    paint();
  }

  /** Moves the highlight to a command (mouse hover or click). */
  function focusMode(index) {
    screen.focusColumn = 'modes';
    screen.modeIndex = index;
    paint();
  }

  function renderModes() {
    const modeList = selectElement('.mode-list', screen.element);
    modeList.replaceChildren();
    visibleModes().forEach((mode, index) => {
      const modeItem = cloneTemplate('mode-template');
      selectElement('.mode-label', modeItem).textContent = mode.label;
      if (mode.isOn !== undefined) {
        const dot = selectElement('.mode-dot', modeItem);
        dot.hidden = false;
        dot.classList.toggle('is-on', Boolean(mode.isOn));
      }
      modeItem.addEventListener('mouseenter', () => focusMode(index));
      modeItem.addEventListener('click', () => {
        focusMode(index);
        screen.activate();
      });
      modeList.appendChild(modeItem);
    });
  }

  /** Alternative text for a tile's picture. */
  function describeThumbnail(item) {
    switch (item.kind) {
      case 'video':
        return `Frame from ${item.label}`;
      case 'album':
        return `Cover of ${item.label}`;
      default:
        return item.label;
    }
  }

  /** Up to four pictures in a 2x2 contact sheet (picture folders). */
  function createMosaic(item, imageTemplate) {
    const mosaic = createElement('div', 'tile-mosaic');
    const pictureUrls = item.mosaic.slice(0, 4);
    pictureUrls.forEach((url, index) => {
      const image = imageTemplate.cloneNode(false);
      image.alt = `${item.label}, picture ${index + 1}`;
      image.hidden = false;
      image.addEventListener('error', () => image.remove());
      image.src = url;
      mosaic.appendChild(image);
    });
    if (pictureUrls.length === 1) {
      mosaic.style.gridTemplateColumns = '1fr';
      mosaic.style.gridTemplateRows = '1fr';
    }
    return mosaic;
  }

  function createTile(item) {
    const tile = cloneTemplate('tile-template');
    const thumb = selectElement('.tile-thumb', tile);
    const image = selectElement('.tile-image', tile);
    const glyph = selectElement('.tile-glyph', tile);
    setIcon(glyph, iconNameForKind(item.kind));

    const showImage = (url) => {
      image.alt = describeThumbnail(item);
      image.src = url;
      image.hidden = false;
      glyph.hidden = true;
      item.heroUrl = url;
    };
    // a picture that will not load falls back to the icon
    image.addEventListener('error', () => {
      image.hidden = true;
      glyph.hidden = false;
    });

    if (Array.isArray(item.mosaic) && item.mosaic.length > 0) {
      thumb.insertBefore(createMosaic(item, image), image);
      glyph.hidden = true;
      item.heroUrl = item.mosaic[0];
    } else if (typeof item.thumb === 'string') {
      showImage(item.thumb);
    } else if (typeof item.thumb === 'function') {
      if (item.heroUrl) {
        showImage(item.heroUrl);
      } else {
        // the picture is made in the background (a video frame, an embedded cover)
        Promise.resolve(item.thumb())
          .then((url) => {
            if (!url) return;
            item.heroUrl = url;
            if (!tile.isConnected) return;
            showImage(url);
            if (screen.focusColumn === 'items' && visibleItems()[screen.itemIndex] === item)
              paintHero();
          })
          .catch((error) => reportProblem(`Loading the picture of ${item.label}`, error));
      }
    }

    setOptionalText(selectElement('.tile-badge', tile), item.badge);
    if (item.progress) {
      selectElement('.tile-progress', tile).hidden = false;
      selectElement('.tile-progress-fill', tile).style.width = `${item.progress * 100}%`;
    }
    selectElement('.tile-caption', tile).textContent = item.label;
    return tile;
  }

  /** Reads a value that may be given directly or as a function returning it. */
  const currentValue = (valueOrFunction) =>
    typeof valueOrFunction === 'function' ? valueOrFunction() : valueOrFunction;

  function createRow(item) {
    const row = cloneTemplate('row-template');
    const mark = currentValue(item.mark);
    if (mark) {
      const markDot = selectElement('.row-mark-dot', row);
      markDot.hidden = false;
      markDot.classList.toggle('is-partial', mark === 'half');
    }
    const icon = selectElement('.row-icon', row);
    if (item.number !== null && item.number !== undefined) {
      icon.appendChild(createElement('span', 'row-number', item.number));
    } else {
      setIcon(icon, iconNameForKind(item.kind));
    }
    selectElement('.row-text', row).textContent = item.label;
    setOptionalText(selectElement('.row-sub', row), item.sub);
    setOptionalText(selectElement('.row-value', row), item.value);
    setOptionalText(selectElement('.row-meta', row), item.meta);
    row.classList.toggle('is-playing', Boolean(currentValue(item.isPlaying)));
    return row;
  }

  /** Draws the items of the current page and updates the page arrows. */
  function renderItems() {
    const items = visibleItems();
    const itemsPerPage = pageSize();
    const page = currentPage();
    const firstIndex = page * itemsPerPage;
    const host = screen.itemHost;
    screen.renderedPage = page;

    host.replaceChildren();
    if (host instanceof HTMLOListElement) host.start = firstIndex + 1;
    items.slice(firstIndex, firstIndex + itemsPerPage).forEach((item, offset) => {
      const index = firstIndex + offset;
      const itemElement = isTileView() ? createTile(item) : createRow(item);
      itemElement.addEventListener('mouseenter', () => focusItem(index));
      itemElement.addEventListener('click', () => {
        focusItem(index);
        screen.activate();
      });
      host.appendChild(itemElement);
    });

    const pageCount = Math.max(1, Math.ceil(items.length / itemsPerPage));
    selectElement('.paging', screen.element).hidden = items.length === 0;
    selectElement('.paging-up', screen.element).disabled = page === 0;
    selectElement('.paging-down', screen.element).disabled = page >= pageCount - 1;
  }

  /** Shows the "nothing here" text that fits: no matches, or the screen's own. */
  function renderEmptyNote() {
    let note = screen.spec.empty;
    if (screen.searchQuery) {
      note = {
        title: `Nothing matches "${screen.searchQuery}".`,
        hint: 'Choose Clear search to see everything again.',
      };
    }
    if (!note) return;
    if (typeof note === 'string') note = { title: note, hint: '' };
    selectElement('.empty-note', screen.element).hidden = false;
    selectElement('.empty-title', screen.element).textContent = note.title;
    setOptionalText(selectElement('.empty-hint', screen.element), note.hint);
  }

  /** The picture of the focused tile, as a CSS variable the Netflix theme puts behind the title. */
  function paintHero() {
    if (!screen.element) return;
    const focusedItem = screen.focusColumn === 'items' ? visibleItems()[screen.itemIndex] : null;
    const heroUrl = (focusedItem && focusedItem.heroUrl) || screen.spec.heroUrl;
    screen.element.style.setProperty('--hero', heroUrl ? `url("${heroUrl}")` : 'none');
  }

  /**
   * Updates the highlight, the title block and the "3 of 12" counter. Cheap: it only redraws
   * the items when the highlight moved to another page.
   * @param {object} [options]
   * @param {boolean} [options.reveal] scroll the highlighted part into view (keyboard moves)
   */
  function paint({ reveal = false } = {}) {
    if (!screen.element) return;
    if (currentPage() !== screen.renderedPage) renderItems();
    const items = visibleItems();
    const firstIndex = currentPage() * pageSize();
    const scrollsFreely = reveal && !currentLayout().fixedCanvas;

    [...screen.itemHost.children].forEach((itemElement, offset) => {
      const isFocused = screen.focusColumn === 'items' && firstIndex + offset === screen.itemIndex;
      itemElement.classList.toggle('is-focused', isFocused);
      if (isFocused && scrollsFreely) itemElement.scrollIntoView({ block: 'nearest' });
    });

    const modeList = selectElement('.mode-list', screen.element);
    [...modeList.children].forEach((modeItem, index) => {
      const isFocused = screen.focusColumn === 'modes' && index === screen.modeIndex;
      modeItem.classList.toggle('is-focused', isFocused);
      if (isFocused && scrollsFreely)
        modeItem.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    // the command column goes a shade darker while the highlight is among the items
    modeList.classList.toggle('is-dormant', screen.focusColumn !== 'modes');

    const focusedItem = screen.focusColumn === 'items' ? items[screen.itemIndex] : null;
    let titleLines = screen.spec.title || ['', ''];
    if (focusedItem) titleLines = focusedItem.title || [focusedItem.label, focusedItem.sub || ''];
    else if (screen.searchQuery)
      titleLines = [`Results for "${screen.searchQuery}"`, `${items.length} found`];
    selectElement('.title-main', screen.element).textContent = titleLines[0] || '';
    selectElement('.title-sub', screen.element).textContent = titleLines[1] || '';

    const position = items.length > 0 ? `${screen.itemIndex + 1} of ${items.length}` : '';
    selectElement('.paging-count', screen.element).textContent = position;
    paintHero();
  }

  // ---------------------------------------------------------------- the screen's functions

  /** Builds the whole screen from the template in index.html and puts it on the stage. */
  screen.render = () => {
    const spec = screen.spec;
    const element = cloneTemplate('browse-screen-template');
    screen.element = element;
    selectElement('.watermark', element).textContent = spec.watermark || '';
    selectElement('.section-label', element).textContent = spec.sectionLabel || '';
    renderModes();

    // tiles go in the <section>, rows in the <ul>, numbered rows in the <ol>
    let hostSelector = 'ul.row-list';
    if (isTileView()) hostSelector = '.tile-grid';
    else if (spec.numbered) hostSelector = 'ol.row-list';
    screen.itemHost = selectElement(hostSelector, element);
    screen.itemHost.hidden = false;

    const items = visibleItems();
    const modeCount = visibleModes().length;
    screen.itemIndex = clamp(screen.itemIndex, 0, Math.max(0, items.length - 1));
    screen.modeIndex = clamp(screen.modeIndex, 0, Math.max(0, modeCount - 1));
    if (spec.loading) setOptionalText(selectElement('.loading-note', element), spec.loading);
    else if (items.length === 0) renderEmptyNote();
    if (spec.extra) element.insertBefore(spec.extra(), selectElement('.screen-footer', element));

    let statusText = spec.status || '';
    if (screen.searchQuery) {
      statusText = `Search: "${screen.searchQuery}" · ${items.length} of ${(spec.items || []).length}`;
    }
    selectElement('.status-line', element).textContent = statusText;

    // with nothing to select on the right, the highlight starts on the commands
    if (items.length === 0 && modeCount > 0) {
      screen.focusColumn = 'modes';
      screen.modesFocusedBecauseEmpty = true;
    } else if (items.length > 0 && screen.modesFocusedBecauseEmpty) {
      screen.focusColumn = 'items';
      screen.modesFocusedBecauseEmpty = false;
    }

    selectElement('.paging-up', element).addEventListener('click', () => movePage('pgup'));
    selectElement('.paging-down', element).addEventListener('click', () => movePage('pgdn'));

    mountScreen(element);
    renderItems();
    paint();
  };

  /**
   * Changes parts of the spec. The screen is drawn again only while it is the one on show:
   * a screen that is still loading in the background must not draw itself over another.
   * @param {object} changes for example { items, modes }
   */
  screen.updateSpec = (changes) => {
    Object.assign(screen.spec, changes);
    if (currentScreen === screen) screen.render();
  };

  /** Draws the items again without rebuilding the rest (a row started or stopped playing). */
  screen.repaintItems = () => {
    if (!screen.element) return;
    renderItems();
    paint();
  };

  screen.paint = paint;

  /** Page arrows (mouse and touch). */
  function movePage(keyName) {
    screen.focusColumn = 'items';
    move(keyName);
  }

  /**
   * Moves the highlight among the items.
   * @returns {boolean} false when the key does nothing here
   */
  function moveAmongItems(keyName, itemCount, modeCount) {
    if (itemCount === 0) return false;
    const columns = columnCount();
    const itemsPerPage = pageSize();
    const index = screen.itemIndex;
    const fixedCanvas = currentLayout().fixedCanvas;
    switch (keyName) {
      case 'up':
        if (index - columns >= 0) screen.itemIndex -= columns;
        else if (!fixedCanvas && modeCount > 0)
          screen.focusColumn = 'modes'; // the commands are a bar on top
        else if (columns > 1 && index > 0) screen.itemIndex = 0;
        else return false;
        return true;
      case 'down':
        if (index + columns < itemCount) screen.itemIndex += columns;
        else if (index < itemCount - 1) screen.itemIndex = itemCount - 1;
        else return false;
        return true;
      case 'left':
        if (columns > 1 && index % columns !== 0) screen.itemIndex--;
        else if (fixedCanvas && modeCount > 0)
          screen.focusColumn = 'modes'; // the commands are a column on the left
        else return false;
        return true;
      case 'right':
        if (columns > 1 && index % columns !== columns - 1 && index < itemCount - 1)
          screen.itemIndex++;
        else return false;
        return true;
      case 'pgdn':
        screen.itemIndex = Math.min(
          itemCount - 1,
          (Math.floor(index / itemsPerPage) + 1) * itemsPerPage,
        );
        return true;
      case 'pgup':
        screen.itemIndex = Math.max(0, (Math.floor(index / itemsPerPage) - 1) * itemsPerPage);
        return true;
      case 'end':
        screen.itemIndex = itemCount - 1;
        return true;
      default:
        return false;
    }
  }

  /**
   * Moves the highlight among the commands. They form a column in the canvas themes and a
   * bar across the top in the fluid layouts, so the arrow keys swap roles.
   */
  function moveAmongModes(keyName, itemCount, modeCount) {
    const isBar = !currentLayout().fixedCanvas;
    const previousKey = isBar ? 'left' : 'up';
    const nextKey = isBar ? 'right' : 'down';
    const toItemsKey = isBar ? 'down' : 'right';
    if (keyName === previousKey) screen.modeIndex = Math.max(0, screen.modeIndex - 1);
    else if (keyName === nextKey) screen.modeIndex = Math.min(modeCount - 1, screen.modeIndex + 1);
    else if (keyName === toItemsKey && itemCount > 0) screen.focusColumn = 'items';
    else return false;
    return true;
  }

  function move(keyName) {
    const itemCount = visibleItems().length;
    const modeCount = visibleModes().length;
    const moved =
      screen.focusColumn === 'modes'
        ? moveAmongModes(keyName, itemCount, modeCount)
        : moveAmongItems(keyName, itemCount, modeCount);
    if (moved) paint({ reveal: true });
    return moved;
  }

  /** Runs the highlighted command or item (Enter). */
  screen.activate = () => {
    if (screen.focusColumn === 'modes') {
      const mode = visibleModes()[screen.modeIndex];
      if (mode && mode.run) mode.run(screen, mode);
      return true;
    }
    const item = visibleItems()[screen.itemIndex];
    if (item && item.run) item.run(item, screen, screen.itemIndex);
    return true;
  };

  /**
   * @param {string} keyName
   * @returns {boolean} true when the key was used
   */
  screen.handleKey = (keyName) => {
    switch (keyName) {
      case 'enter':
      case 'space':
        return screen.activate();
      case 'back':
        // Back leaves a search before it leaves the screen
        if (screen.searchQuery) clearSearch();
        else goBack();
        return true;
      case '/':
        openSearch();
        return true;
      default:
        return move(keyName);
    }
  };

  return screen;
}
