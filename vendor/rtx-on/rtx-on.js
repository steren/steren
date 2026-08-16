import { makePathTracer, Cube, ExtrudedRectangle } from 'webgl-path-tracing';
import { Vector } from 'sylvester';

// Height of the raised elements, in scene units.
const zHeight = 0.1;
// Z coordinate of the background plane (-1 is the room wall).
const zBase = 0;
// Time to make the effect appear.
const opacityTransition = '0.5s';
// Pause the renderer after this period of inactivity (in ms).
const pauseAfter = 10 * 1000;

// Camera. The field of view and this zoom, the distance of the camera to the scene, are
// picked so that a square canvas frames exactly [-1, 1] on both axes.
const squareZoom = 76;
const fov = 1.5;

const lightElevation = 1.5;
// Light position, normalized between -1 and 1 within the background element.
// Scaled to the extent of the scene to get scene coordinates.
const defaultLightPosition = [0.75, 0.75, lightElevation];
const lightSize = 0.75;
const lightValLightMode = 0.6;
const lightValDarkMode = 0.15;

// Computed value of a fully transparent color, and the color used as fallback.
const transparent = 'rgba(0, 0, 0, 0)';
const white = [1, 1, 1];

// The four corner radii of an element, as computed style properties.
const borderRadiusProperties = [
  'borderTopLeftRadius',
  'borderTopRightRadius',
  'borderBottomRightRadius',
  'borderBottomLeftRadius',
];

const rtxGreen = '#76b900';

// Largest dimension of the canvas, in pixels. Bigger elements are rendered into a
// smaller canvas that CSS scales back up.
// TODO: adjust this based some hardware capabilities?
// navigator.deviceMemory
// GPUSupportedLimits ?
const maxSize = 2048;
// Sides of the drawing buffer are rounded up to a ladder of sizes with this many steps per
// doubling, so that resizing only rebuilds the path tracer when a side crosses a step instead
// of on every pixel. The canvas is stretched back to the exact size of the element, so a
// buffer whose proportions are off by a step stretches the image by as much: more steps means
// a more faithful image, fewer steps means fewer rebuilds.
const sizeStepsPerDoubling = 8;
// The drawing buffer covers the element at this many pixels per CSS pixel. Tracing cost grows
// with the square of it, and what is being drawn is a soft shadow rather than fine detail, so
// it stays at one rather than following the pixel density of the screen: on a high density
// screen the buffer is stretched over more device pixels, which is hard to notice on a
// gradient and much cheaper to trace.
const pixelRatio = 1;

let initialized = false;
let enabled = false;
let backgroundElement;
let backgroundCanvas;
let raisedElements = [];
let ui;
let lightVal;
let lightPosition = [...defaultLightPosition];
let pauseTimer;

/**
 * Round a size up to the next step of the ladder of drawing buffer sizes.
 * @param {number} size in pixels
 * @returns {number} rounded size, in whole pixels
 */
function bucketSize(size) {
  const steps = Math.ceil(Math.log2(Math.max(1, size)) * sizeStepsPerDoubling);

  return Math.ceil(2 ** (steps / sizeStepsPerDoubling));
}

/**
 * Size of the canvas drawing buffer for a background element of the given size.
 * The path tracer renders at any canvas size, so the buffer covers the element at pixelRatio,
 * rounded up to the next step of the ladder and never above maxSize.
 * Sizes come from getBoundingClientRect() and can be fractional: a canvas can only be an
 * integer number of pixels wide.
 * @param {DOMRect} rect size of the background element
 * @returns {{width: number, height: number}} size of the drawing buffer, in pixels
 */
function canvasSize({ width, height }) {
  const scale = Math.min(pixelRatio, maxSize / Math.max(width, height));

  return {
    width: Math.min(maxSize, bucketSize(width * scale)),
    height: Math.min(maxSize, bucketSize(height * scale)),
  };
}

/**
 * How much of the scene the canvas frames, and the matching camera zoom.
 * The path tracer keeps the vertical field of view of its camera and widens the horizontal one
 * to match the aspect ratio of the drawing buffer, and it renders inside a room, a cube
 * spanning [-1, 1] on every axis. So the scene is normalized to [-1, 1] along the largest side
 * of the buffer, to keep it within the room, and the camera is moved closer by as much so that
 * the scene still fills the canvas. This has to follow the drawing buffer rather than the
 * element: the two only have the same proportions until the buffer is rounded up to a step.
 * @param {HTMLCanvasElement} canvas
 * @returns {{halfWidth: number, halfHeight: number, zoom: number}} half extent of the scene, and camera zoom
 */
function sceneExtent({ width, height }) {
  const aspect = height > 0 ? width / height : 1;
  const scale = Math.max(1, aspect);

  return {
    halfWidth: aspect / scale,
    halfHeight: 1 / scale,
    zoom: squareZoom / scale,
  };
}

/**
 * Position of the light in scene coordinates.
 * @param {HTMLCanvasElement} canvas
 * @returns {number[]} [x, y, z]
 */
function sceneLightPosition(canvas) {
  const { halfWidth, halfHeight } = sceneExtent(canvas);
  const [x, y, z] = lightPosition;

  return [x * halfWidth, y * halfHeight, z];
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
 * Resolve one component of a corner radius to pixels.
 * Computed styles give lengths in pixels, but keep percentages as they were written: a
 * percentage of the width for the horizontal component, of the height for the vertical one.
 * @param {string} value computed value of the component
 * @param {number} extent size of the element along the axis of that component, in pixels
 * @returns {number} radius in pixels
 */
function resolveRadiusComponent(value, extent) {
  const amount = Number.parseFloat(value);

  if (!Number.isFinite(amount) || amount <= 0) {
    return 0;
  }

  return value.endsWith('%') ? (amount * extent) / 100 : amount;
}

/**
 * Border radius of an element, in pixels.
 * The scene shape only has a single radius, shared by its four corners, so elliptical corners
 * are reduced to their smaller component and the four corners are averaged: an element with
 * mixed radii gets the roundness it has on average, and one with a uniform radius, by far the
 * common case, gets exactly its own.
 * @param {HTMLElement} element
 * @param {DOMRect} rect size of the element
 * @returns {number} radius in pixels, 0 when the element has square corners
 */
function extractBorderRadius(element, { width, height }) {
  const style = window.getComputedStyle(element);

  const radii = borderRadiusProperties.map((property) => {
    // elliptical corners are computed as two components, "10px 20px", circular ones as one
    const [horizontal, vertical = horizontal] = style[property].split(' ');

    return Math.min(
      resolveRadiusComponent(horizontal, width),
      resolveRadiusComponent(vertical, height),
    );
  });

  return radii.reduce((total, radius) => total + radius, 0) / radii.length;
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
  // the scene is framed by the canvas, and the element is mapped onto that frame below
  const { halfWidth, halfHeight } = sceneExtent(backgroundCanvas);
  let nextObjectId = 0;

  // Background element, covering the entire floor of the room.
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

  // Viewport coordinates, normalized to the extent of the scene within the background element.
  // TODO: should we also handle scroll position?
  const toSceneX = (x) => halfWidth * ((2 * (x - backgroundRect.left)) / backgroundRect.width - 1);
  const toSceneY = (y) => halfHeight * (1 - (2 * (y - backgroundRect.top)) / backgroundRect.height);
  // Lengths keep their proportions: the scene is normalized by the same factor on both axes.
  const toSceneLength = (length) => (backgroundRect.height > 0
    ? (2 * halfHeight * length) / backgroundRect.height
    : 0);

  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    // ignore elements that have no height or width
    if (rect.height === 0 || rect.width === 0) {
      continue;
    }

    const minCorner = Vector.create([toSceneX(rect.left), toSceneY(rect.bottom), zBase]);
    const maxCorner = Vector.create([toSceneX(rect.right), toSceneY(rect.top), zBase + zHeight]);
    const color = Vector.create(extractRGBColor(element));
    const borderRadius = toSceneLength(extractBorderRadius(element, rect));

    // A rounded element is extruded towards the camera, so that the corners of the face it
    // shows are the ones rounded off. Square elements stay cubes: the shape is cheaper to
    // trace, and both give the same result at a radius of zero.
    objects.push(borderRadius > 0
      ? new ExtrudedRectangle(minCorner, maxCorner, borderRadius, nextObjectId++, color, 'z')
      : new Cube(minCorner, maxCorner, nextObjectId++, color));
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

  // the canvas can be of any size, so give it the size of the element it covers
  const { width, height } = canvasSize(rect);

  canvas.inert = true;
  // only assign when the size actually changes: assigning resets the drawing buffer
  if (canvas.width !== width) {
    canvas.width = width;
  }
  if (canvas.height !== height) {
    canvas.height = height;
  }

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
 * Start the path tracer on the current canvas.
 */
function startPathTracer() {
  const config = {
    zoom: sceneExtent(backgroundCanvas).zoom,
    fov,
    lightPosition: sceneLightPosition(backgroundCanvas),
    lightSize,
    lightVal,
  };

  ui = makePathTracer(backgroundCanvas, makeScene(backgroundElement, raisedElements), config, false);
  schedulePause();
}

/**
 * The WebGL context a canvas was initialized with, or null if it has none.
 * @param {HTMLCanvasElement} canvas
 * @returns {?WebGLRenderingContext}
 */
function canvasContext(canvas) {
  // getContext() returns the context the canvas already has, and null for the types it was
  // not initialized with, so this never creates one
  for (const type of ['webgl2', 'webgl', 'experimental-webgl']) {
    const gl = canvas.getContext(type);
    if (gl) {
      return gl;
    }
  }
  return null;
}

/**
 * Restart the path tracer after the drawing buffer was resized.
 * The renderer bakes the size of the buffer into its shaders and its accumulation textures,
 * and neither can be resized, so it has to be built again. It is rebuilt on the same canvas:
 * makePathTracer() reads the new size off it and reuses its WebGL context, which is by far
 * the most expensive thing to create.
 */
function restartPathTracer() {
  startPathTracer();

  // the viewport of a context is only ever set when the context is created, so it still
  // covers the previous size of the drawing buffer
  canvasContext(backgroundCanvas)?.viewport(0, 0, backgroundCanvas.width, backgroundCanvas.height);
}

/**
 * Rebuild and render the scene, for example after the page was resized.
 */
function reset() {
  const { width, height } = canvasSize(backgroundElement.getBoundingClientRect());
  const resized = width !== backgroundCanvas.width || height !== backgroundCanvas.height;

  // the canvas has to carry its new size before the path tracer reads it back
  styleCanvas(backgroundCanvas, backgroundElement, true);

  if (resized) {
    restartPathTracer();
  } else {
    // the buffer still fits, so only the scene has to be rebuilt, which is much cheaper
    ui.setObjects(makeScene(backgroundElement, raisedElements));
  }

  if (enabled) {
    ui.renderer.resume();
  } else {
    ui.renderer.pause();
  }
  schedulePause();
}

/**
 * Rebuild the scene when the background element or any raised element is resized.
 * Rebuilding is immediate, so that the effect follows the layout: a ResizeObserver already
 * reports at most once per animation frame, however many changes went into that frame.
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

    // stored normalized, so that the light stays under the cursor when the page is resized
    lightPosition = [x, y, lightElevation];
    ui.setLightPosition(sceneLightPosition(backgroundCanvas));
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
  lightVal = darkMode && !forceLightMode ? lightValDarkMode : lightValLightMode;

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

  // The canvas can be of any size, but the height of the raised elements and the elevation of
  // the light are fixed in scene units, and the scene shrinks along the smallest side of the
  // background element: extreme aspect ratios would make the elements look like towers.
  // So if height is more than 3x width or width is more than 3x height, skip
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

  startPathTracer();
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
  enabled = true;

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

  enabled = false;

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
