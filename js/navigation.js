'use strict';
/* navigation.js — the stage and the stack of screens.

   A screen is a plain object:
     render()                    draws it into <main id="screen-host">
     handleKey(keyName, event)   optional; returns true when it used the key
     leave()                     optional; called when another screen covers or replaces it
     onTrackChange()             optional; called when the music moves to another track

   Opening a screen pushes it on the stack, Back pops it, Home returns to the first one. */

const screenHost = selectElement('#screen-host');
const screenStack = [];

/** The screen on top of the stack: the one the user is looking at. */
let currentScreen = null;

/**
 * Scales the fixed 1024x768 stage so it fills the window without losing its proportions.
 * Fluid layouts (the Netflix theme, small screens) are not scaled.
 */
function fitStage() {
  const scale = currentLayout().fixedCanvas
    ? Math.min(window.innerWidth / 1024, window.innerHeight / 768)
    : 1;
  document.documentElement.style.setProperty('--stage-scale', String(scale));
}

/**
 * Puts a screen's element on the stage in place of the previous one.
 * @param {HTMLElement} screenElement
 * @returns {HTMLElement} the same element
 */
function mountScreen(screenElement) {
  screenHost.replaceChildren(screenElement);
  return screenElement;
}

/** Things outside the screen that depend on which screen is showing. */
function refreshChrome() {
  updateNowPlayingBar();
  selectElement('#back-button').disabled = screenStack.length <= 1;
}

/**
 * Opens a screen on top of the current one.
 * @param {{ render: Function }} screen
 */
function openScreen(screen) {
  if (!screen || typeof screen.render !== 'function') {
    throw new TypeError('openScreen needs a screen object with a render() function');
  }
  if (currentScreen && currentScreen.leave) currentScreen.leave();
  screenStack.push(screen);
  currentScreen = screen;
  screen.render();
  refreshChrome();
}

/**
 * Closes the current screen and shows the one under it.
 * @returns {boolean} false on the start screen, where there is nothing to go back to
 */
function goBack() {
  if (screenStack.length <= 1) return false;
  const closedScreen = screenStack.pop();
  if (closedScreen.leave) closedScreen.leave();
  currentScreen = screenStack[screenStack.length - 1];
  currentScreen.render();
  refreshChrome();
  return true;
}

/** Closes every screen above the start screen. */
function goHome() {
  while (screenStack.length > 1) {
    const closedScreen = screenStack.pop();
    if (closedScreen.leave) closedScreen.leave();
  }
  currentScreen = screenStack[0];
  currentScreen.render();
  refreshChrome();
}

/** Draws the current screen again, for example after the theme changed. */
function rerenderCurrentScreen() {
  if (currentScreen) currentScreen.render();
  refreshChrome();
}

/**
 * Goes one step back from wherever the user is: closes the form, the video, the photo
 * viewer, or the current screen. Used by the on-screen back buttons.
 */
function stepBack() {
  if (formPanel.isOpen()) formPanel.close();
  else if (videoPlayer.isOpen()) videoPlayer.close();
  else if (photoViewer.isOpen()) photoViewer.close();
  else goBack();
}

// ---------------------------------------------------------------- site header buttons
// The header is the window title bar in the Whistler theme and the app bar on phones.

selectElement('#back-button').addEventListener('click', stepBack);
selectElement('#minimize-button').addEventListener('click', () => {
  showToast('There is no taskbar to minimise to.', 1200);
});
selectElement('#maximize-button').addEventListener('click', toggleFullscreen);
selectElement('#close-button').addEventListener('click', () => {
  if (!goBack()) showToast('This is the start screen. Close the tab if you must.', 1500);
});

// ---------------------------------------------------------------- window size

fitStage();
window.addEventListener('resize', fitStage);
// crossing the small-screen breakpoint changes the page size of the lists, so redraw
compactLayoutQuery.addEventListener('change', () => {
  fitStage();
  rerenderCurrentScreen();
});
