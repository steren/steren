/*
 WebGL Path Tracing (http://madebyevan.com/webgl-path-tracing/)
 License: MIT License

 Copyright (c) 2010 Evan Wallace

 Permission is hereby granted, free of charge, to any person
 obtaining a copy of this software and associated documentation
 files (the "Software"), to deal in the Software without
 restriction, including without limitation the rights to use,
 copy, modify, merge, publish, distribute, sublicense, and/or sell
 copies of the Software, and to permit persons to whom the
 Software is furnished to do so, subject to the following
 conditions:

 The above copyright notice and this permission notice shall be
 included in all copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
 OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
 HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
 WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
 OTHER DEALINGS IN THE SOFTWARE.
*/

// The page facing half of the path tracer. It owns the canvas element and the
// event listeners and nothing else: the tracing itself runs in a worker against
// an OffscreenCanvas (see path-tracer-worker.js), driven by the same core the
// main thread fallback uses (see path-tracer-core.js).
//
// Tracing a frame is not something the main thread can usefully overlap with:
// the renderer measures how long a frame's samples really took by reading a
// pixel back, which blocks until the GPU has caught up, and the sample budget
// then aims to fill most of a frame with that work. On the main thread that
// read blocks the page for as long as it takes, so scrolling, layout, and
// anything else on the page have to wait for the tracer between every frame.
// In a worker it blocks nobody: the page stays responsive at whatever the
// tracer is doing, and a scene heavy enough to run at a few frames a second no
// longer takes the page down with it. Compiling the scene into a shader, which
// happens on every geometry or material change, moves off the main thread with
// it.

import {makePathTracerCore, applyMessage, Sphere, Cube, ExtrudedRectangle,
    serializeObjects, serializeConfig} from './path-tracer-core.js';

/** Whether this browser can hand a canvas to a worker to render into. */
function supportsWorkerRendering(canvas) {
  return typeof Worker !== 'undefined' &&
      typeof canvas.transferControlToOffscreen === 'function';
}

/**
 * Initialize the path tracer on the given canvas
 * @param {HTMLCanvasElement} canvas - Canvas to render to
 * @param {Object[]} objects - Array of Sphere, Cube and ExtrudedRectangle objects
 * @param {Object} [config] - Specify: material, glossiness (0-1), environment, bounces (light bounces per ray), zoom (in distance from center), projection ('perspective' or 'orthographic'), fov (field of view, in degrees, perspective only), orthoHeight (height of the orthographic view in world units, defaults to framing the room), lightPosition ([x,y,z]), lightSize, lightVal (0-1), samplesPerFrame (samples accumulated per animation frame, adaptive by default), worker (false to trace on the main thread instead of in a worker)
 * @param {bool} [interactive=true] - if the user should be able to interact with the scene
 * @param {function} [log] - a function to print log messages to, defaults to console.log
 * @returns {Object} the same controls as the UI object: setObjects, addSphere, addCube, addExtrudedRectangle, selectLight, deleteSelection, setLightPosition, setLightVal, updateMaterial, updateEnvironment, updateProjection, updateOrthoHeight, updateGlossiness, renderer.pause, renderer.resume and dispose
 */
function makePathTracer(canvas, objects, config = {}, interactive = true, log) {
  log = log || console.log;

  // config may hold anything the caller likes, including DOM nodes, and only
  // plain data can be posted to a worker
  var coreConfig = serializeConfig(config);

  ////////////////////////////////////////////////////////////////////////////
  // where the tracer runs
  ////////////////////////////////////////////////////////////////////////////

  // Whether the tracer ends up in a worker is not known synchronously: the
  // worker has to say whether it can render before the canvas is handed over,
  // since that hand over cannot be undone. Until it answers, commands from the
  // page queue up here and are replayed once there is something to run them
  // against.
  var target = null;
  var queue = [];
  var disposed = false;
  var settled = false;

  function send(message) {
    if(disposed) return;
    if(target) target.send(message);
    else queue.push(message);
  }

  function useTarget(newTarget) {
    settled = true;

    if(disposed) {
      newTarget.dispose();
      return;
    }

    target = newTarget;
    for(var i = 0; i < queue.length; i++) {
      target.send(queue[i]);
    }
    queue = [];
  }

  function startLocal() {
    var ui = makePathTracerCore(canvas, objects, coreConfig, log);
    useTarget({
      send: function(message) { applyMessage(ui, message); },
      dispose: function() { if(ui) ui.dispose(); }
    });
  }

  function startWorker() {
    var worker;
    try {
      worker = new Worker(new URL('./path-tracer-worker.js', import.meta.url), {type: 'module'});
    } catch(e) {
      return false;
    }

    // the page and the worker disagree about how a scene is represented: live
    // shapes here, plain data across the message port
    var workerTarget = {
      send: function(message) {
        if(message.type === 'setObjects') {
          worker.postMessage({type: 'setObjects', objects: serializeObjects(message.objects)});
        } else {
          worker.postMessage(message);
        }
      },
      // terminating takes the render loop, the WebGL context and the canvas
      // the worker owns down with the thread, so there is nothing to unwind
      // first
      dispose: function() { worker.terminate(); }
    };

    // Anything that goes wrong before the canvas is handed over is recoverable:
    // render on the main thread instead. Afterwards it is not, since the canvas
    // belongs to the worker for good, so only fall back while `settled` is
    // still false.
    function giveUp() {
      if(settled) return;
      worker.terminate();
      startLocal();
    }

    worker.onerror = giveUp;

    worker.onmessage = function(event) {
      var message = event.data;

      if(message.type === 'probe') {
        if(!message.ok) {
          giveUp();
          return;
        }

        var offscreen;
        try {
          offscreen = canvas.transferControlToOffscreen();
        } catch(e) {
          // the canvas already has a context of its own, so it cannot be
          // transferred
          giveUp();
          return;
        }

        worker.postMessage({
          type: 'init',
          canvas: offscreen,
          objects: serializeObjects(objects),
          config: coreConfig
        }, [offscreen]);

        useTarget(workerTarget);
      } else if(message.type === 'log') {
        log(message.message);
      }
    };

    worker.postMessage({type: 'probe'});
    return true;
  }

  if(config.worker === false || !supportsWorkerRendering(canvas) || !startWorker()) {
    if(!settled) startLocal();
  }

  ////////////////////////////////////////////////////////////////////////////
  // input
  ////////////////////////////////////////////////////////////////////////////

  // Maps a pointer position to a pixel in the canvas drawing buffer. Using the
  // bounding rect handles scrolled and transformed ancestors, which walking
  // offsetParent did not, and the ratio handles a canvas whose CSS size differs
  // from its pixel size (a scaled or high DPI canvas).
  function canvasPixelPos(event) {
    var rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (rect.width ? canvas.width / rect.width : 1),
      y: (event.clientY - rect.top) * (rect.height ? canvas.height / rect.height : 1)
    };
  }

  // Whether a gesture that started on the canvas is still going. What that
  // gesture turned out to be (orbiting the camera or dragging an object) is
  // decided where the scene lives, which may be another thread, so the page
  // only tracks that there is one: moves and releases are forwarded while it
  // lasts and dropped otherwise, which is what the tracer did with them anyway.
  var dragging = false;
  var listeners = [];

  function on(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    listeners.push({ target: target, type: type, handler: handler, options: options });
  }

  function onPointerDown(event) {
    var mouse = canvasPixelPos(event);

    if(mouse.x >= 0 && mouse.x < canvas.width && mouse.y >= 0 && mouse.y < canvas.height) {
      dragging = true;
      send({type: 'pointerdown', x: mouse.x, y: mouse.y});

      // dragging rotates the camera and moves objects, so suppress text selection
      event.preventDefault();
    }
  }

  function onPointerMove(event) {
    if(!dragging) return;
    var mouse = canvasPixelPos(event);
    send({type: 'pointermove', x: mouse.x, y: mouse.y});
  }

  function onPointerUp(event) {
    if(!dragging) return;
    dragging = false;
    var mouse = canvasPixelPos(event);
    send({type: 'pointerup', x: mouse.x, y: mouse.y});
  }

  function isTextEntry(element) {
    if(!element) return false;
    if(element.isContentEditable) return true;
    var tag = element.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  if(interactive) {
    // listeners are registered rather than assigned to document.onmousedown and
    // friends, so that the page (and a second path tracer) keep their handlers
    on(canvas, 'mousedown', onPointerDown);
    // move and up go on the window so a drag that leaves the canvas still works
    on(window, 'mousemove', onPointerMove);
    on(window, 'mouseup', onPointerUp);

    on(document, 'keydown', function(event) {
      // don't eat backspace while the user is typing in a form field: that used
      // to delete the selected object and block the keystroke
      if(isTextEntry(event.target)) return;

      if(event.key === 'Backspace' || event.key === 'Delete') {
        send({type: 'call', method: 'deleteSelection'});

        // don't let the backspace key go back a page
        event.preventDefault();
      }
    });

    // note: the option is `passive`, and it has to be false for preventDefault()
    // to be honoured. It was misspelled, so dragging on the canvas scrolled the
    // page on touch devices instead of orbiting the camera.
    on(canvas, 'touchstart', function(event) {
      if(event.touches.length === 1) {
        onPointerDown(event.touches[0]);
        event.preventDefault();
      } else {
        dragging = false;
        send({type: 'pointercancel'});
      }
    }, { passive: false });

    on(window, 'touchmove', function(event) {
      if(event.touches.length === 1 && dragging) {
        onPointerMove(event.touches[0]);
        event.preventDefault();
      }
    }, { passive: false });

    on(window, 'touchend', function(event) {
      if(event.changedTouches.length > 0) onPointerUp(event.changedTouches[0]);
      dragging = false;
    }, { passive: false });

    on(window, 'touchcancel', function() {
      dragging = false;
      send({type: 'pointercancel'});
    }, { passive: false });
  }

  ////////////////////////////////////////////////////////////////////////////
  // controls
  ////////////////////////////////////////////////////////////////////////////

  function call(method) {
    var args = Array.prototype.slice.call(arguments, 1);
    send({type: 'call', method: method, args: args});
  }

  var api = {
    renderer: {
      pause: function() { send({type: 'pause'}); },
      resume: function() { send({type: 'resume'}); }
    },

    setObjects: function(objects) { send({type: 'setObjects', objects: objects}); },

    selectLight: function() { call('selectLight'); },
    addSphere: function() { call('addSphere'); },
    addCube: function() { call('addCube'); },
    addExtrudedRectangle: function() { call('addExtrudedRectangle'); },
    deleteSelection: function() { call('deleteSelection'); },

    setLightPosition: function(position) { call('setLightPosition', position); },
    setLightVal: function(val) { call('setLightVal', val); },

    updateMaterial: function(material) { call('updateMaterial', material); },
    updateEnvironment: function(environment) { call('updateEnvironment', environment); },
    updateProjection: function(projection) { call('updateProjection', projection); },
    updateOrthoHeight: function(height) { call('updateOrthoHeight', height); },
    updateGlossiness: function(glossiness) { call('updateGlossiness', glossiness); },

    /** Stop rendering and detach every listener this instance installed. */
    dispose: function() {
      disposed = true;
      queue = [];

      if(target) {
        target.dispose();
        target = null;
      }

      for(var i = 0; i < listeners.length; i++) {
        var listener = listeners[i];
        listener.target.removeEventListener(listener.type, listener.handler, listener.options);
      }
      listeners = [];
    }
  };

  return api;
};

export {makePathTracer, Sphere, Cube, ExtrudedRectangle}
