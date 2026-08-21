/*
 WebGL Path Tracing (http://madebyevan.com/webgl-path-tracing/)
 License: MIT License (see webgl-path-tracing.js)
*/

// Worker side of the path tracer. It owns the WebGL context, the scene and the
// render loop; the page keeps only the canvas element and its event listeners.
// Everything here runs against an OffscreenCanvas transferred in by the page,
// so a frame of tracing, and the blocking read that times it, costs the main
// thread nothing.

import {makePathTracerCore, applyMessage, deserializeObjects} from './path-tracer-core.js';

var ui = null;

function log(message) {
  self.postMessage({type: 'log', message: message});
}

// Whether this worker can path trace at all, checked on a throwaway canvas
// before the page hands over the real one: transferControlToOffscreen() cannot
// be undone, so a browser that has OffscreenCanvas but no WebGL inside a worker
// has to be caught while the page can still fall back to rendering itself.
function canRender() {
  if(typeof OffscreenCanvas === 'undefined') return false;

  try {
    var canvas = new OffscreenCanvas(1, 1);
    var context = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if(!context) return false;
    // contexts are a limited resource and the real one is about to be created,
    // so drop this one now instead of waiting for the canvas to be collected
    var lose = context.getExtension('WEBGL_lose_context');
    if(lose) lose.loseContext();
    return true;
  } catch(e) {
    return false;
  }
}

self.onmessage = function(event) {
  var message = event.data;

  // An exception in here would otherwise go nowhere: a worker's uncaught errors
  // do not reach the page's console, and the tracer would silently keep drawing
  // whatever it was drawing before the failed command. Report it through the
  // page's log instead, which is where the rest of the tracer's failures go.
  try {
    handle(message);
  } catch(e) {
    log('Path tracer error: ' + (e && e.message ? e.message : e));
  }
};

function handle(message) {
  switch(message.type) {
    case 'probe':
      self.postMessage({type: 'probe', ok: canRender()});
      break;

    case 'init':
      ui = makePathTracerCore(message.canvas, deserializeObjects(message.objects), message.config, log);
      self.postMessage({type: 'ready', ok: !!ui});
      break;

    case 'setObjects':
      // shapes arrive as plain data, since structured clone drops the
      // prototypes that generate the shader
      applyMessage(ui, {type: 'setObjects', objects: deserializeObjects(message.objects)});
      break;

    default:
      applyMessage(ui, message);
      break;
  }
}
