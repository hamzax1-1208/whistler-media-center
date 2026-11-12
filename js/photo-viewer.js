'use strict';
/* photo-viewer.js — the full-screen photo viewer and slide show. Two stacked <img> layers
   take turns: the next picture loads into the hidden one and fades in over the other. */

const photoViewer = (() => {
  const viewerElement = selectElement('#photo-viewer');
  const layers = [selectElement('#photo-layer-a'), selectElement('#photo-layer-b')];

  const state = {
    isOpen: false,
    files: [], // the picture file records being shown
    index: 0,
    isSlideshow: false,
    slideTimer: 0,
    visibleLayer: 0, // which of the two layers is on top
  };

  /** Gives a layer a slow drift and zoom for the time its picture stays up. */
  function startKenBurns(layer) {
    const randomShift = () => `${(Math.random() * 4 - 2).toFixed(1)}%`;
    layer.style.setProperty('--kb-dur', `${getSetting('slideshowSeconds') + 1.5}s`);
    layer.style.setProperty('--kb-x', randomShift());
    layer.style.setProperty('--kb-y', randomShift());
    void layer.offsetWidth; // makes the browser restart the animation
    layer.classList.add('ken-burns');
  }

  /** (Re)starts the countdown to the next picture while a slide show runs. */
  function armSlideTimer() {
    clearTimeout(state.slideTimer);
    if (!state.isSlideshow) return;
    state.slideTimer = setTimeout(
      () => showPicture(state.index + 1),
      getSetting('slideshowSeconds') * 1000,
    );
  }

  /** Shows the picture at a position, wrapping around both ends of the list. */
  function showPicture(index) {
    const count = state.files.length;
    state.index = (index + count) % count;
    const file = state.files[state.index];

    state.visibleLayer = state.visibleLayer === 0 ? 1 : 0;
    const incomingLayer = layers[state.visibleLayer];
    const outgoingLayer = layers[state.visibleLayer === 0 ? 1 : 0];
    incomingLayer.className = 'photo-layer';
    incomingLayer.src = mediaSource.urlFor(file);
    incomingLayer.alt = stripExtension(file.name);
    if (getSetting('kenBurns') && state.isSlideshow) startKenBurns(incomingLayer);
    incomingLayer.classList.add('is-visible');
    outgoingLayer.classList.remove('is-visible');

    selectElement('#photo-name').textContent = stripExtension(file.name);
    selectElement('#photo-meta').textContent =
      `${state.index + 1} of ${count} · ${formatDate(file.mtime)}`;

    // load the following picture ahead of time so the next fade starts at once
    const followingFile = state.files[(state.index + 1) % count];
    if (followingFile) new Image().src = mediaSource.urlFor(followingFile);
    armSlideTimer();
  }

  /**
   * Opens the viewer.
   * @param {object[]} files picture file records
   * @param {number} startIndex which one to show first
   * @param {boolean} asSlideshow advance automatically
   */
  function open(files, startIndex, asSlideshow) {
    if (!Array.isArray(files) || files.length === 0) return;
    state.files = files;
    state.isSlideshow = Boolean(asSlideshow);
    state.isOpen = true;
    viewerElement.hidden = false;
    viewerElement.classList.remove('caption-hidden');
    showPicture(startIndex);
    updateNowPlayingBar();
    if (asSlideshow) showToast('Slide show — Enter to pause, Backspace to stop', 2200);
  }

  function close() {
    clearTimeout(state.slideTimer);
    state.isOpen = false;
    viewerElement.hidden = true;
    for (const layer of layers) {
      layer.className = 'photo-layer';
      layer.removeAttribute('src');
      layer.alt = '';
    }
    updateNowPlayingBar();
  }

  /**
   * @param {string} keyName
   * @returns {boolean} true when the key was used
   */
  function handleKey(keyName) {
    switch (keyName) {
      case 'back':
        close();
        return true;
      case 'right':
      case 'down':
      case 'pgdn':
        showPicture(state.index + 1);
        return true;
      case 'left':
      case 'up':
      case 'pgup':
        showPicture(state.index - 1);
        return true;
      case 'enter':
      case 'space':
      case 'playpause':
        state.isSlideshow = !state.isSlideshow;
        showToast(state.isSlideshow ? 'Slide show' : 'Paused', 800);
        armSlideTimer();
        return true;
      case 'c':
        viewerElement.classList.toggle('caption-hidden');
        return true;
      case 'f':
        toggleFullscreen();
        return true;
      default:
        return false;
    }
  }

  // Mouse and touch: the left and right thirds of the picture step, the middle pauses.
  viewerElement.addEventListener('click', (event) => {
    const horizontalPosition = event.clientX / window.innerWidth;
    if (horizontalPosition < 0.3) handleKey('left');
    else if (horizontalPosition > 0.7) handleKey('right');
    else handleKey('enter');
  });
  selectElement('#photo-close-button').addEventListener('click', (event) => {
    event.stopPropagation();
    close();
  });

  return { isOpen: () => state.isOpen, open, close, handleKey };
})();
