'use strict';
/* state.js — what the app remembers between visits: settings, library folders and resume
   points, plus the themes and the layout numbers that go with them. */

/** Where the media comes from (js/source.js). Chosen once at boot in js/main.js. */
let mediaSource = null;

/** Everything that is saved. Replaced at boot by what the source has stored. */
let appState = {
  roots: { videos: [], music: [], pictures: [] },
  resume: {},
  settings: {},
};

const DEFAULT_SETTINGS = {
  displayName: 'Whistler',
  clock24: false,
  slideshowSeconds: 5,
  kenBurns: true,
  visualizer: true,
  autoplayNext: true,
  roast: true,
  theme: '2002',
  subtitles: 'auto',
  subtitleLang: 'eng',
  subtitleSize: 'normal',
  sounds: true,
  volume: 100,
};

/**
 * Reads one setting, falling back to its default.
 * @param {keyof typeof DEFAULT_SETTINGS} name
 */
function getSetting(name) {
  const storedValue = appState.settings[name];
  return storedValue === undefined ? DEFAULT_SETTINGS[name] : storedValue;
}

/**
 * Sends a change to the source's storage and tells the user if that fails.
 * @param {object} change the patch understood by mediaSource.saveState
 * @param {string} failureMessage what to show when saving fails
 * @returns {Promise<boolean>} whether the change was saved
 */
async function persistState(change, failureMessage) {
  try {
    await mediaSource.saveState(change);
    return true;
  } catch (error) {
    reportProblem('Saving state', error);
    showToast(failureMessage, 2500);
    return false;
  }
}

/**
 * Changes one or more settings and saves them.
 * @param {object} changes for example { theme: 'netflix' }
 * @returns {Promise<boolean>} whether they were saved
 */
function saveSettings(changes) {
  Object.assign(appState.settings, changes);
  return persistState({ settings: changes }, 'Your settings could not be saved');
}

/** Saves the library folder lists after one of them changed. */
function saveRoots() {
  return persistState({ roots: appState.roots }, 'Your library folders could not be saved');
}

/**
 * Remembers where a video was stopped, or that it was watched to the end.
 * @param {string} path the video's path
 * @param {{ t: number, done: boolean }} record seconds played and the watched flag
 */
function saveResumePoint(path, record) {
  appState.resume[path] = record;
  return persistState({ resume: { [path]: record } }, 'The resume point could not be saved');
}

/** Forgets the resume point of one video. */
function clearResumePoint(path) {
  delete appState.resume[path];
  return persistState({ clearResume: path }, 'The resume point could not be cleared');
}

// ---------------------------------------------------------------- themes and layout
// tilesPerPage / rowsPerPage: how many items one page of a browse screen holds.
// columns: tiles per row, used when the grid is not on screen yet to be measured.
// fixedCanvas: the 1024x768 stage scaled to the window; otherwise the page is fluid.
const THEMES = {
  2002: {
    name: 'Media Center 2002',
    description: 'Windows XP Media Center Edition 2002, the original',
    tilesPerPage: 9,
    rowsPerPage: 11,
    columns: 3,
    fixedCanvas: true,
  },
  whistler: {
    name: 'Whistler Beta 2',
    description: 'Luna as it stood in Whistler Beta 2, build 2462',
    tilesPerPage: 16,
    rowsPerPage: 22,
    columns: 4,
    fixedCanvas: true,
  },
  netflix: {
    name: 'Netflix',
    description: 'Rows of cards, black and red',
    tilesPerPage: 12,
    rowsPerPage: 6,
    columns: 6,
    fixedCanvas: false,
  },
};

// Phones and small windows: every theme switches to one scrolling column (css/responsive.css).
// The media query here must stay the same as the one in that file.
const COMPACT_LAYOUT = { tilesPerPage: 12, rowsPerPage: 24, columns: 2, fixedCanvas: false };
const compactLayoutQuery = window.matchMedia('(max-width: 760px), (max-height: 480px)');

/** @returns {boolean} whether the small-screen layout is in use */
function isCompactLayout() {
  return compactLayoutQuery.matches;
}

/** @returns {string} the id of the theme in use; "2002" when the saved one is unknown */
function currentThemeId() {
  const savedTheme = getSetting('theme');
  return THEMES[savedTheme] ? savedTheme : '2002';
}

function currentTheme() {
  return THEMES[currentThemeId()];
}

/** Page sizes and canvas mode for the theme and window size in use. */
function currentLayout() {
  return isCompactLayout() ? COMPACT_LAYOUT : currentTheme();
}

/** Puts the theme on <body> (the stylesheets key off it) and refits the stage. */
function applyTheme() {
  document.body.dataset.theme = currentThemeId();
  fitStage();
}

/** Switches to the next theme (the T key). */
async function cycleTheme() {
  const themeIds = Object.keys(THEMES);
  const nextIndex = (themeIds.indexOf(currentThemeId()) + 1) % themeIds.length;
  await saveSettings({ theme: themeIds[nextIndex] });
  applyTheme();
  rerenderCurrentScreen();
  showToast(`Theme: ${currentTheme().name}`, 1200);
}
