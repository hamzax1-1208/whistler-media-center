'use strict';
/* start-screen.js — the first screen: the start menu with its five entries, the clock,
   and in the Whistler theme the Luna user band with the display name. */

/** @returns {object} the start screen */
function createStartScreen() {
  const entries = [
    { label: 'My Videos', icon: 'film', open: () => openScreen(createVideosScreen()) },
    { label: 'My Music', icon: 'note', open: () => openScreen(createMusicScreen()) },
    { label: 'My Pictures', icon: 'picture', open: () => openScreen(createPicturesScreen()) },
    { label: 'My Computer', icon: 'drive', open: () => openScreen(createComputerScreen()) },
    { label: 'Settings', icon: 'gear', open: () => openScreen(createSettingsScreen()) },
  ];
  const screen = { focusedIndex: 0, clockTimer: 0, element: null };

  /** Writes the date and time; runs once a second while the screen is showing. */
  function updateClock() {
    if (!screen.element || !screen.element.isConnected) return;
    const now = new Date();
    const dateElement = selectElement('.clock-date', screen.element);
    const timeElement = selectElement('.clock-time', screen.element);
    dateElement.textContent = now.toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });
    dateElement.dateTime = now.toISOString().slice(0, 10);
    timeElement.textContent = now.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      hour12: !getSetting('clock24'),
    });
  }

  /** Moves the highlight and swaps the large ghosted icon behind the menu to match it. */
  function paint() {
    const entryElements = screen.element.querySelectorAll('.start-entry');
    entryElements.forEach((entryElement, index) => {
      entryElement.classList.toggle('is-focused', index === screen.focusedIndex);
    });
    setIcon(selectElement('.home-ghost', screen.element), entries[screen.focusedIndex].icon);
  }

  screen.render = () => {
    const element = cloneTemplate('start-screen-template');
    screen.element = element;
    selectElement('.user-name', element).textContent = getSetting('displayName');
    const sourceNote = mediaSource.local ? 'reading your folders in the browser' : 'server mode';
    selectElement('.status-line', element).textContent =
      `Whistler Media Center · ${sourceNote} · T switches theme`;

    const menu = selectElement('.start-menu', element);
    entries.forEach((entry, index) => {
      const entryElement = cloneTemplate('start-entry-template');
      setIcon(selectElement('.start-entry-icon', entryElement), entry.icon);
      selectElement('.start-entry-label', entryElement).textContent = entry.label;
      entryElement.addEventListener('mouseenter', () => {
        screen.focusedIndex = index;
        paint();
      });
      entryElement.addEventListener('click', () => {
        screen.focusedIndex = index;
        paint();
        entry.open();
      });
      menu.appendChild(entryElement);
    });

    mountScreen(element);
    paint();
    updateClock();
    clearInterval(screen.clockTimer);
    screen.clockTimer = setInterval(updateClock, 1000);
  };

  /**
   * The menu is a column in the canvas themes and a row in the fluid layouts, so the
   * arrow keys that move along it change with the layout.
   */
  screen.handleKey = (keyName) => {
    const isRow = !currentLayout().fixedCanvas && !isCompactLayout();
    const previousKey = isRow ? 'left' : 'up';
    const nextKey = isRow ? 'right' : 'down';
    const openKey = isRow ? 'down' : 'right';
    switch (keyName) {
      case previousKey:
        screen.focusedIndex = Math.max(0, screen.focusedIndex - 1);
        break;
      case nextKey:
        screen.focusedIndex = Math.min(entries.length - 1, screen.focusedIndex + 1);
        break;
      case 'enter':
      case 'space':
      case openKey:
        entries[screen.focusedIndex].open();
        return true;
      default:
        return false;
    }
    paint();
    return true;
  };

  screen.leave = () => clearInterval(screen.clockTimer);

  return screen;
}
