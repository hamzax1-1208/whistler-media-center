'use strict';
/* utils.js — small helpers shared by every other script: building DOM nodes, formatting
   text, working with paths, sorting and reporting errors. Nothing in here knows about
   screens or media. */

// ---------------------------------------------------------------- DOM

/**
 * Finds the first element that matches a CSS selector.
 * @param {string} selector
 * @param {ParentNode} [parent] where to look; the whole document by default
 * @returns {Element|null}
 */
function selectElement(selector, parent = document) {
  return parent.querySelector(selector);
}

/**
 * Creates an element, optionally with a class name and text.
 * @param {string} tagName
 * @param {string} [className]
 * @param {string|number|null} [text]
 * @returns {HTMLElement}
 */
function createElement(tagName, className = '', text = null) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== null && text !== undefined) element.textContent = String(text);
  return element;
}

/**
 * Copies a <template> from index.html and returns the copy's root element.
 * @param {string} templateId id of the <template>
 * @returns {HTMLElement}
 */
function cloneTemplate(templateId) {
  const template = document.getElementById(templateId);
  if (!(template instanceof HTMLTemplateElement) || !template.content.firstElementChild) {
    throw new Error(`Template "${templateId}" is missing from index.html`);
  }
  return template.content.firstElementChild.cloneNode(true);
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/**
 * Builds an icon that points at a <symbol> of the sprite in index.html.
 * @param {string} iconName the part after "icon-" in the symbol id, for example "folder"
 * @returns {SVGSVGElement}
 */
function createIcon(iconName) {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NAMESPACE, 'use');
  use.setAttribute('href', `#icon-${iconName}`);
  svg.appendChild(use);
  return svg;
}

/** Puts one icon into an element, replacing whatever was inside. */
function setIcon(element, iconName) {
  element.replaceChildren(createIcon(iconName));
}

// Which icon stands for which kind of item
const KIND_ICONS = {
  dir: 'folder',
  video: 'film',
  audio: 'note',
  image: 'picture',
  drive: 'drive',
  album: 'disc',
  up: 'up',
  gear: 'gear',
  plus: 'plus',
  search: 'search',
  person: 'person',
};

/** @returns {string} the icon name for an item kind; a folder when the kind is unknown */
function iconNameForKind(kind) {
  return KIND_ICONS[kind] || 'folder';
}

/**
 * Sets the text of an optional part and hides the part when there is nothing to show.
 * @param {HTMLElement} element
 * @param {string|number|null|undefined} text
 */
function setOptionalText(element, text) {
  const hasText = text !== null && text !== undefined && text !== '';
  element.hidden = !hasText;
  element.textContent = hasText ? String(text) : '';
}

// ---------------------------------------------------------------- numbers and text

/** Keeps a number between a minimum and a maximum. */
function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

/**
 * Formats a duration as m:ss, or h:mm:ss from one hour up.
 * @param {number} totalSeconds
 * @returns {string} "0:00" when the input is not a usable number
 */
function formatTime(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
  const wholeSeconds = Math.floor(totalSeconds);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const seconds = String(wholeSeconds % 60).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`;
  return `${minutes}:${seconds}`;
}

/**
 * Formats a file size with the largest unit that fits, for example "1.4 GB".
 * @param {number} byteCount
 * @returns {string}
 */
function formatBytes(byteCount) {
  if (!Number.isFinite(byteCount) || byteCount <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = byteCount;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const shownValue = unitIndex >= 3 ? value.toFixed(1) : Math.round(value);
  return `${shownValue} ${units[unitIndex]}`;
}

/**
 * Formats a timestamp as a long date in the user's language.
 * @param {number} timestamp milliseconds since 1970
 * @returns {string} empty when there is no timestamp
 */
function formatDate(timestamp) {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

/** "1 song", "3 songs". */
function pluralize(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------- paths

/** The last part of a path: the file or folder name. */
function baseName(path) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

/** The folder a path sits in. A Windows drive root keeps its backslash ("C:\"). */
function directoryName(path) {
  const match = /^(.*)[\\/][^\\/]+[\\/]?$/.exec(path);
  if (!match) return path;
  const parent = match[1];
  const isDriveLetter = parent.length === 2 && parent[1] === ':';
  return isDriveLetter ? `${parent}\\` : parent;
}

/** A file name without its extension. */
function stripExtension(fileName) {
  return fileName.replace(/\.[^.]+$/, '');
}

// ---------------------------------------------------------------- lists

/** Compares two names the way a person would: "Episode 2" before "Episode 10". */
function naturalCompare(first, second) {
  return String(first).localeCompare(String(second), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

/**
 * Returns a shuffled copy of a list (Fisher-Yates); the original is left alone.
 * @template T
 * @param {T[]} list
 * @returns {T[]}
 */
function shuffle(list) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// ---------------------------------------------------------------- errors

/**
 * Notes a problem the app can carry on from. The user gets a message where it matters
 * (see showToast and showMessage in ui.js); this keeps the detail for the console.
 * @param {string} context what the app was doing
 * @param {unknown} error
 */
function reportProblem(context, error) {
  console.warn(`[Whistler] ${context}:`, error);
}
