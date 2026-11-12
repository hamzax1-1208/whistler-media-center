'use strict';
/* ui.js — the small pieces every screen uses: toast messages, the message box,
   navigation sounds, volume and full screen. */

// ---------------------------------------------------------------- toast

const toastElement = selectElement('#toast');
let toastTimer = 0;

/**
 * Shows a short message near the bottom of the screen.
 * @param {string} message
 * @param {number} [durationMs] how long it stays up
 */
function showToast(message, durationMs = 1800) {
  if (typeof message !== 'string' || message === '') return;
  toastElement.textContent = message;
  toastElement.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastElement.hidden = true;
  }, durationMs);
}

// ---------------------------------------------------------------- message box

const dialogOverlay = selectElement('#dialog-overlay');
const dialogTitle = selectElement('#dialog-title');
const dialogText = selectElement('#dialog-text');
const dialogButtons = selectElement('#dialog-buttons');

/** The message box on screen: { focusedIndex, buttonCount, finish }, or null. */
let activeDialog = null;

/** Moves the highlight to the button the keyboard is on. */
function paintDialogFocus() {
  [...dialogButtons.children].forEach((button, index) => {
    button.classList.toggle('is-focused', index === activeDialog.focusedIndex);
  });
}

/**
 * Asks a question and waits for the answer.
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.text
 * @param {string[]} [options.buttons] button labels, left to right
 * @param {number} [options.defaultIndex] the button that starts highlighted
 * @returns {Promise<number>} the index of the chosen button; Back picks the last one
 */
function showDialog({ title, text, buttons = ['Yes', 'No'], defaultIndex = 0 }) {
  return new Promise((resolve) => {
    const finish = (chosenIndex) => {
      dialogOverlay.hidden = true;
      activeDialog = null;
      resolve(chosenIndex);
    };
    dialogTitle.textContent = title;
    dialogText.textContent = text;
    dialogButtons.replaceChildren();
    buttons.forEach((label, index) => {
      const button = createElement('button', 'slab dialog-button', label);
      button.type = 'button';
      button.addEventListener('click', () => finish(index));
      button.addEventListener('mouseenter', () => {
        activeDialog.focusedIndex = index;
        paintDialogFocus();
      });
      dialogButtons.appendChild(button);
    });
    activeDialog = {
      focusedIndex: clamp(defaultIndex, 0, buttons.length - 1),
      buttonCount: buttons.length,
      finish,
    };
    dialogOverlay.hidden = false;
    paintDialogFocus();
  });
}

function isDialogOpen() {
  return activeDialog !== null;
}

/**
 * Keyboard handling while a message box is open.
 * @param {string} keyName
 * @returns {boolean} true when a message box was open and took the key
 */
function handleDialogKey(keyName) {
  if (!activeDialog) return false;
  const { buttonCount } = activeDialog;
  switch (keyName) {
    case 'left':
    case 'up':
      activeDialog.focusedIndex = (activeDialog.focusedIndex + buttonCount - 1) % buttonCount;
      break;
    case 'right':
    case 'down':
    case 'tab':
      activeDialog.focusedIndex = (activeDialog.focusedIndex + 1) % buttonCount;
      break;
    case 'enter':
    case 'space':
      activeDialog.finish(activeDialog.focusedIndex);
      return true;
    case 'back':
      activeDialog.finish(buttonCount - 1);
      return true;
    default:
      break;
  }
  paintDialogFocus();
  return true;
}

/** A Yes / No question. @returns {Promise<boolean>} true for Yes */
async function confirmAction(title, text) {
  const chosenIndex = await showDialog({ title, text });
  return chosenIndex === 0;
}

/** A message with a single OK button. */
function showMessage(title, text) {
  return showDialog({ title, text, buttons: ['OK'] });
}

// ---------------------------------------------------------------- navigation sounds
// The shell had four: a tick on every cursor move, a note on select, a buzz on error and a
// startup sting. The files are not bundled; when focus.wav, select.wav, error.wav and
// intro.wav exist in assets/sounds/ they are played.

const uiSounds = (() => {
  const SOUND_NAMES = ['focus', 'select', 'error', 'intro'];
  const clips = new Map();
  const missingSounds = new Set();

  /** @returns {HTMLAudioElement|null} the clip, or null once its file is known to be absent */
  function loadClip(soundName) {
    if (missingSounds.has(soundName)) return null;
    if (!clips.has(soundName)) {
      const clip = new Audio(`assets/sounds/${soundName}.wav`);
      clip.preload = 'auto';
      clip.addEventListener('error', () => missingSounds.add(soundName), { once: true });
      clips.set(soundName, clip);
    }
    return clips.get(soundName);
  }

  return {
    /** Plays one of the four sounds if the Sounds setting is on and its file exists. */
    play(soundName) {
      if (!getSetting('sounds')) return;
      const clip = loadClip(soundName);
      if (!clip) return;
      try {
        clip.currentTime = 0;
        clip.volume = soundName === 'intro' ? 0.6 : 0.35;
        // play() is refused until the user has pressed a key; that is fine for a tick
        clip.play().catch(() => {});
      } catch (error) {
        reportProblem(`Playing the "${soundName}" sound`, error);
      }
    },
    /** @returns {boolean} whether at least one sound file was found */
    isAvailable() {
      return [...clips.keys()].some((soundName) => !missingSounds.has(soundName));
    },
    /** Starts loading all four, which also finds out which ones exist. */
    probe() {
      SOUND_NAMES.forEach(loadClip);
    },
  };
})();

// ---------------------------------------------------------------- starting playback

/**
 * Starts a video or audio element. play() returns a promise that is rejected when the
 * request is overtaken (the user pauses, skips or stops before playback began); that is
 * normal and is not reported. Anything else is noted for the console.
 * @param {HTMLMediaElement} mediaElement
 * @param {string} [description] what is being played, for the report
 */
function playMedia(mediaElement, description = 'media') {
  mediaElement.play().catch((error) => {
    if (error.name !== 'AbortError') reportProblem(`Playing ${description}`, error);
  });
}

// ---------------------------------------------------------------- volume
// Music and video share one volume, saved as the "volume" setting (0-100).

let volumeSaveTimer = 0;

/** @returns {number} the volume in use, 0-100 */
function currentVolume() {
  return Math.round(selectElement('#video').volume * 100);
}

/**
 * Sets the volume of both players.
 * @param {number} percent 0-100; values outside are clamped
 * @param {object} [options]
 * @param {boolean} [options.announce] show the new level in a toast
 * @param {boolean} [options.save] remember the level for next time
 * @returns {number} the level that was applied
 */
function setVolume(percent, { announce = true, save = true } = {}) {
  const level = clamp(Math.round(Number(percent) || 0), 0, 100);
  for (const mediaElement of [selectElement('#music-audio'), selectElement('#video')]) {
    mediaElement.volume = level / 100;
  }
  if (announce) showToast(`Volume ${level}%`, 900);
  if (save) {
    // wait until the user stops pressing the key before writing to storage
    clearTimeout(volumeSaveTimer);
    volumeSaveTimer = setTimeout(() => {
      if (level !== getSetting('volume')) saveSettings({ volume: level });
    }, 600);
  }
  return level;
}

/** Turns the volume up or down by a number of percent. */
function changeVolume(deltaPercent) {
  return setVolume(currentVolume() + deltaPercent);
}

// ---------------------------------------------------------------- full screen

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
    return;
  }
  document.documentElement.requestFullscreen().catch((error) => {
    reportProblem('Entering full screen', error);
    showToast('This browser did not allow full screen');
  });
}
