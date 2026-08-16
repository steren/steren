import { makePathTracer, Cube } from 'webgl-path-tracing';
import { Vector } from 'sylvester';

// Height of the raised elements, in scene units.
const zHeight = 0.1;
// Z coordinate of the background plane (-1 is the room wall).
const zBase = 0;
// Time to make the effect appear.
const opacityTransition = '0.5s';
// Pause the renderer after this period of inactivity (in ms).
const pauseAfter = 10 * 1000;

const lightElevation = 1.5;
const lightPosition = [0.75, 0.75, 1.5];
const lightSize = 0.75;
const lightValLightMode = 0.6;
const lightValDarkMode = 0.15;

// Computed value of a fully transparent color, and the color used as fallback.
const transparent = 'rgba(0, 0, 0, 0)';
const white = [1, 1, 1];

const rtxGreen = '#76b900';

// TODO: adjust this based some hardware capabilities?
// navigator.deviceMemory
// GPUSupportedLimits ?
const maxSize = 2048;

let initialized = false;
let backgroundElement;
let backgroundCanvas;
let raisedElements = [];
let ui;
let pauseTimer;

/**
 * Round a size up to the closest power of two.
 * Sizes come from getBoundingClientRect() and can be fractional: the fractional part is
 * dropped, as a canvas can only be an integer number of pixels wide.
 * @param {number} size
 * @returns {number} a power of two
 */
function closestPowerOfTwo(size) {
  const pixels = Math.floor(size);
  if (pixels <= 1) {
    return 1;
  }
  return 2 ** Math.ceil(Math.log2(pixels));
}

/**
 * Extract the background color of an element as an RGB array.
 * Uses the color stored as a data attribute by removeStyle() when present.
 * Only supports the rgb() syntax, returns white for anything else.
 * @param {HTMLElement} element
 * @returns {number[]} [red, green, blue], each between 0 and 1
 */
function extractRGBColor(element) {
  const color = element.dataset.backgroundColor || window.getComputedStyle(element).backgroundColor;

  if (color === transparent) {
    return [...white];
  }

  const channels = color.match(/\d+/g);
  if (!color.startsWith('rgb') || !channels || channels.length < 3) {
    console.error(`Unsupported color format. Only rgb() is supported. returning white. Received ${color}.`);
    return [...white];
  }

  return channels.slice(0, 3).map((channel) => Number(channel) / 255);
}

/**
 * Remove the background color and box shadow of an element, storing them as data attributes.
 * @param {HTMLElement} element
 */
function removeStyle(element) {
  element.style.transition = `box-shadow ${opacityTransition} ease-in-out 0.2s, background-color ${opacityTransition} ease-in-out 0.2s`;

  const { boxShadow, backgroundColor, mixBlendMode } = window.getComputedStyle(element);

  element.dataset.boxShadow = boxShadow;
  element.style.boxShadow = 'none';

  element.dataset.backgroundColor = backgroundColor;
  element.style.backgroundColor = 'transparent';

  // if element has white background,
  // set mix-blend-mode: multiply so that any white children blends nicely with the (now potentially gray) background
  // TODO: Should we do that more often?
  if (backgroundColor === 'rgb(255, 255, 255)') {
    element.dataset.mixBlendMode = mixBlendMode;
    element.style.mixBlendMode = 'multiply';
  }
}

/**
 * Restore the styles saved by removeStyle().
 * @param {HTMLElement} element
 */
function restoreStyle(element) {
  const { boxShadow, backgroundColor, mixBlendMode } = element.dataset;

  if (boxShadow) {
    element.style.boxShadow = boxShadow;
  }
  if (backgroundColor) {
    element.style.backgroundColor = backgroundColor;
  }
  if (mixBlendMode) {
    element.style.mixBlendMode = mixBlendMode;
  }
}

/**
 * Build the scene: the background plane, plus one cube per raised element.
 * @param {HTMLElement} background
 * @param {Iterable<HTMLElement>} elements raised elements
 * @returns {Cube[]} the objects of the scene
 */
function makeScene(background, elements) {
  const backgroundRect = background.getBoundingClientRect();
  let nextObjectId = 0;

  // Background element.
  // For now, always make it white, for a better effect.
  // TODO: Retain the hue
  const objects = [
    new Cube(
      Vector.create([-1, -1, zBase - 1]),
      Vector.create([1, 1, zBase]),
      nextObjectId++,
      Vector.create([...white]),
    ),
  ];

  // Viewport coordinates, normalized between -1 and 1 within the background element.
  // TODO: should we also handle scroll position?
  const toSceneX = (x) => (2 * (x - backgroundRect.left)) / backgroundRect.width - 1;
  const toSceneY = (y) => 1 - (2 * (y - backgroundRect.top)) / backgroundRect.height;

  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    // ignore elements that have no height or width
    if (rect.height === 0 || rect.width === 0) {
      continue;
    }

    objects.push(new Cube(
      Vector.create([toSceneX(rect.left), toSceneY(rect.bottom), zBase]),
      Vector.create([toSceneX(rect.right), toSceneY(rect.top), zBase + zHeight]),
      nextObjectId++,
      Vector.create(extractRGBColor(element)),
    ));
  }

  return objects;
}

/**
 * Return all elements that have a box shadow and are descendants of the passed element
 * @param {HTMLElement} element
 * @returns {HTMLElement[]} all elements with box shadow
 */
function getBoxShadowDescendants(element) {
  return [...element.querySelectorAll('*')]
    .filter((descendant) => window.getComputedStyle(descendant).boxShadow !== 'none');
}

/**
 * Size and position the canvas so that it covers the background element.
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLElement} element background element
 * @param {boolean} [startDisplayed] when false, the canvas starts hidden and fades in
 */
function styleCanvas(canvas, element, startDisplayed = false) {
  const rect = element.getBoundingClientRect();
  const { borderTopWidth, borderLeftWidth } = window.getComputedStyle(element);

  // canvas must be square and of power of two
  // use the element largest width / height and round it up to the next power of two
  const size = Math.min(closestPowerOfTwo(Math.max(rect.width, rect.height)), maxSize);

  canvas.inert = true;
  canvas.width = size;
  canvas.height = size;

  Object.assign(canvas.style, {
    position: 'absolute',
    // offset the position of the canvas by the border width
    // See examples/inside.html to understand why this is needed
    top: `-${borderTopWidth}`,
    left: `-${borderLeftWidth}`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    zIndex: '-1',
    overflow: 'hidden',
  });

  if (!startDisplayed) {
    canvas.style.opacity = '0';
    canvas.style.transition = `opacity ${opacityTransition} ease-in-out`;
  }
}

/**
 * Pause the renderer once the scene has been left untouched for a while.
 */
function schedulePause() {
  clearTimeout(pauseTimer);
  pauseTimer = setTimeout(() => ui.renderer.pause(), pauseAfter);
}

/**
 * Rebuild and render the scene, for example after the page was resized.
 */
function reset() {
  ui.setObjects(makeScene(backgroundElement, raisedElements));
  ui.renderer.resume();
  styleCanvas(backgroundCanvas, backgroundElement, true);
  schedulePause();
}

/**
 * Rebuild the scene when the background element or any raised element is resized.
 */
function observeResize() {
  const resizeObserver = new ResizeObserver(reset);
  resizeObserver.observe(backgroundElement);
  for (const element of raisedElements) {
    resizeObserver.observe(element);
  }
}

/**
 * Move the light under the cursor when clicking on the background element.
 */
function enableMoveLightOnClick() {
  backgroundElement.addEventListener('click', (event) => {
    // ignore links, and clicks that only end a text selection
    if (event.target.tagName === 'A' || window.getSelection().toString()) {
      return;
    }

    // get click coordinates, normalized between -1 and 1
    const rect = backgroundElement.getBoundingClientRect();
    const x = (2 * (event.clientX - rect.left)) / rect.width - 1;
    const y = 1 - (2 * (event.clientY - rect.top)) / rect.height;

    ui.setLightPosition([x, y, lightElevation]);
    reset();
  });
}

/**
 * Reload the page when switching between light and dark mode:
 * the light intensity is picked once, when the effect starts.
 * @param {MediaQueryList} [darkModeQuery]
 */
function observeColorScheme(darkModeQuery) {
  darkModeQuery?.addEventListener('change', () => window.location.reload());
}

/**
 * If the current device supports the Compute Pressure API, use it to disable the effect
 * under 'critical' and 'serious' pressure.
 */
function observePressure() {
  if (!('PressureObserver' in window)) {
    return;
  }

  const observer = new PressureObserver((records) => {
    const state = records.at(-1)?.state;
    if (state === 'critical' || state === 'serious') {
      console.log(`RTX automatically turned off due to ${state} pressure on the CPU.`);
      off();
    }
  });
  observer.observe('cpu');
}

/**
 * Set up the effect: pick the background and raised elements, then start the path tracer.
 * @param {object} [options]
 * @param {HTMLElement} [options.background] element to apply the effect to, defaults to the entire body.
 * @param {HTMLElement[]} [options.raised] elevated elements, defaults to descendants of the background element with box shadow.
 * @param {boolean} [options.disableIfDarkMode] if true, will not apply the effect if the user has dark mode enabled, which dims the light of rtx-on. Defaults to false.
 * @param {boolean} [options.forceLightMode] if true, the effect will always apply at light mode. Defaults to false. Set to true if your website doesn't implement dark mode.
 * @param {boolean} [options.moveLightOnClick] Set to true to move the light under the cursor when clicking the background element. Default to false.
 * @returns {boolean} whether the effect was set up
 */
function initRTX({ background, raised, disableIfDarkMode = false, forceLightMode = false, moveLightOnClick = false } = {}) {
  // Check dark mode
  const darkModeQuery = window.matchMedia?.('(prefers-color-scheme: dark)');
  const darkMode = darkModeQuery?.matches ?? false;

  if (darkMode && disableIfDarkMode) {
    console.warn('Not applying RTX, user has dark mode enabled.');
    return false;
  }
  const lightVal = darkMode && !forceLightMode ? lightValDarkMode : lightValLightMode;

  if (background) {
    backgroundElement = background;
  } else {
    // select the <html> element.
    backgroundElement = document.documentElement;
    // The <html> element might be smaller than the viewport. So we make sure it is at least as big as the viewport.
    backgroundElement.style.minHeight = '100vh';
    // if <body> has a background color, set it on <html> too
    const bodyBackgroundColor = window.getComputedStyle(document.body).backgroundColor;
    if (bodyBackgroundColor !== transparent) {
      backgroundElement.style.backgroundColor = bodyBackgroundColor;
    }
  }

  raisedElements = raised ?? getBoxShadowDescendants(backgroundElement);

  // if height is more than 3x width or width is more than 3x height, skip
  const { width, height } = backgroundElement.getBoundingClientRect();
  if (height > width * 3 || width > height * 3) {
    console.warn(`Not applying RTX, background element is too wide or too tall. height: ${height}, width: ${width}`);
    return false;
  }

  // set position to relative in order to attach the canvas with position absolute
  backgroundElement.style.position = 'relative';

  backgroundCanvas = document.createElement('canvas');
  styleCanvas(backgroundCanvas, backgroundElement);
  backgroundElement.appendChild(backgroundCanvas);

  const config = {
    zoom: 76,
    fov: 1.5,
    lightPosition,
    lightSize,
    lightVal,
  };

  ui = makePathTracer(backgroundCanvas, makeScene(backgroundElement, raisedElements), config, false);

  schedulePause();
  backgroundCanvas.style.opacity = '1';

  observeResize();
  if (moveLightOnClick) {
    enableMoveLightOnClick();
  }
  observeColorScheme(darkModeQuery);
  observePressure();

  initialized = true;
  return true;
}

/**
 * Turn on the ray traced shadow effect.
 * Removes any existing box shadow effect.
 * @param {object} [options] see initRTX(), only used the first time the effect is turned on.
 */
function on(options) {
  if (!initialized) {
    if (!initRTX(options)) {
      return;
    }
  } else {
    // unhide canvas
    ui.renderer.resume();
    backgroundCanvas.style.opacity = '1';
  }

  // remove drop shadow and background color from elements, store them in data attributes
  for (const element of [...raisedElements, backgroundElement]) {
    removeStyle(element);
  }
}

/**
 * Turn off the ray traced shadow effect.
 * Restores any existing box shadow effect.
 */
function off() {
  if (!initialized) {
    return;
  }

  // hide canvas
  backgroundCanvas.style.opacity = '0';

  // restore original styles
  for (const element of [...raisedElements, backgroundElement]) {
    restoreStyle(element);
  }

  ui.renderer.pause();
}

/**
 * Displays an "RTX OFF / ON" button on the page.
 * Mainly for fun.
 * @param {object} [options] see initRTX(), passed to on() when toggling the effect back on.
 */
function button(options) {
  // The checkbox itself is hidden, its label is the visible button.
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.id = 'rtxCheckbox';
  checkbox.checked = true;
  checkbox.style.display = 'none';

  const label = document.createElement('label');
  label.htmlFor = checkbox.id;
  label.id = 'rtxLabel';
  Object.assign(label.style, {
    fontFamily: 'Arial, sans-serif',
    fontSize: '16px',
    padding: '15px 32px',
    textAlign: 'center',
    display: 'inline-block',
    cursor: 'pointer',
    // Set a fixed width and position the label at the bottom right
    width: '100px',
    position: 'fixed',
    bottom: '20px',
    right: '0',
  });

  const render = (isOn) => {
    label.innerHTML = `RTX <strong>${isOn ? 'ON' : 'OFF'}</strong>`;
    label.style.backgroundColor = isOn ? rtxGreen : 'black';
    label.style.color = isOn ? 'black' : 'white';
  };
  render(checkbox.checked);

  // Toggle the RTX state when the checkbox changes
  checkbox.addEventListener('change', () => {
    render(checkbox.checked);
    if (checkbox.checked) {
      on(options);
    } else {
      off();
    }
    console.log(`RTX is ${checkbox.checked ? 'on' : 'off'}.`);
  });

  document.body.append(checkbox, label);
}

export { on, off, button };
