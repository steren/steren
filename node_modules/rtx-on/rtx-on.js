import {makePathTracer, Cube} from 'webgl-path-tracing';
import {Vector} from 'sylvester';

// Height of the elements
const zHeight = 0.1;
// Time to make the effect appear.
const opacityTransition = "1s";

const lightPosition = [0.75, 0.75, 1.5];
const lightSize = 0.75;
const lightVal = 0.6;

// TODO: adjust this based some hardware capabilities?
// navigator.deviceMemory
// GPUSupportedLimits ?
const maxSize = 2048;

let initialized = false;
let active = false;
let backgroundElement;
let backgroundCanvas;
let raisedElements;


function closestPowerOfTwo(num) {
  // If num is already a power of two, return num
  if ((num & (num - 1)) === 0) {
    return num;
  }

  // Find the nearest power of two greater than num
  let power = 1;
  while (power < num) {
    power *= 2;
  }

  return power;
}

/**
 * Extract background color (stored as data attribute) of element as RGB array.
 * Only supports rgb() syntax
 * If cannot extract colors, will return white.
 * @param {HTMLElement} element 
 * @returns 
 */
function extractRGBColor(element) {
	const color = element.dataset.backgroundColor || window.getComputedStyle(element).backgroundColor;
	if(color.startsWith('rgb')) {
		const rgb = color.match(/(\d+)/g);
		return [parseInt(rgb[0]) / 255, parseInt(rgb[1]) / 255, parseInt(rgb[2]) / 255];
	} else {
		console.error(`Unsupported color format. Only rgb() is supported. returning white. Received ${color}.`);
		return [1, 1, 1];
	}
}

// Remove background color and box shadow from element
function removeStyle(element) {

	element.style.transition = `box-shadow ${opacityTransition} ease-in-out, background-color ${opacityTransition} ease-in-out`; 

	// store original box shadow in a data attribute
	element.dataset.boxShadow = window.getComputedStyle(element).boxShadow;
	element.style.boxShadow = 'none';

	// store original background color in a data attribute
	element.dataset.backgroundColor = window.getComputedStyle(element).backgroundColor;
	element.style.backgroundColor = 'transparent';

	// if element has white background,
	// set mix-blend-mode: multiply so that any white children blends nicely with the (now potentially gray) background
	// TODO: Should we do that more often?
	if(element.dataset.backgroundColor === 'rgb(255, 255, 255)') {
		element.dataset.mixBlendMode = window.getComputedStyle(element).mixBlendMode;
		element.style.mixBlendMode = 'multiply';
	}
}

function restoreStyle (element) {
	if(element.dataset.boxShadow) {
		element.style.boxShadow = element.dataset.boxShadow;
	}
	if(element.dataset.backgroundColor) {
		element.style.backgroundColor = element.dataset.backgroundColor;
	}
	if(element.dataset.mixBlendMode) {
		element.style.mixBlendMode = element.dataset.mixBlendMode;
	}
}

function makeScene(background, elements) {
	const zBase = 0; // -1 is room wall.
  var objects = [];
  let nextObjectId = 0;

	// background element
	objects.push(new Cube(Vector.create([-1, -1, zBase - 1 ]), Vector.create([1, 1, zBase]), nextObjectId++, Vector.create(extractRGBColor(background))));

	for (let el = 0; el < elements.length; el++) {
		let rect = elements[el].getBoundingClientRect();
		// ignore elements that have no height or width
		if(rect.height === 0 || rect.width === 0) continue;

		// TODO: should we also handle scroll position?
		let minCorner = Vector.create([
			2 * rect.left / (background.clientWidth) - 1,
			-1 * (2 * (rect.top + rect.height) / (background.clientHeight) - 1),

			zBase,
		]);

		let maxCorner = Vector.create([
			2 * (rect.left + rect.width) / (background.clientWidth) - 1,
			-1 * (2 * rect.top / (background.clientHeight) - 1),
			zHeight + zBase,
		]);

		objects.push(new Cube(minCorner, maxCorner, nextObjectId++, Vector.create(extractRGBColor(elements[el]))));
	}

  return objects;
}

/**
 * 
 * @param {HTMLElement} options.background : element to apply the effect to, defaults to the entire body.
 * @param {HTMLElement} options.raised[]: elevated elements, defaults to children of the background element if one is passed or to children of the body if none.
 * @param {bool} options.disableIfDarkMode: if true, will not apply the effect if the user has dark mode enabled. Defaults to false.
 * @param {bool} options.enableForAllAspectRatio: Set to `true` to force enable the effect on any aspect ratio. By default, the effect only applies if the page isn't too wide or high.
 */
function initRTX({background, raised, disableIfDarkMode} = {}) {
	if(disableIfDarkMode && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
		console.warn(`Not applying RTX, user has dark mode enabled.`);
		return false;
	}

	if(raised) {
		raisedElements = raised;
	} else {
		if(background) {
			raisedElements = backgroundElement.children;
		} else {
			raisedElements = document.body.children;
		}
	}

	if(!background) {
		// use <body> if bigger than viewport. Otherwise, use <html>, which is equal to viewport height
		if(document.documentElement.clientHeight > document.body.clientHeight) {
			backgroundElement = document.documentElement;
			// if body has a background color, set it on body too
			if(window.getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)') {
				backgroundElement.style.backgroundColor = window.getComputedStyle(document.body).backgroundColor;
			}

		} else {
			backgroundElement = document.body;
			// if html has a background color, set it on body too
			if(window.getComputedStyle(document.documentElement).backgroundColor !== 'rgba(0, 0, 0, 0)') {
				backgroundElement.style.backgroundColor = window.getComputedStyle(document.documentElement).backgroundColor;
			}
		}
	} else {
		backgroundElement = background;
	}
	
	// if height is more than 2x width or width is more than 2x height, skip
	if(backgroundElement.clientHeight > backgroundElement.clientWidth * 2 || backgroundElement.clientWidth > backgroundElement.clientHeight * 2) {
		console.warn(`Not applying RTX, background element is too wide or too tall. height: ${backgroundElement.clientHeight}, width: ${backgroundElement.clientWidth}`);
		return false;
	}

	// canvas must be square and of power of two
	// use the element largest width / height and round it up to the next power of two
	let size = Math.min(closestPowerOfTwo(Math.max(backgroundElement.clientWidth, backgroundElement.clientHeight)), maxSize);

	backgroundCanvas = document.createElement('canvas');
	backgroundCanvas.inert = true;
	backgroundCanvas.width = size;
	backgroundCanvas.height = size;
	backgroundCanvas.style.position = 'absolute';
	backgroundCanvas.style.top = '0';
	backgroundCanvas.style.left = '0';
	backgroundCanvas.style.width = `${backgroundElement.clientWidth}px`;
	backgroundCanvas.style.height = `${backgroundElement.clientHeight}px`;
	backgroundCanvas.style.zIndex = '-1';
	backgroundCanvas.style.overflow = 'hidden';
	backgroundCanvas.style.opacity = 0;
	backgroundCanvas.style.transition = `opacity ${opacityTransition} ease-in-out`; 
	backgroundElement.appendChild(backgroundCanvas);

	const config = {
		zoom: 76,
		fov: 1.5,
		lightPosition,
		lightSize,
		lightVal,
	}

	const ui = makePathTracer(backgroundCanvas, makeScene(backgroundElement, raisedElements), config, false);

	backgroundCanvas.style.opacity = 1;

	// listen for resize on the base element or any scene element
	const resizeObserver = new ResizeObserver(() => {
			ui.setObjects(makeScene(backgroundElement, raisedElements));
			backgroundCanvas.style.width = `${backgroundElement.clientWidth}px`;
			backgroundCanvas.style.height = `${backgroundElement.clientHeight}px`;
			// TODO: if element changes size, we could create a bigger / smaller canvas. But this requires re-building the path tracer.
	});
	resizeObserver.observe(backgroundElement);
	for(let el of raisedElements) {
		resizeObserver.observe(el);
	}

	initialized = true;
}

function on(options) {
	if(!initialized) {
		initRTX(options);
	} else {
		// unhide canvas
		backgroundCanvas.style.opacity = 1;
	}

	if(initialized) {
		// remove drop shadow and background color from elements, store them in data attributes
		[...raisedElements, backgroundElement].map(removeStyle);
	}

	active = true;
}

/**
 * Restore 
 */
function off() {
	// hide canvas
	backgroundCanvas.style.opacity = 0;

	// restore original styles
	[...raisedElements, backgroundElement].map(restoreStyle);

	axctive = false;
}

/**
 * Displays an "RTX OFF / ON" button on the page.
 * Mainly for fun.
 */
function button(options) {
	// Create the checkbox element
	let rtxCheckbox = document.createElement('input');
	rtxCheckbox.type = 'checkbox';
	rtxCheckbox.id = 'rtxCheckbox'; // add an id to the checkbox for styling

	// Set the initial checkbox state
	rtxCheckbox.checked = true;

	// Set the common checkbox styles
	rtxCheckbox.style.display = 'none'; // Hide the actual checkbox

	// Create a label for the checkbox
	let rtxLabel = document.createElement('label');
	rtxLabel.htmlFor = 'rtxCheckbox';
	rtxLabel.id = 'rtxLabel'; // add an id to the label for styling
	rtxLabel.style.backgroundColor = '#76b900';
	rtxLabel.style.color = 'black';
	rtxLabel.style.fontFamily = 'Arial, sans-serif';
	rtxLabel.style.padding = '15px 32px';
	rtxLabel.style.textAlign = 'center';
	rtxLabel.style.display = 'inline-block';
	rtxLabel.style.fontSize = '16px';
	rtxLabel.style.cursor = 'pointer';
	rtxLabel.innerHTML = 'RTX <strong>ON</strong>';

	// Set the width and position of the label
	rtxLabel.style.width = '100px'; // Set a fixed width
	rtxLabel.style.position = 'fixed';
	rtxLabel.style.bottom = '20px';
	rtxLabel.style.right = '0'; // Position the label at the right

	// Add a change event to toggle RTX state
	rtxCheckbox.onchange = function() {
			rtxLabel.innerHTML = this.checked ? 'RTX <strong>ON</strong>' : 'RTX <strong>OFF</strong>';
			if (this.checked) {
					rtxLabel.style.backgroundColor = '#76b900';
					rtxLabel.style.color = 'black';
					on(options);
			} else {
					rtxLabel.style.backgroundColor = 'black';
					rtxLabel.style.color = 'white';
					off();
			}
			console.log(`RTX is ${this.checked ? "on" : "off"}.`);
	};

	// Add the checkbox and the label to the body of the document
	document.body.appendChild(rtxCheckbox);
	document.body.appendChild(rtxLabel);
}

export {on, off, button};
