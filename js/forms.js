'use strict';
/* forms.js — the two forms of index.html: "Profile and preferences" and "Search".
   The rules of each field (required, minlength, maxlength, min, max, step) are written as
   attributes in the HTML. This file reads those attributes, checks the values, shows a
   message under the first field that fails, and returns the values in the right types. */

/** The subtitle languages, read from the <select> in index.html so the list exists once. */
const SUBTITLE_LANGUAGES = [...selectElement('#subtitle-language').options].map((option) => ({
  code: option.value,
  name: option.textContent,
}));

const formPanel = (() => {
  const overlay = selectElement('#form-overlay');
  const profileForm = selectElement('#profile-form');
  const searchForm = selectElement('#search-form');
  const volumeField = selectElement('#start-volume');
  const volumeOutput = selectElement('#start-volume-output');

  let openForm = null; // the form on screen, or null
  let resolveOpenForm = null; // settles the promise returned by show()

  /** The label text of a field, for use in messages. */
  function fieldLabel(field) {
    const label = field.labels && field.labels[0];
    return label ? label.textContent.replace(/\s*\(.*\)$/, '') : 'This field';
  }

  /**
   * Checks one field against the rules in its attributes.
   * @param {HTMLInputElement|HTMLSelectElement} field
   * @returns {string} what is wrong, in plain words; empty when the value is fine
   */
  function findFieldError(field) {
    const label = fieldLabel(field);
    const value = field.value.trim();
    // a number field holding something that is not a number reports an empty value
    if (field.validity.badInput) return `${label} must be a number.`;
    if (field.required && value === '') return `${label} cannot be empty.`;
    if (value === '') return '';
    if (field.minLength > 0 && value.length < field.minLength) {
      return `${label} needs at least ${field.minLength} characters.`;
    }
    if (field.maxLength > 0 && value.length > field.maxLength) {
      return `${label} can be at most ${field.maxLength} characters long.`;
    }
    if (field.type === 'number') {
      const number = Number(value);
      if (!Number.isFinite(number)) return `${label} must be a number.`;
      if (!Number.isInteger(number)) return `${label} must be a whole number.`;
      if (field.min !== '' && number < Number(field.min)) {
        return `${label} cannot be less than ${field.min}.`;
      }
      if (field.max !== '' && number > Number(field.max)) {
        return `${label} cannot be more than ${field.max}.`;
      }
    }
    return '';
  }

  /** The <small> under a field where its message goes, or null. */
  function errorLineOf(field) {
    const errorLineId = field.getAttribute('aria-describedby');
    return errorLineId ? document.getElementById(errorLineId) : null;
  }

  /** Shows a message under a field, or clears it when the message is empty. */
  function showFieldError(field, message) {
    const errorLine = errorLineOf(field);
    if (errorLine) errorLine.textContent = message;
    field.classList.toggle('is-invalid', message !== '');
    field.setAttribute('aria-invalid', String(message !== ''));
  }

  /**
   * Validates every field of a form and puts the cursor in the first one that fails.
   * @param {HTMLFormElement} form
   * @returns {boolean} true when the whole form is valid
   */
  function validateForm(form) {
    let firstInvalidField = null;
    for (const field of form.elements) {
      const isCheckedField =
        field instanceof HTMLInputElement || field instanceof HTMLSelectElement;
      if (!isCheckedField) continue;
      const message = findFieldError(field);
      showFieldError(field, message);
      if (message !== '' && firstInvalidField === null) firstInvalidField = field;
    }
    if (firstInvalidField) firstInvalidField.focus();
    return firstInvalidField === null;
  }

  /**
   * Converts the text of a number field to a whole number.
   * @param {FormDataEntryValue|null} text
   * @param {string} label the field's name, for the error message
   * @returns {number}
   * @throws {TypeError} when the text is not a whole number
   */
  function parseWholeNumber(text, label) {
    const number = Number(text);
    if (text === null || String(text).trim() === '' || !Number.isInteger(number)) {
      throw new TypeError(`${label} must be a whole number.`);
    }
    return number;
  }

  /** Reads the profile form into the shape the settings use. */
  function readProfileForm() {
    const data = new FormData(profileForm);
    return {
      displayName: String(data.get('displayName')).trim(),
      slideshowSeconds: parseWholeNumber(data.get('slideshowSeconds'), 'Slide show interval'),
      volume: parseWholeNumber(data.get('startVolume'), 'Starting volume'),
      subtitleLang: String(data.get('subtitleLanguage')),
      clock24: data.get('clock24Hour') === 'on',
    };
  }

  /** Reads the search form. */
  function readSearchForm() {
    const data = new FormData(searchForm);
    return { query: String(data.get('query')).trim() };
  }

  /**
   * Puts values into a form's fields by their name attribute.
   * @param {HTMLFormElement} form
   * @param {Object<string, string|number|boolean>} values
   */
  function fillForm(form, values) {
    for (const [name, value] of Object.entries(values)) {
      const field = form.elements.namedItem(name);
      if (!field) continue;
      if (field.type === 'checkbox') field.checked = Boolean(value);
      else field.value = String(value);
    }
  }

  /**
   * Opens a form and waits until it is saved or cancelled.
   * @param {HTMLFormElement} form
   * @param {Object<string, string|number|boolean>} values what the fields start with
   * @returns {Promise<object|null>} the values read from the form, or null when cancelled
   */
  function show(form, values) {
    close(null);
    return new Promise((resolve) => {
      form.reset();
      for (const field of form.elements) {
        if (field instanceof HTMLInputElement) showFieldError(field, '');
      }
      fillForm(form, values);
      volumeOutput.textContent = `${volumeField.value}%`;
      openForm = form;
      resolveOpenForm = resolve;
      form.hidden = false;
      overlay.hidden = false;
      const firstField = form.querySelector('input, select');
      firstField.focus();
      if (typeof firstField.select === 'function') firstField.select();
    });
  }

  /**
   * Closes the open form.
   * @param {object|null} [result] what show() resolves with; null means cancelled
   */
  function close(result = null) {
    if (!openForm) return;
    const resolve = resolveOpenForm;
    openForm.hidden = true;
    overlay.hidden = true;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    openForm = null;
    resolveOpenForm = null;
    resolve(result);
  }

  /**
   * Shared submit handling: validate, convert, close with the result.
   * @param {HTMLFormElement} form
   * @param {() => object} readForm converts the fields; may throw on a value it cannot convert
   */
  function handleSubmit(form, readForm) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!validateForm(form)) {
        uiSounds.play('error');
        return;
      }
      try {
        close(readForm());
      } catch (error) {
        // a value passed the attribute rules but could not be converted
        reportProblem('Reading the form', error);
        showToast(
          error instanceof TypeError ? error.message : 'That could not be saved. Check the fields.',
          2500,
        );
      }
    });
    // clear a field's message as soon as the user corrects it
    form.addEventListener('input', (event) => {
      const field = event.target;
      if (field instanceof HTMLInputElement && field.classList.contains('is-invalid')) {
        showFieldError(field, findFieldError(field));
      }
    });
    selectElement('[data-action="cancel"]', form).addEventListener('click', () => close(null));
  }

  handleSubmit(profileForm, readProfileForm);
  handleSubmit(searchForm, readSearchForm);
  volumeField.addEventListener('input', () => {
    volumeOutput.textContent = `${volumeField.value}%`;
  });
  // a click on the dimmed area around the form cancels it
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close(null);
  });

  return {
    isOpen: () => openForm !== null,
    close,
    /**
     * Opens "Profile and preferences" with the current settings filled in.
     * @returns {Promise<{displayName: string, slideshowSeconds: number, volume: number, subtitleLang: string, clock24: boolean}|null>}
     */
    openProfile() {
      return show(profileForm, {
        displayName: getSetting('displayName'),
        slideshowSeconds: getSetting('slideshowSeconds'),
        startVolume: getSetting('volume'),
        subtitleLanguage: getSetting('subtitleLang'),
        clock24Hour: getSetting('clock24'),
      });
    },
    /**
     * Opens the search form.
     * @param {string} [query] text to start with
     * @returns {Promise<{query: string}|null>}
     */
    openSearch(query = '') {
      return show(searchForm, { query });
    },
  };
})();
