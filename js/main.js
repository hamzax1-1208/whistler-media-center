'use strict';
/* main.js — the entry point. Every other script only defines things; this one starts the
   app: it picks where the media comes from, loads what was saved, applies the theme and
   opens the start screen.

   Load order (see the <script> tags at the end of index.html):
     utils -> parsers -> source -> state -> ui -> forms -> navigation -> library ->
     browse-screen -> the three players -> the screens -> input -> main                */

/**
 * Remembered folders need the user's OK again in every session.
 * Chrome and Edge keep the folder and ask once for permission. Firefox and Safari forget the
 * folder itself, so each one is picked again; it keeps its id, so the library and the
 * resume points still match.
 */
async function reconnectFolders() {
  if (mediaSource.canRememberFolders) {
    const answer = await showDialog({
      title: 'Reconnect folders',
      text: 'The browser remembers your folders but needs your OK before reading them again this session.',
      buttons: ['Reconnect', 'Later'],
    });
    if (answer !== 0) return;
    const reconnected = await mediaSource.reconnect();
    showToast(reconnected ? 'Folders reconnected' : 'Some folders were not reconnected', 1600);
  } else {
    for (const folderName of mediaSource.missingFolders()) {
      const answer = await showDialog({
        title: 'Pick the folder again',
        text: `This browser doesn't keep folder access between sessions. Pick "${folderName}" again to carry on where you left off, or drop it onto the page.`,
        buttons: ['Pick folder', 'Later'],
      });
      if (answer !== 0) break;
      const reconnected = await mediaSource.reconnectMissing(folderName);
      showToast(reconnected ? `${folderName} reconnected` : `${folderName} not reconnected`, 1500);
    }
  }
  scanCache.clear();
  rerenderCurrentScreen();
}

/** Loads the saved state; a missing or damaged save falls back to an empty library. */
async function loadSavedState() {
  try {
    appState = await mediaSource.loadState();
  } catch (error) {
    reportProblem('Loading the saved state', error);
    showToast('Your saved settings could not be read; starting fresh', 3000);
  }
  appState.roots = appState.roots || { videos: [], music: [], pictures: [] };
  appState.resume = appState.resume || {};
  appState.settings = appState.settings || {};
}

async function startApp() {
  mediaSource = await Source.detect();
  await loadSavedState();
  applyTheme();
  setVolume(getSetting('volume'), { announce: false, save: false });
  openScreen(createStartScreen());

  uiSounds.probe();
  // browsers only allow sound after a key press, so the startup sound waits for the first one
  window.addEventListener('keydown', () => uiSounds.play('intro'), { once: true });
  document.addEventListener(TRACK_CHANGE_EVENT, () => {
    updateNowPlayingBar();
    if (currentScreen && currentScreen.onTrackChange) currentScreen.onTrackChange();
  });
  // closing the tab in the middle of a video still saves where it was
  window.addEventListener('beforeunload', () => {
    if (videoPlayer.isOpen()) videoPlayer.close();
  });
  installDropTarget();

  if (mediaSource.local && !mediaSource.isSupported()) {
    await showMessage(
      'Folder access',
      'This browser cannot open folders at all. Use Chrome, Edge, Firefox or Safari, or run the optional server.js.',
    );
  } else if (mediaSource.local && mediaSource.needsReconnect) {
    await reconnectFolders();
  }
}

startApp().catch((error) => {
  reportProblem('Starting Whistler', error);
  showMessage('Whistler could not start', `${error.message}\nReload the page to try again.`);
});
