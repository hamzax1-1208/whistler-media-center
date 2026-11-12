'use strict';
/* music-player.js — music playback: the queue, shuffle and repeat, the spectrum data for
   the visualizer, and the two controls that stay on screen while you browse (the transport
   pill and the now-playing inset in the site footer). */

/** Fired on document whenever the current track changes or playback stops. */
const TRACK_CHANGE_EVENT = 'music:track';

const musicPlayer = (() => {
  const audio = selectElement('#music-audio');

  const playback = {
    queue: [], // the tracks lined up to play
    index: -1, // position in the queue; -1 when nothing is playing
    shuffle: false,
    repeat: 'off', // 'off', 'all' or 'one'
    shuffleOrder: [], // queue positions in the order shuffle plays them
    audioContext: null,
    analyser: null,
    frequencyData: null,
  };

  const currentTrack = () => playback.queue[playback.index] || null;
  const announceTrackChange = () => document.dispatchEvent(new CustomEvent(TRACK_CHANGE_EVENT));
  const newShuffleOrder = () => shuffle(playback.queue.map((_, index) => index));

  /**
   * Connects the audio element to an analyser the first time music plays, so the
   * visualizer has something to draw. Without Web Audio the music still plays.
   */
  function ensureAudioGraph() {
    if (playback.audioContext) {
      if (playback.audioContext.state === 'suspended') playback.audioContext.resume();
      return;
    }
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      playback.audioContext = new AudioContextClass();
      const sourceNode = playback.audioContext.createMediaElementSource(audio);
      playback.analyser = playback.audioContext.createAnalyser();
      playback.analyser.fftSize = 256;
      playback.analyser.smoothingTimeConstant = 0.78;
      sourceNode.connect(playback.analyser);
      playback.analyser.connect(playback.audioContext.destination);
      playback.frequencyData = new Uint8Array(playback.analyser.frequencyBinCount);
    } catch (error) {
      reportProblem('Setting up the visualizer', error);
    }
  }

  /** Starts the track at a queue position (wrapping around the ends). */
  function playAt(queueIndex) {
    if (playback.queue.length === 0) return;
    playback.index = (queueIndex + playback.queue.length) % playback.queue.length;
    const track = currentTrack();
    ensureAudioGraph();
    audio.src = mediaSource.urlFor(track.file);
    playMedia(audio, track.title);

    if (track.coverUrl === undefined) {
      track.coverUrl = null;
      mediaSource
        .coverUrl(track.file)
        .then((coverUrl) => {
          track.coverUrl = coverUrl;
          if (currentTrack() === track) {
            updateMediaSession();
            announceTrackChange();
          }
        })
        .catch((error) => reportProblem(`Reading the cover of ${track.title}`, error));
    }
    updateMediaSession();
    announceTrackChange();
  }

  /**
   * Works out which queue position comes next.
   * @param {number} direction 1 for the next track, -1 for the previous one
   * @returns {number} a queue position, or -1 when playback should stop
   */
  function nextIndex(direction) {
    const queueLength = playback.queue.length;
    if (playback.repeat === 'one') return playback.index;
    if (playback.shuffle) {
      const nextPosition = playback.shuffleOrder.indexOf(playback.index) + direction;
      if (nextPosition >= 0 && nextPosition < playback.shuffleOrder.length) {
        return playback.shuffleOrder[nextPosition];
      }
      if (playback.repeat !== 'all') return -1;
      playback.shuffleOrder = newShuffleOrder();
      return playback.shuffleOrder[0];
    }
    const candidate = playback.index + direction;
    if (candidate >= 0 && candidate < queueLength) return candidate;
    return playback.repeat === 'all' ? (candidate + queueLength) % queueLength : -1;
  }

  /** Tells the operating system what is playing (media keys, lock screen). */
  function updateMediaSession() {
    const track = currentTrack();
    if (!('mediaSession' in navigator) || !track) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album,
      artwork: track.coverUrl ? [{ src: track.coverUrl }] : [],
    });
    navigator.mediaSession.setActionHandler('play', () => playMedia(audio));
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('nexttrack', () => player.next());
    navigator.mediaSession.setActionHandler('previoustrack', () => player.previous());
  }

  audio.addEventListener('ended', () => {
    const followingIndex = nextIndex(1);
    if (followingIndex >= 0) {
      playAt(followingIndex);
    } else {
      playback.index = -1;
      announceTrackChange();
    }
  });
  audio.addEventListener('play', () => updateNowPlayingBar());
  audio.addEventListener('pause', () => updateNowPlayingBar());
  audio.addEventListener('error', () => {
    // an empty src (after Stop) also raises "error"; only report a real file
    if (currentTrack()) showToast("Can't play this file");
  });

  const player = {
    audio,
    playback,
    currentTrack,

    /**
     * Replaces the queue and starts playing.
     * @param {object[]} tracks
     * @param {number} [startIndex] which track to start with
     * @param {boolean} [shuffled] play in random order
     */
    playQueue(tracks, startIndex = 0, shuffled = false) {
      if (!Array.isArray(tracks) || tracks.length === 0) return;
      playback.queue = tracks;
      playback.shuffle = shuffled;
      playback.shuffleOrder = newShuffleOrder();
      playAt(shuffled ? playback.shuffleOrder[0] : startIndex);
    },

    /** Adds tracks to the end of the queue without interrupting what is playing. */
    addToQueue(tracks) {
      playback.queue.push(...tracks);
      playback.shuffleOrder = newShuffleOrder();
    },

    togglePlayback() {
      if (!currentTrack()) return;
      if (audio.paused) {
        ensureAudioGraph();
        playMedia(audio);
      } else {
        audio.pause();
      }
    },

    stop() {
      playback.index = -1;
      playback.queue = [];
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      announceTrackChange();
    },

    next() {
      const followingIndex = nextIndex(1);
      if (followingIndex >= 0) playAt(followingIndex);
    },

    /** Back to the start of the track, or to the previous track when already near the start. */
    previous() {
      if (audio.currentTime > 4) {
        audio.currentTime = 0;
        return;
      }
      const precedingIndex = nextIndex(-1);
      if (precedingIndex >= 0) playAt(precedingIndex);
      else audio.currentTime = 0;
    },

    setShuffle(enabled) {
      playback.shuffle = Boolean(enabled);
      playback.shuffleOrder = newShuffleOrder();
    },

    /** off -> all -> one -> off. @returns {string} the new repeat mode */
    cycleRepeat() {
      const order = ['off', 'all', 'one'];
      playback.repeat = order[(order.indexOf(playback.repeat) + 1) % order.length];
      return playback.repeat;
    },

    /**
     * The loudness of the music right now, split into bars for the visualizer.
     * @param {number} barCount
     * @returns {Float32Array|null} one value from 0 to 1 per bar; null while nothing plays
     */
    readSpectrum(barCount) {
      if (!playback.analyser || audio.paused) return null;
      playback.analyser.getByteFrequencyData(playback.frequencyData);
      const bars = new Float32Array(barCount);
      // the top 30% of the spectrum is nearly empty for music, so leave it out
      const usableBins = Math.floor(playback.frequencyData.length * 0.7);
      for (let bar = 0; bar < barCount; bar++) {
        // bars get wider towards the high notes, like hearing does
        const firstBin = Math.floor(Math.pow(bar / barCount, 1.6) * usableBins);
        const lastBin = Math.max(
          firstBin + 1,
          Math.floor(Math.pow((bar + 1) / barCount, 1.6) * usableBins),
        );
        let peak = 0;
        for (let bin = firstBin; bin < lastBin; bin++)
          peak = Math.max(peak, playback.frequencyData[bin]);
        bars[bar] = peak / 255;
      }
      return bars;
    },
  };
  return player;
})();

// ---------------------------------------------------------------- transport pill and now-playing inset

const transportElement = selectElement('#transport');
const insetElement = selectElement('#now-playing-inset');
const insetSpectrum = selectElement('#inset-spectrum');
let insetAnimationFrame = 0;

/** Draws the eight small bars of the inset, once per frame while it is visible. */
function drawInsetSpectrum() {
  if (insetElement.hidden) {
    insetAnimationFrame = 0;
    return;
  }
  const BAR_COUNT = 8;
  const context = insetSpectrum.getContext('2d');
  const levels = musicPlayer.readSpectrum(BAR_COUNT);
  context.clearRect(0, 0, insetSpectrum.width, insetSpectrum.height);
  context.fillStyle = '#B6EE6C';
  for (let bar = 0; bar < BAR_COUNT; bar++) {
    const barHeight = levels ? levels[bar] * 28 : 2;
    context.fillRect(bar * 5, insetSpectrum.height - barHeight, 4, barHeight);
  }
  insetAnimationFrame = requestAnimationFrame(drawInsetSpectrum);
}

/**
 * Shows or hides the transport pill and the inset to match what is going on: both need a
 * track, both hide under the video player and the photo viewer, and the inset also hides
 * on the now-playing screen, which shows the same thing larger.
 */
function updateNowPlayingBar() {
  const track = musicPlayer.currentTrack();
  const coveredByViewer = videoPlayer.isOpen() || photoViewer.isOpen();
  const onNowPlayingScreen = Boolean(currentScreen && currentScreen.isNowPlaying);

  transportElement.hidden = !track || coveredByViewer;
  setIcon(selectElement('#transport-play'), musicPlayer.audio.paused ? 'play' : 'pause');

  insetElement.hidden = !track || coveredByViewer || onNowPlayingScreen;
  if (insetElement.hidden) return;
  const cover = selectElement('#inset-cover');
  cover.hidden = !track.coverUrl;
  if (track.coverUrl) {
    cover.src = track.coverUrl;
    cover.alt = `Cover of ${track.album}`;
  }
  selectElement('#inset-title').textContent = track.title;
  selectElement('#inset-artist').textContent = track.artist;
  if (!insetAnimationFrame) drawInsetSpectrum();
}

// The buttons are written in index.html; this connects them once.
selectElement('#transport-previous').addEventListener('click', () => musicPlayer.previous());
selectElement('#transport-next').addEventListener('click', () => musicPlayer.next());
selectElement('#transport-play').addEventListener('click', () => musicPlayer.togglePlayback());
selectElement('#transport-stop').addEventListener('click', () => musicPlayer.stop());
selectElement('#transport-record').addEventListener('click', () =>
  showToast('No tuner. This is a web page.'),
);
selectElement('#transport-mute').addEventListener('click', () => {
  musicPlayer.audio.muted = !musicPlayer.audio.muted;
  showToast(musicPlayer.audio.muted ? 'Muted' : 'Sound on', 800);
});
selectElement('#transport-volume-down').addEventListener('click', () => changeVolume(-10));
selectElement('#transport-volume-up').addEventListener('click', () => changeVolume(10));
insetElement.addEventListener('click', () => openScreen(createNowPlayingScreen()));
