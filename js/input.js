'use strict';
/* input.js — everything the user does that is not a click on a screen: the keyboard, a
   game controller, and folders dragged onto the page. Keys and buttons are turned into
   short names ('up', 'enter', 'back', ...) and offered to whatever is on top: the message
   box, the video player, the photo viewer, then the current screen. */

// ---------------------------------------------------------------- keyboard

/** Browser key values -> the names the screens understand. Letters pass through in lower case. */
const KEY_NAMES = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'enter',
  ' ': 'space',
  Backspace: 'back',
  Escape: 'back',
  BrowserBack: 'back',
  PageUp: 'pgup',
  PageDown: 'pgdn',
  Home: 'home',
  End: 'end',
  Tab: 'tab',
  MediaPlayPause: 'playpause',
  MediaTrackNext: 'next',
  MediaTrackPrevious: 'prev',
  MediaStop: 'stop',
};
const MOVE_KEYS = ['up', 'down', 'left', 'right', 'pgup', 'pgdn'];

/** Plays the navigation sound that goes with a key the app used. */
function playKeySound(keyName) {
  if (keyName === 'enter' || keyName === 'space') uiSounds.play('select');
  else if (MOVE_KEYS.includes(keyName) || keyName === 'back') uiSounds.play('focus');
}

/**
 * Keys that work on every screen. Home and the media keys come before the screen's own
 * keys; F and T come after, so a screen may use those letters itself.
 * @returns {boolean} true when the key was used
 */
function handleScreenKey(keyName, event) {
  switch (keyName) {
    case 'home':
      goHome();
      return true;
    case 'playpause':
      musicPlayer.togglePlayback();
      return true;
    case 'next':
      musicPlayer.next();
      return true;
    case 'prev':
      musicPlayer.previous();
      return true;
    case 'stop':
      musicPlayer.stop();
      return true;
    default:
      break;
  }
  if (currentScreen && currentScreen.handleKey && currentScreen.handleKey(keyName, event))
    return true;
  switch (keyName) {
    case 'f':
      toggleFullscreen();
      return true;
    case 't':
      cycleTheme();
      return true;
    default:
      return false;
  }
}

/**
 * Sends a key to whatever is on top.
 * @param {string} keyName a name from KEY_NAMES, or a single character
 * @param {KeyboardEvent|{repeat: boolean}} [event]
 * @returns {boolean} true when something used the key
 */
function dispatchKey(keyName, event) {
  if (isDialogOpen()) {
    const handled = handleDialogKey(keyName);
    if (handled && keyName !== 'back') playKeySound(keyName);
    return handled;
  }
  if (videoPlayer.isOpen()) return videoPlayer.handleKey(keyName, event);
  if (photoViewer.isOpen()) return photoViewer.handleKey(keyName);
  const handled = handleScreenKey(keyName, event);
  if (handled) playKeySound(keyName);
  return handled;
}

window.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return; // leave browser shortcuts alone
  // while a form is open the keys belong to its fields; only Escape is ours
  if (formPanel.isOpen()) {
    if (event.key === 'Escape') {
      formPanel.close();
      event.preventDefault();
    }
    return;
  }
  const keyName = KEY_NAMES[event.key] || (event.key.length === 1 ? event.key.toLowerCase() : null);
  if (keyName && dispatchKey(keyName, event)) event.preventDefault();
});

window.addEventListener('keyup', (event) => {
  const keyName = KEY_NAMES[event.key];
  if (keyName && videoPlayer.isOpen()) videoPlayer.handleKeyUp(keyName);
});

// Buttons outside the forms must not keep the keyboard focus after a click: the app moves its
// own highlight with the arrow keys, and a focused button would also react to Enter and Space.
document.addEventListener('mousedown', (event) => {
  const button = event.target instanceof Element ? event.target.closest('button') : null;
  if (button && !button.closest('form')) event.preventDefault();
});

// ---------------------------------------------------------------- game controller
// Standard mapping: A opens, B goes back, X toggles subtitles, Y opens the player options,
// the D-pad and the left stick move, the shoulder buttons skip.

(() => {
  const BUTTON_KEYS = {
    0: 'enter', // A
    1: 'back', // B
    2: 's', // X
    3: 'o', // Y
    4: 'prev', // left shoulder
    5: 'next', // right shoulder
    6: ',', // left trigger
    7: '.', // right trigger
    8: 'home', // select
    9: 'f', // start
    12: 'up',
    13: 'down',
    14: 'left',
    15: 'right',
  };
  const DIRECTION_KEYS = ['left', 'right', 'up', 'down'];
  const HOLD_DELAY_MS = 450;
  const REPEAT_START_MS = 600;
  const STICK_THRESHOLD = 0.55;
  const STICK_REPEAT_MS = 220;

  const pressedSince = {}; // "pad:button" -> when it went down; 0 when it is up
  let lastStickMove = 0;

  /** One button of one controller: fire on press, repeat while held, release for the player. */
  function pollButton(gamepad, button, buttonIndex) {
    const keyName = BUTTON_KEYS[buttonIndex];
    if (!keyName) return;
    const buttonId = `${gamepad.index}:${buttonIndex}`;
    const downSince = pressedSince[buttonId];
    const now = Date.now();

    if (button.pressed && !downSince) {
      dispatchKey(keyName, { repeat: false });
      pressedSince[buttonId] = now;
    } else if (
      button.pressed &&
      now - downSince > HOLD_DELAY_MS &&
      DIRECTION_KEYS.includes(keyName)
    ) {
      if (videoPlayer.isOpen()) {
        dispatchKey(keyName, { repeat: true }); // the player turns a held direction into scanning
      } else if (now - downSince > REPEAT_START_MS) {
        dispatchKey(keyName, { repeat: true });
        pressedSince[buttonId] = now - 500; // repeat every 100 ms from here on
      }
    } else if (!button.pressed && downSince) {
      pressedSince[buttonId] = 0;
      if (videoPlayer.isOpen()) videoPlayer.handleKeyUp(keyName);
    }
  }

  /** The left stick acts as a slow-repeating D-pad. */
  function pollStick(gamepad) {
    if (Date.now() - lastStickMove <= STICK_REPEAT_MS) return;
    const horizontal = gamepad.axes[0] || 0;
    const vertical = gamepad.axes[1] || 0;
    let keyName = null;
    if (vertical < -STICK_THRESHOLD) keyName = 'up';
    else if (vertical > STICK_THRESHOLD) keyName = 'down';
    else if (horizontal < -STICK_THRESHOLD) keyName = 'left';
    else if (horizontal > STICK_THRESHOLD) keyName = 'right';
    if (!keyName) return;
    dispatchKey(keyName, {});
    lastStickMove = Date.now();
  }

  /** Controllers have no events for buttons, so their state is read every frame. */
  function pollGamepads() {
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gamepad of gamepads) {
      if (!gamepad) continue;
      gamepad.buttons.forEach((button, buttonIndex) => pollButton(gamepad, button, buttonIndex));
      pollStick(gamepad);
    }
    requestAnimationFrame(pollGamepads);
  }

  window.addEventListener('gamepadconnected', (event) => {
    const controllerName = event.gamepad.id.split('(')[0].trim();
    showToast(`Controller connected: ${controllerName}`, 2000);
  });
  requestAnimationFrame(pollGamepads);
})();

// ---------------------------------------------------------------- drag and drop

/** Lets the user drop a folder (or files) onto the page; it opens like a picked folder. */
function installDropTarget() {
  window.addEventListener('dragover', (event) => {
    event.preventDefault();
    document.body.classList.add('is-dropping');
  });
  window.addEventListener('dragleave', (event) => {
    if (!event.relatedTarget) document.body.classList.remove('is-dropping');
  });
  window.addEventListener('drop', async (event) => {
    event.preventDefault();
    document.body.classList.remove('is-dropping');
    if (!mediaSource.local || !mediaSource.fromDrop) {
      showToast(
        'Drop works when the page reads your folders itself (Settings › Look › Source)',
        2500,
      );
      return;
    }
    showToast('Reading the dropped folder…', 2000);
    let openedFolders = [];
    try {
      openedFolders = await mediaSource.fromDrop(event.dataTransfer);
    } catch (error) {
      reportProblem('Reading a dropped folder', error);
      showToast(`Could not read that: ${error.message}`, 2500);
      return;
    }
    if (openedFolders.length === 0) {
      showToast('Nothing usable was dropped', 1500);
      return;
    }
    scanCache.clear();
    showToast(`Opened ${openedFolders.map((folder) => folder.name).join(', ')}`, 2000);
    openScreen(createFolderScreen(openedFolders[0].path));
  });
}
