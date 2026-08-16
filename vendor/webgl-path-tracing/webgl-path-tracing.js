/*
 WebGL Path Tracing (http://madebyevan.com/webgl-path-tracing/)
 License: MIT License (see below)

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

import {Vector, Matrix, makeLookAt, makePerspective} from './glUtils.js';

////////////////////////////////////////////////////////////////////////////////
// shader strings
////////////////////////////////////////////////////////////////////////////////

var defaultSurfaceColor = 0.75
var defaultSurfaceColorStr = "" + defaultSurfaceColor;

// vertex shader for drawing a textured quad
var renderVertexSource =
` attribute vec3 vertex;
  varying vec2 texCoord;
  void main() {
   texCoord = vertex.xy * 0.5 + 0.5;
   gl_Position = vec4(vertex, 1.0);
  }`;

// fragment shader for drawing a textured quad
var renderFragmentSource =
` precision highp float;
  varying vec2 texCoord;
  uniform sampler2D texture;
  void main() {
    gl_FragColor = texture2D(texture, texCoord);
  }`;

// vertex shader for drawing a line
var lineVertexSource =
` attribute vec3 vertex;
  uniform vec3 cubeMin;
  uniform vec3 cubeMax;
  uniform mat4 modelviewProjection;
  void main() {
    gl_Position = modelviewProjection * vec4(mix(cubeMin, cubeMax, vertex), 1.0);
  }`;

// fragment shader for drawing a line
var lineFragmentSource =
` precision highp float;
  void main() {
    gl_FragColor = vec4(1.0);
  }`;

// constants for the shaders
const epsilon = '0.0001';
const infinity = '10000.0';

// GLSL ES has no implicit int -> float conversion, so every number baked into
// the generated shader source has to carry a decimal point (or an exponent).
function glFloat(value) {
  var text = Number(value).toString();
  return /[.eE]/.test(text) ? text : text + '.0';
}

// vertex shader, interpolate ray per-pixel
var tracerVertexSource =
' attribute vec3 vertex;' +
' uniform vec3 eye, ray00, ray01, ray10, ray11;' +
' varying vec3 initialRay;' +
' void main() {' +
'   vec2 percent = vertex.xy * 0.5 + 0.5;' +
'   initialRay = mix(mix(ray00, ray01, percent.y), mix(ray10, ray11, percent.y), percent.x);' +
'   gl_Position = vec4(vertex, 1.0);' +
' }';

// start of fragment shader
var tracerFragmentSourceHeader =
' precision highp float;' +
' uniform vec3 eye;' +
' varying vec3 initialRay;' +
' uniform float textureWeight;' +
' uniform float timeSinceStart;' +
' uniform sampler2D texture;' +
' uniform float glossiness;' +
' vec3 roomCubeMin = vec3(-1.0, -1.0, -1.0);' +
' vec3 roomCubeMax = vec3(1.0, 1.0, 1.0);';

// compute the near and far intersections of the cube (stored in the x and y components) using the slab method
// no intersection means vec.x > vec.y (really tNear > tFar)
var intersectCubeSource =
' vec2 intersectCube(vec3 origin, vec3 ray, vec3 cubeMin, vec3 cubeMax) {' +
'   vec3 tMin = (cubeMin - origin) / ray;' +
'   vec3 tMax = (cubeMax - origin) / ray;' +
'   vec3 t1 = min(tMin, tMax);' +
'   vec3 t2 = max(tMin, tMax);' +
'   float tNear = max(max(t1.x, t1.y), t1.z);' +
'   float tFar = min(min(t2.x, t2.y), t2.z);' +
'   return vec2(tNear, tFar);' +
' }';

// given that hit is a point on the cube, what is the surface normal?
// The hit is normalized into the cube's own [-1, 1] space so the face with the
// largest coordinate is the one that was hit. That is both branch free and
// scale independent: an absolute epsilon would misclassify very thin cubes.
var normalForCubeSource =
' vec3 normalForCube(vec3 hit, vec3 cubeMin, vec3 cubeMax)' +
' {' +
'   vec3 halfSize = max((cubeMax - cubeMin) * 0.5, vec3(' + epsilon + '));' +
'   vec3 d = (hit - (cubeMin + cubeMax) * 0.5) / halfSize;' +
'   vec3 a = abs(d);' +
'   return sign(d) * step(a.yzx, a) * step(a.zxy, a);' +
' }';

// merge one convex piece of a shape into the running [near, far] interval.
// Pieces that the ray misses come in with near > far and leave it untouched.
var unionIntervalSource =
' vec2 unionInterval(vec2 interval, vec2 piece) {' +
'   if(piece.x >= piece.y) return interval;' +
'   return vec2(min(interval.x, piece.x), max(interval.y, piece.y));' +
' }';

// compute the near and far intersections of an infinitely long cylinder of the
// given radius, centered on the line through `center` along `axis` (a unit
// vector along x, y or z). The problem is the 2D ray/circle one in the plane
// perpendicular to the axis, so the axis aligned components are projected out.
var intersectAxisCylinderSource =
' vec2 intersectAxisCylinder(vec3 origin, vec3 ray, vec3 center, float radius, vec3 axis) {' +
'   vec3 toAxis = origin - center;' +
'   toAxis -= axis * dot(toAxis, axis);' +
'   vec3 flatRay = ray - axis * dot(ray, axis);' +
'   float a = dot(flatRay, flatRay);' +
'   float c = dot(toAxis, toAxis) - radius * radius;' +
    // a ray running along the axis never crosses the surface: it is either
    // inside for its whole length or outside for all of it
'   if(a < 1e-12) {' +
'     if(c < 0.0) return vec2(-' + infinity + ', ' + infinity + ');' +
'     return vec2(' + infinity + ', -' + infinity + ');' +
'   }' +
'   float b = 2.0 * dot(toAxis, flatRay);' +
'   float discriminant = b * b - 4.0 * a * c;' +
'   if(discriminant < 0.0) return vec2(' + infinity + ', -' + infinity + ');' +
'   float root = sqrt(discriminant);' +
'   return vec2((-b - root) / (2.0 * a), (-b + root) / (2.0 * a));' +
' }';

// compute the near and far intersections of a rectangle with rounded corners
// extruded along `axis` (a unit vector along x, y or z): the cross section is
// the rectangle of the box with its four corners rounded off by `radius`, and
// the two ends of the extrusion are flat.
//
// The solid is convex, so a ray crosses it over a single interval. It is
// covered by six convex pieces (two boxes crossing each other in a plus shape,
// plus the four corner cylinders), so that interval is simply the union of the
// intervals of the pieces. The cylinders are infinite and have to be clipped
// to the extruded extent first; the two boxes are already bounded.
var intersectExtrudedRectangleSource =
' vec2 intersectExtrudedRectangle(vec3 origin, vec3 ray, vec3 boxMin, vec3 boxMax, float radius, vec3 axis) {' +
'   vec3 center = (boxMin + boxMax) * 0.5;' +
'   vec3 halfSize = (boxMax - boxMin) * 0.5;' +
    // the two cross section axes: for axis = (0, 0, 1) these are x and y
'   vec3 u = axis.zxy;' +
'   vec3 v = axis.yzx;' +

'   vec3 halfU = halfSize - radius * v;' +
'   vec3 halfV = halfSize - radius * u;' +
'   vec2 interval = vec2(' + infinity + ', -' + infinity + ');' +
'   interval = unionInterval(interval, intersectCube(origin, ray, center - halfU, center + halfU));' +
'   interval = unionInterval(interval, intersectCube(origin, ray, center - halfV, center + halfV));' +

    // where the ray is between the two flat ends
'   float axisRay = dot(ray, axis);' +
'   float axisOrigin = dot(origin, axis) - dot(center, axis);' +
'   float axisHalf = dot(halfSize, axis);' +
'   vec2 ends;' +
'   if(abs(axisRay) > 1e-12) {' +
'     float end1 = (-axisHalf - axisOrigin) / axisRay;' +
'     float end2 = (axisHalf - axisOrigin) / axisRay;' +
'     ends = vec2(min(end1, end2), max(end1, end2));' +
'   } else if(abs(axisOrigin) <= axisHalf) {' +
'     ends = vec2(-' + infinity + ', ' + infinity + ');' +
'   } else {' +
'     ends = vec2(' + infinity + ', -' + infinity + ');' +
'   }' +

    // the corner cylinders are centered on the corners of the box shrunk by
    // the radius, which is exactly the box the rounded shape is the sweep of
'   vec3 offsetU = (halfSize - radius * u) * u;' +
'   vec3 offsetV = (halfSize - radius * v) * v;' +
'   for(int corner = 0; corner < 4; corner++) {' +
'     vec3 cornerCenter = center +' +
'         (corner < 2 ? offsetU : -offsetU) +' +
'         (corner == 0 || corner == 2 ? offsetV : -offsetV);' +
'     vec2 cylinder = intersectAxisCylinder(origin, ray, cornerCenter, radius, axis);' +
'     interval = unionInterval(interval, vec2(max(cylinder.x, ends.x), min(cylinder.y, ends.y)));' +
'   }' +

'   return interval;' +
' }';

// given that hit is a point on the extruded rectangle, what is the surface
// normal? The hit is either on one of the two flat ends or on the swept side,
// and the side normal points away from the box the shape is the sweep of (that
// covers the flat side faces too, where the offset points straight out of a
// face). Both candidates are measured relative to their own extent so that the
// choice does not depend on the scale of the shape.
var normalForExtrudedRectangleSource =
' vec3 normalForExtrudedRectangle(vec3 hit, vec3 boxMin, vec3 boxMax, float radius, vec3 axis) {' +
'   vec3 center = (boxMin + boxMax) * 0.5;' +
'   vec3 halfSize = max((boxMax - boxMin) * 0.5, vec3(' + epsilon + '));' +
'   vec3 u = axis.zxy;' +
'   vec3 v = axis.yzx;' +
'   vec3 toHit = hit - center;' +

'   vec3 inner = max(halfSize - radius * (u + v), vec3(0.0));' +
'   vec3 offset = toHit - clamp(toHit, -inner, inner);' +
'   float offsetLength = length(offset);' +
    // a radius of zero leaves the sides sharp, and there is no offset to take a
    // direction from, so the shape is just a box
'   if(offsetLength <= ' + epsilon + ') return normalForCube(hit, boxMin, boxMax);' +

'   float endRelative = abs(dot(toHit, axis)) / dot(halfSize, axis);' +
'   float sideRelative = offsetLength / max(radius, ' + epsilon + ');' +
'   if(endRelative > sideRelative) return axis * sign(dot(toHit, axis));' +
'   return offset / offsetLength;' +
' }';

// compute the near intersection of a sphere
// no intersection returns a value of +infinity
var intersectSphereSource =
' float intersectSphere(vec3 origin, vec3 ray, vec3 sphereCenter, float sphereRadius) {' +
'   vec3 toSphere = origin - sphereCenter;' +
'   float a = dot(ray, ray);' +
'   float b = 2.0 * dot(toSphere, ray);' +
'   float c = dot(toSphere, toSphere) - sphereRadius*sphereRadius;' +
'   float discriminant = b*b - 4.0*a*c;' +
'   if(discriminant > 0.0) {' +
'     float t = (-b - sqrt(discriminant)) / (2.0 * a);' +
'     if(t > 0.0) return t;' +
'   }' +
'   return ' + infinity + ';' +
' }';

// given that hit is a point on the sphere, what is the surface normal?
var normalForSphereSource =
' vec3 normalForSphere(vec3 hit, vec3 sphereCenter, float sphereRadius) {' +
'   return (hit - sphereCenter) / sphereRadius;' +
' }';

// use the fragment position for randomness
var randomSource =
' float random(vec3 scale, float seed) {' +
'   return fract(sin(dot(gl_FragCoord.xyz + seed, scale)) * 43758.5453 + seed);' +
' }';

// random cosine-weighted distributed vector
// from http://www.rorydriscoll.com/2009/01/07/better-sampling/
var cosineWeightedDirectionSource =
' vec3 cosineWeightedDirection(float seed, vec3 normal) {' +
'   float u = random(vec3(12.9898, 78.233, 151.7182), seed);' +
'   float v = random(vec3(63.7264, 10.873, 623.6736), seed);' +
'   float r = sqrt(u);' +
'   float angle = 6.283185307179586 * v;' +
    // compute an orthonormal basis from the normal. sdir has to be normalized:
    // cross(normal, axis) is only unit length when the two are perpendicular,
    // so skipping this skews the distribution on any tilted surface.
'   vec3 sdir, tdir;' +
'   if (abs(normal.x)<.5) {' +
'     sdir = normalize(cross(normal, vec3(1,0,0)));' +
'   } else {' +
'     sdir = normalize(cross(normal, vec3(0,1,0)));' +
'   }' +
'   tdir = cross(normal, sdir);' +
'   return r*cos(angle)*sdir + r*sin(angle)*tdir + sqrt(1.-u)*normal;' +
' }';

// random normalized vector
var uniformlyRandomDirectionSource =
' vec3 uniformlyRandomDirection(float seed) {' +
'   float u = random(vec3(12.9898, 78.233, 151.7182), seed);' +
'   float v = random(vec3(63.7264, 10.873, 623.6736), seed);' +
'   float z = 1.0 - 2.0 * u;' +
'   float r = sqrt(1.0 - z * z);' +
'   float angle = 6.283185307179586 * v;' +
'   return vec3(r * cos(angle), r * sin(angle), z);' +
' }';

// random vector in the unit sphere
// note: this is probably not statistically uniform, saw raising to 1/3 power somewhere but that looks wrong?
var uniformlyRandomVectorSource =
' vec3 uniformlyRandomVector(float seed) {' +
'   return uniformlyRandomDirection(seed) * sqrt(random(vec3(36.7539, 50.3658, 306.2759), seed));' +
' }';

// compute specular lighting contribution
var specularReflection =
' vec3 reflectedLight = normalize(reflect(light - hit, normal));' +
' specularHighlight = max(0.0, dot(reflectedLight, normalize(hit - origin)));';

// update ray using normal and bounce according to a diffuse reflection
var newDiffuseRay =
' ray = cosineWeightedDirection(timeSinceStart + float(bounce), normal);';

// update ray using normal according to a specular reflection
var newReflectiveRay =
' ray = reflect(ray, normal);' +
  specularReflection +
' specularHighlight = 2.0 * pow(specularHighlight, 20.0);';

// update ray using normal and bounce according to a glossy reflection
var newGlossyRay =
' ray = normalize(reflect(ray, normal)) + uniformlyRandomVector(timeSinceStart + float(bounce)) * glossiness;' +
  specularReflection +
' specularHighlight = pow(specularHighlight, 3.0);';

var yellowBlueCornellBox =
' if(hit.x < -0.9999) surfaceColor = vec3(0.1, 0.5, 1.0);' + // blue
' else if(hit.x > 0.9999) surfaceColor = vec3(1.0, 0.9, 0.1);'; // yellow

var redGreenCornellBox =
' if(hit.x < -0.9999) surfaceColor = vec3(1.0, 0.3, 0.1);' + // red
' else if(hit.x > 0.9999) surfaceColor = vec3(0.3, 1.0, 0.1);'; // green

function makeShadow(objects) {
  return '' +
' float shadow(vec3 origin, vec3 ray) {' +
    concat(objects, function(o){ return o.getShadowTestCode(); }) +
'   return 1.0;' +
' }';
}

function makeEnvironment() {
  if(environment == YELLOW_BLUE_CORNELL_BOX) {
    return yellowBlueCornellBox;
  } else if(environment == RED_GREEN_CORNELL_BOX) {
    return redGreenCornellBox;
  } else {
    return '';
  }
}

function makeCalculateColor(objects) {
  return '' +
' vec3 calculateColor(vec3 origin, vec3 ray, vec3 light) {' +
'   vec3 colorMask = vec3(1.0);' +
'   vec3 accumulatedColor = vec3(0.0);' +
  
    // main raytracing loop
'   for(int bounce = 0; bounce < ' + bounces.toFixed(0) + '; bounce++) {' +
      // compute the intersection with everything
'     vec2 tRoom = intersectCube(origin, ray, roomCubeMin, roomCubeMax);' +
      concat(objects, function(o){ return o.getIntersectCode(); }) +

      // find the closest intersection
'     float t = ' + infinity + ';' +
'     if(tRoom.x < tRoom.y) t = tRoom.y;' +
      concat(objects, function(o){ return o.getMinimumIntersectCode(); }) +

      // info about hit
'     vec3 hit = origin + ray * t;' +
'     vec3 surfaceColor = vec3(' + defaultSurfaceColorStr + ');' +
'     float specularHighlight = 0.0;' +
'     vec3 normal;' +

      // calculate the normal (and change wall color)
'     if(t == tRoom.y) {' + // Room walls
'       normal = -normalForCube(hit, roomCubeMin, roomCubeMax);' +
        makeEnvironment() +
        newDiffuseRay +
'     } else if(t == ' + infinity + ') {' +
'       break;' +
'     } else {' + // Object surfaces
'       if(false) ;' + // hack to discard the first 'else' in 'else if'
        concat(objects, function(o){ return o.getNormalCalculationCode(); }) +
        [newDiffuseRay, newReflectiveRay, newGlossyRay][material] +
'     }' +

      // compute diffuse lighting contribution
'     vec3 toLight = light - hit;' +
'     float diffuse = max(0.0, dot(normalize(toLight), normal));' +

      // trace a shadow ray to the light
'     float shadowIntensity = shadow(hit + normal * ' + epsilon + ', toLight);' +

      // do light bounce
'     colorMask *= surfaceColor;' +
'     accumulatedColor += colorMask * (' + glFloat(lightVal) + ' * diffuse * shadowIntensity);' +
'     accumulatedColor += colorMask * specularHighlight * shadowIntensity;' +

      // calculate next origin
'     origin = hit;' +
'   }' +

'   return accumulatedColor;' +
' }';
}

function makeMain() {
  return `
 void main() {
   vec3 newLight = light + uniformlyRandomVector(timeSinceStart - 53.0) * ${glFloat(lightSize)};
   vec3 texture = texture2D(texture, gl_FragCoord.xy / vec2(${glFloat(renderWidth)}, ${glFloat(renderHeight)})).rgb;
   gl_FragColor = vec4(mix(calculateColor(eye, initialRay, newLight), texture, textureWeight), 1.0);
 }`;
}

function makeTracerFragmentSource(objects) {
  return tracerFragmentSourceHeader +
  concat(objects, function(o){ return o.getGlobalCode(); }) +
  intersectCubeSource +
  normalForCubeSource +
  unionIntervalSource +
  intersectAxisCylinderSource +
  intersectExtrudedRectangleSource +
  normalForExtrudedRectangleSource +
  intersectSphereSource +
  normalForSphereSource +
  randomSource +
  cosineWeightedDirectionSource +
  uniformlyRandomDirectionSource +
  uniformlyRandomVectorSource +
  makeShadow(objects) +
  makeCalculateColor(objects) +
  makeMain();
}

////////////////////////////////////////////////////////////////////////////////
// utility functions
////////////////////////////////////////////////////////////////////////////////

function getEyeRay(matrix, x, y) {
  return matrix.multiply(Vector.create([x, y, 0, 1])).divideByW().ensure3().subtract(eye);
}

// scratch buffer reused for every matrix upload so that the render loop does
// not allocate a new typed array on every frame
var matrixBuffer = new Float32Array(16);

// gl.getUniformLocation() is a synchronous call into the driver, and this runs
// for every uniform of every program on every frame. Locations are stable for
// the lifetime of a program, so look them up once and keep them on the program.
function setUniforms(program, uniforms) {
  var locations = program.uniformLocations;
  if(locations === undefined) {
    locations = program.uniformLocations = {};
  }
  for(var name in uniforms) {
    var location = (name in locations) ? locations[name] : (locations[name] = gl.getUniformLocation(program, name));
    if(location == null) continue;
    var value = uniforms[name];
    if(value instanceof Vector) {
      var elements = value.elements;
      gl.uniform3f(location, elements[0], elements[1], elements[2]);
    } else if(value instanceof Matrix) {
      var flattened = value.flatten();
      for(var i = 0; i < 16; i++) {
        matrixBuffer[i] = flattened[i];
      }
      gl.uniformMatrix4fv(location, false, matrixBuffer);
    } else {
      gl.uniform1f(location, value);
    }
  }
}

function concat(objects, func) {
  var text = '';
  for(var i = 0; i < objects.length; i++) {
    text += func(objects[i]);
  }
  return text;
}

Vector.prototype.ensure3 = function() {
  return Vector.create([this.elements[0], this.elements[1], this.elements[2]]);
};

Vector.prototype.ensure4 = function(w) {
  return Vector.create([this.elements[0], this.elements[1], this.elements[2], w]);
};

Vector.prototype.divideByW = function() {
  var w = this.elements[this.elements.length - 1];
  var newElements = [];
  for(var i = 0; i < this.elements.length; i++) {
    newElements.push(this.elements[i] / w);
  }
  return Vector.create(newElements);
};

Vector.prototype.componentDivide = function(vector) {
  if(this.elements.length != vector.elements.length) {
    return null;
  }
  var newElements = [];
  for(var i = 0; i < this.elements.length; i++) {
    newElements.push(this.elements[i] / vector.elements[i]);
  }
  return Vector.create(newElements);
};

Vector.min = function(a, b) {
  if(a.elements.length != b.elements.length) {
    return null;
  }
  var newElements = [];
  for(var i = 0; i < a.elements.length; i++) {
    newElements.push(Math.min(a.elements[i], b.elements[i]));
  }
  return Vector.create(newElements);
};

Vector.max = function(a, b) {
  if(a.elements.length != b.elements.length) {
    return null;
  }
  var newElements = [];
  for(var i = 0; i < a.elements.length; i++) {
    newElements.push(Math.max(a.elements[i], b.elements[i]));
  }
  return Vector.create(newElements);
};

Vector.prototype.minComponent = function() {
  var value = Number.MAX_VALUE;
  for(var i = 0; i < this.elements.length; i++) {
    value = Math.min(value, this.elements[i]);
  }
  return value;
};

Vector.prototype.maxComponent = function() {
  var value = -Number.MAX_VALUE;
  for(var i = 0; i < this.elements.length; i++) {
    value = Math.max(value, this.elements[i]);
  }
  return value;
};

function compileSource(source, type) {
  var shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if(!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    var error = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw 'compile error: ' + error;
  }
  return shader;
}

function compileShader(vertexSource, fragmentSource) {
  var shaderProgram = gl.createProgram();
  var vertexShader = compileSource(vertexSource, gl.VERTEX_SHADER);
  var fragmentShader = compileSource(fragmentSource, gl.FRAGMENT_SHADER);
  gl.attachShader(shaderProgram, vertexShader);
  gl.attachShader(shaderProgram, fragmentShader);
  gl.linkProgram(shaderProgram);
  // the program keeps its own reference until it is deleted, so the shaders can
  // be released now instead of leaking one pair per scene recompilation
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if(!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
    var linkError = gl.getProgramInfoLog(shaderProgram);
    gl.deleteProgram(shaderProgram);
    throw 'link error: ' + linkError;
  }
  return shaderProgram;
}

////////////////////////////////////////////////////////////////////////////////
// class Sphere
////////////////////////////////////////////////////////////////////////////////

function Sphere(center, radius, id, color) {
  this.center = center;
  this.radius = radius;
  this.id = id;
  this.color = color || Vector.create([defaultSurfaceColor, defaultSurfaceColor, defaultSurfaceColor]);
  this.centerStr = 'sphereCenter' + id;
  this.radiusStr = 'sphereRadius' + id;
  this.colorStr = 'color' + id;
  this.intersectStr = 'tSphere' + id;
  this.temporaryTranslation = Vector.create([0, 0, 0]);
}

Sphere.prototype.getGlobalCode = function() {
  return '' +
' uniform vec3 ' + this.centerStr + ';' +
' uniform float ' + this.radiusStr + ';' +
' uniform vec3 ' + this.colorStr + ';';
};

Sphere.prototype.getIntersectCode = function() {
  return '' +
' float ' + this.intersectStr + ' = intersectSphere(origin, ray, ' + this.centerStr + ', ' + this.radiusStr + ');';
};

Sphere.prototype.getShadowTestCode = function() {
  // ignore hits right at the ray origin, otherwise a surface shadows itself
  // and speckles the lit side of the sphere ("shadow acne")
  return '' +
  this.getIntersectCode() +
' if(' + this.intersectStr + ' > ' + epsilon + ' && ' + this.intersectStr + ' < 1.0) return 0.0;';
};

Sphere.prototype.getMinimumIntersectCode = function() {
  return '' +
' if(' + this.intersectStr + ' < t) t = ' + this.intersectStr + ';';
};

Sphere.prototype.getNormalCalculationCode = function() {
  return `
  else if(t == ${this.intersectStr}) { 
    normal = normalForSphere(hit, ${this.centerStr}, ${this.radiusStr});
    surfaceColor = ${this.colorStr}; 
  }`;
};

Sphere.prototype.setUniforms = function(renderer) {
  renderer.uniforms[this.centerStr] = this.center.add(this.temporaryTranslation);
  renderer.uniforms[this.radiusStr] = this.radius;
  renderer.uniforms[this.colorStr] = this.color;
};

Sphere.prototype.temporaryTranslate = function(translation) {
  this.temporaryTranslation = translation;
};

Sphere.prototype.translate = function(translation) {
  this.center = this.center.add(translation);
};

Sphere.prototype.getMinCorner = function() {
  return this.center.add(this.temporaryTranslation).subtract(Vector.create([this.radius, this.radius, this.radius]));
};

Sphere.prototype.getMaxCorner = function() {
  return this.center.add(this.temporaryTranslation).add(Vector.create([this.radius, this.radius, this.radius]));
};

Sphere.prototype.intersect = function(origin, ray) {
  return Sphere.intersect(origin, ray, this.center.add(this.temporaryTranslation), this.radius);
};

Sphere.intersect = function(origin, ray, center, radius) {
  var toSphere = origin.subtract(center);
  var a = ray.dot(ray);
  var b = 2*toSphere.dot(ray);
  var c = toSphere.dot(toSphere) - radius*radius;
  var discriminant = b*b - 4*a*c;
  if(discriminant > 0) {
    var t = (-b - Math.sqrt(discriminant)) / (2*a);
    if(t > 0) {
      return t;
    }
  }
  return Number.MAX_VALUE;
};

////////////////////////////////////////////////////////////////////////////////
// class Cube
////////////////////////////////////////////////////////////////////////////////

function Cube(minCorner, maxCorner, id, color) {
  this.minCorner = minCorner;
  this.maxCorner = maxCorner;
  this.id = id;
  this.color = color || Vector.create([defaultSurfaceColor, defaultSurfaceColor, defaultSurfaceColor]);
  this.minStr = 'cubeMin' + id;
  this.maxStr = 'cubeMax' + id;
  this.colorStr = 'color' + id;
  this.intersectStr = 'tCube' + id;
  this.temporaryTranslation = Vector.create([0, 0, 0]);
}

Cube.prototype.getGlobalCode = function() {
  return '' +
' uniform vec3 ' + this.minStr + ';' +
' uniform vec3 ' + this.maxStr + ';' +
' uniform vec3 ' + this.colorStr + ';';
};

Cube.prototype.getIntersectCode = function() {
  return '' +
' vec2 ' + this.intersectStr + ' = intersectCube(origin, ray, ' + this.minStr + ', ' + this.maxStr + ');';
};

Cube.prototype.getShadowTestCode = function() {
  return '' +
  this.getIntersectCode() +
' if(' + this.intersectStr + '.x > ' + epsilon + ' && ' + this.intersectStr + '.x < 1.0 && ' + this.intersectStr + '.x < ' + this.intersectStr + '.y) return 0.0;';
};

Cube.prototype.getMinimumIntersectCode = function() {
  return '' +
' if(' + this.intersectStr + '.x > 0.0 && ' + this.intersectStr + '.x < ' + this.intersectStr + '.y && ' + this.intersectStr + '.x < t) t = ' + this.intersectStr + '.x;';
};

Cube.prototype.getNormalCalculationCode = function() {
  // have to compare intersectStr.x < intersectStr.y otherwise two coplanar
  // cubes will look wrong (one cube will "steal" the hit from the other)
  return `
  else if(t == ${this.intersectStr}.x && ${this.intersectStr}.x < ${this.intersectStr}.y) { 
    normal = normalForCube(hit, ${this.minStr}, ${this.maxStr});
    surfaceColor = ${this.colorStr}; 
  }`;

};

Cube.prototype.setUniforms = function(renderer) {
  renderer.uniforms[this.minStr] = this.getMinCorner();
  renderer.uniforms[this.maxStr] = this.getMaxCorner();
  renderer.uniforms[this.colorStr] = this.color;
};

Cube.prototype.temporaryTranslate = function(translation) {
  this.temporaryTranslation = translation;
};

Cube.prototype.translate = function(translation) {
  this.minCorner = this.minCorner.add(translation);
  this.maxCorner = this.maxCorner.add(translation);
};

Cube.prototype.getMinCorner = function() {
  return this.minCorner.add(this.temporaryTranslation);
};

Cube.prototype.getMaxCorner = function() {
  return this.maxCorner.add(this.temporaryTranslation);
};

Cube.prototype.intersect = function(origin, ray) {
  return Cube.intersect(origin, ray, this.getMinCorner(), this.getMaxCorner());
};

Cube.intersect = function(origin, ray, cubeMin, cubeMax) {
  var tMin = cubeMin.subtract(origin).componentDivide(ray);
  var tMax = cubeMax.subtract(origin).componentDivide(ray);
  var t1 = Vector.min(tMin, tMax);
  var t2 = Vector.max(tMin, tMax);
  var tNear = t1.maxComponent();
  var tFar = t2.minComponent();
  if(tNear > 0 && tNear < tFar) {
    return tNear;
  }
  return Number.MAX_VALUE;
};

////////////////////////////////////////////////////////////////////////////////
// class ExtrudedRectangle
////////////////////////////////////////////////////////////////////////////////

// A box whose cross section perpendicular to `axis` is a rectangle with rounded
// corners, like a CSS border-radius extruded into a solid. The ends of the
// extrusion stay flat, so only the four edges running along the axis are
// rounded off.

var AXES = { x: 0, y: 1, z: 2 };

// which of x, y or z the rectangle is extruded along, as an index. Anything
// unrecognized extrudes along z, which is the axis facing the default camera.
function axisIndex(axis) {
  if(typeof axis === 'number') {
    return (axis === 0 || axis === 1 || axis === 2) ? axis : 2;
  }
  var index = AXES[String(axis).toLowerCase()];
  return index === undefined ? 2 : index;
}

/**
 * @param {Vector} minCorner - corner of the enclosing box
 * @param {Vector} maxCorner - opposite corner of the enclosing box
 * @param {number} borderRadius - how much the corners of the cross section are
 *     rounded, clamped to half of the smaller side. 0 gives a plain box.
 * @param {number} id
 * @param {Vector} [color]
 * @param {string|number} ['z'] axis - the axis to extrude along ('x', 'y' or 'z')
 */
function ExtrudedRectangle(minCorner, maxCorner, borderRadius, id, color, axis) {
  this.minCorner = minCorner;
  this.maxCorner = maxCorner;
  this.axis = axisIndex(axis);
  this.borderRadius = ExtrudedRectangle.clampRadius(borderRadius, minCorner, maxCorner, this.axis);
  this.id = id;
  this.color = color || Vector.create([defaultSurfaceColor, defaultSurfaceColor, defaultSurfaceColor]);
  this.minStr = 'extrudedRectangleMin' + id;
  this.maxStr = 'extrudedRectangleMax' + id;
  this.radiusStr = 'extrudedRectangleRadius' + id;
  this.colorStr = 'color' + id;
  this.intersectStr = 'tExtrudedRectangle' + id;
  // the axis never changes without a recompilation, so bake it into the shader
  this.axisStr = 'vec3(' +
      glFloat(this.axis == 0 ? 1 : 0) + ', ' +
      glFloat(this.axis == 1 ? 1 : 0) + ', ' +
      glFloat(this.axis == 2 ? 1 : 0) + ')';
  this.temporaryTranslation = Vector.create([0, 0, 0]);
}

// a radius larger than half of the smaller cross section side would make the
// rounded corners overlap and turn the shape inside out
ExtrudedRectangle.clampRadius = function(radius, minCorner, maxCorner, axis) {
  var size = maxCorner.subtract(minCorner).elements;
  var maxRadius = Math.min(size[(axis + 1) % 3], size[(axis + 2) % 3]) * 0.5;
  if(!(radius > 0)) return 0;
  return Math.min(radius, maxRadius);
};

ExtrudedRectangle.prototype.getGlobalCode = function() {
  return '' +
' uniform vec3 ' + this.minStr + ';' +
' uniform vec3 ' + this.maxStr + ';' +
' uniform float ' + this.radiusStr + ';' +
' uniform vec3 ' + this.colorStr + ';';
};

ExtrudedRectangle.prototype.getIntersectCode = function() {
  return '' +
' vec2 ' + this.intersectStr + ' = intersectExtrudedRectangle(origin, ray, ' + this.minStr + ', ' + this.maxStr + ', ' + this.radiusStr + ', ' + this.axisStr + ');';
};

ExtrudedRectangle.prototype.getShadowTestCode = function() {
  return '' +
  this.getIntersectCode() +
' if(' + this.intersectStr + '.x > ' + epsilon + ' && ' + this.intersectStr + '.x < 1.0 && ' + this.intersectStr + '.x < ' + this.intersectStr + '.y) return 0.0;';
};

ExtrudedRectangle.prototype.getMinimumIntersectCode = function() {
  return '' +
' if(' + this.intersectStr + '.x > 0.0 && ' + this.intersectStr + '.x < ' + this.intersectStr + '.y && ' + this.intersectStr + '.x < t) t = ' + this.intersectStr + '.x;';
};

ExtrudedRectangle.prototype.getNormalCalculationCode = function() {
  // as for the cube, the interval has to be non empty as well, otherwise two
  // coplanar objects would fight over the hit
  return `
  else if(t == ${this.intersectStr}.x && ${this.intersectStr}.x < ${this.intersectStr}.y) {
    normal = normalForExtrudedRectangle(hit, ${this.minStr}, ${this.maxStr}, ${this.radiusStr}, ${this.axisStr});
    surfaceColor = ${this.colorStr};
  }`;
};

ExtrudedRectangle.prototype.setUniforms = function(renderer) {
  renderer.uniforms[this.minStr] = this.getMinCorner();
  renderer.uniforms[this.maxStr] = this.getMaxCorner();
  renderer.uniforms[this.radiusStr] = this.borderRadius;
  renderer.uniforms[this.colorStr] = this.color;
};

ExtrudedRectangle.prototype.temporaryTranslate = function(translation) {
  this.temporaryTranslation = translation;
};

ExtrudedRectangle.prototype.translate = function(translation) {
  this.minCorner = this.minCorner.add(translation);
  this.maxCorner = this.maxCorner.add(translation);
};

ExtrudedRectangle.prototype.getMinCorner = function() {
  return this.minCorner.add(this.temporaryTranslation);
};

ExtrudedRectangle.prototype.getMaxCorner = function() {
  return this.maxCorner.add(this.temporaryTranslation);
};

ExtrudedRectangle.prototype.intersect = function(origin, ray) {
  return ExtrudedRectangle.intersect(origin, ray, this.getMinCorner(), this.getMaxCorner(), this.borderRadius, this.axis);
};

// the same union of convex pieces as the shader does, for picking with the
// mouse. Returns the near intersection, or Number.MAX_VALUE for a miss.
ExtrudedRectangle.intersect = function(origin, ray, boxMin, boxMax, radius, axis) {
  var o = origin.elements, d = ray.elements;
  var lo = boxMin.elements, hi = boxMax.elements;
  var u = (axis + 1) % 3, v = (axis + 2) % 3;

  var near = Number.MAX_VALUE, far = -Number.MAX_VALUE;
  function union(pieceNear, pieceFar) {
    if(pieceNear >= pieceFar) return;
    near = Math.min(near, pieceNear);
    far = Math.max(far, pieceFar);
  }

  // an axis aligned box, given as [min, max] along each of the three axes
  function unionBox(box) {
    var boxNear = -Number.MAX_VALUE, boxFar = Number.MAX_VALUE;
    for(var i = 0; i < 3; i++) {
      var slab = slabInterval(o[i], d[i], box[i][0], box[i][1]);
      if(slab === null) return;
      boxNear = Math.max(boxNear, slab[0]);
      boxFar = Math.min(boxFar, slab[1]);
    }
    union(boxNear, boxFar);
  }

  function slabInterval(originComponent, rayComponent, min, max) {
    if(Math.abs(rayComponent) < 1e-12) {
      return (originComponent >= min && originComponent <= max) ? [-Number.MAX_VALUE, Number.MAX_VALUE] : null;
    }
    var t1 = (min - originComponent) / rayComponent;
    var t2 = (max - originComponent) / rayComponent;
    return (t1 < t2) ? [t1, t2] : [t2, t1];
  }

  // the two boxes crossing each other in a plus shape
  var full = [[lo[0], hi[0]], [lo[1], hi[1]], [lo[2], hi[2]]];
  var alongU = [full[0].slice(), full[1].slice(), full[2].slice()];
  alongU[v] = [lo[v] + radius, hi[v] - radius];
  var alongV = [full[0].slice(), full[1].slice(), full[2].slice()];
  alongV[u] = [lo[u] + radius, hi[u] - radius];
  unionBox(alongU);
  unionBox(alongV);

  // the four corner cylinders, clipped to the extruded extent
  var ends = slabInterval(o[axis], d[axis], lo[axis], hi[axis]);
  if(ends !== null) {
    var a = d[u] * d[u] + d[v] * d[v];
    for(var corner = 0; corner < 4; corner++) {
      var centerU = (corner < 2 ? hi[u] - radius : lo[u] + radius);
      var centerV = (corner % 2 === 0 ? hi[v] - radius : lo[v] + radius);
      var toU = o[u] - centerU, toV = o[v] - centerV;
      var c = toU * toU + toV * toV - radius * radius;
      if(a < 1e-24) {
        if(c < 0) union(ends[0], ends[1]);
        continue;
      }
      var b = 2 * (toU * d[u] + toV * d[v]);
      var discriminant = b * b - 4 * a * c;
      if(discriminant < 0) continue;
      var root = Math.sqrt(discriminant);
      union(Math.max((-b - root) / (2 * a), ends[0]), Math.min((-b + root) / (2 * a), ends[1]));
    }
  }

  return (near > 0 && near < far) ? near : Number.MAX_VALUE;
};

////////////////////////////////////////////////////////////////////////////////
// class Light
////////////////////////////////////////////////////////////////////////////////

function Light() {
  this.temporaryTranslation = Vector.create([0, 0, 0]);
}

Light.prototype.getGlobalCode = function() {
  return 'uniform vec3 light;';
};

Light.prototype.getIntersectCode = function() {
  return '';
};

Light.prototype.getShadowTestCode = function() {
  return '';
};

Light.prototype.getMinimumIntersectCode = function() {
  return '';
};

Light.prototype.getNormalCalculationCode = function() {
  return '';
};

Light.prototype.setUniforms = function(renderer) {
  renderer.uniforms.light = light.add(this.temporaryTranslation);
};

Light.clampPosition = function(position) {
  for(var i = 0; i < position.elements.length; i++) {
    position.elements[i] = Math.max(lightSize - 1, Math.min(1 - lightSize, position.elements[i]));
  }
};

Light.prototype.temporaryTranslate = function(translation) {
  var tempLight = light.add(translation);
  Light.clampPosition(tempLight);
  this.temporaryTranslation = tempLight.subtract(light);
};

Light.prototype.translate = function(translation) {
  light = light.add(translation);
  Light.clampPosition(light);
};

Light.prototype.getMinCorner = function() {
  return light.add(this.temporaryTranslation).subtract(Vector.create([lightSize, lightSize, lightSize]));
};

Light.prototype.getMaxCorner = function() {
  return light.add(this.temporaryTranslation).add(Vector.create([lightSize, lightSize, lightSize]));
};

Light.prototype.intersect = function(origin, ray) {
  return Number.MAX_VALUE;
};

////////////////////////////////////////////////////////////////////////////////
// class PathTracer
////////////////////////////////////////////////////////////////////////////////

// Fixed point fallback. Accumulating thousands of samples into 8 bits per
// channel quantises the running average, so the image stops converging and
// keeps a permanent grain; it is only used when nothing better is renderable.
function byteTextureFormat() {
  return { internalFormat: gl.RGBA, format: gl.RGBA, type: gl.UNSIGNED_BYTE, float: false };
}

// Can this texture format actually be attached to a framebuffer and drawn to?
// Support for sampling a format does not imply support for rendering to it.
function isRenderableFormat(framebuffer, candidate) {
  var texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  // drain errors left over by earlier calls, bounded so that a lost context
  // (which keeps reporting CONTEXT_LOST_WEBGL) cannot spin here forever
  for(var drain = 0; drain < 16 && gl.getError() != gl.NO_ERROR; drain++) {}
  gl.texImage2D(gl.TEXTURE_2D, 0, candidate.internalFormat, 4, 4, 0, candidate.format, candidate.type, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  var supported = gl.getError() == gl.NO_ERROR &&
      gl.checkFramebufferStatus(gl.FRAMEBUFFER) == gl.FRAMEBUFFER_COMPLETE;

  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.deleteTexture(texture);
  return supported;
}

// Pick the highest precision accumulation buffer this context can render to.
function chooseTextureFormat(framebuffer) {
  var candidates = [];

  if(isWebGL2) {
    // half float is listed too: some mobile GPUs render to RGBA16F but not RGBA32F
    if(gl.getExtension('EXT_color_buffer_float')) {
      candidates.push({ internalFormat: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, float: true });
      candidates.push({ internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, float: true });
    }
    if(gl.getExtension('EXT_color_buffer_half_float')) {
      candidates.push({ internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, float: true });
    }
  } else if(gl.getExtension('OES_texture_float')) {
    // enabling this is what makes float textures renderable on some drivers
    gl.getExtension('WEBGL_color_buffer_float');
    candidates.push({ internalFormat: gl.RGBA, format: gl.RGBA, type: gl.FLOAT, float: true });
    candidates.push({ internalFormat: gl.RGB, format: gl.RGB, type: gl.FLOAT, float: true });
  }

  for(var i = 0; i < candidates.length; i++) {
    if(isRenderableFormat(framebuffer, candidates[i])) {
      return candidates[i];
    }
  }
  return byteTextureFormat();
}

function PathTracer() {
  var vertices = [
    -1, -1,
    -1, +1,
    +1, -1,
    +1, +1
  ];

  // create vertex buffer
  this.vertexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);

  // create framebuffer
  this.framebuffer = gl.createFramebuffer();

  this.textureFormat = chooseTextureFormat(this.framebuffer);

  this.textures = [gl.createTexture(), gl.createTexture()];
  this.allocateTextures();

  // create render shader
  this.renderProgram = compileShader(renderVertexSource, renderFragmentSource);
  this.renderVertexAttribute = gl.getAttribLocation(this.renderProgram, 'vertex');
  gl.enableVertexAttribArray(this.renderVertexAttribute);

  // objects and shader will be filled in when setObjects() is called
  this.objects = [];
  this.sampleCount = 0;
  this.tracerProgram = null;
}

PathTracer.prototype.allocateTextures = function() {
  var textureFormat = this.textureFormat;
  for(var i = 0; i < this.textures.length; i++) {
    gl.bindTexture(gl.TEXTURE_2D, this.textures[i]);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    // NEAREST filtering plus CLAMP_TO_EDGE is what makes non power of two
    // render targets legal in WebGL 1, so the canvas size is unconstrained
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, textureFormat.internalFormat, renderWidth, renderHeight, 0,
        textureFormat.format, textureFormat.type, null);
  }
  gl.bindTexture(gl.TEXTURE_2D, null);
};

PathTracer.prototype.setObjects = function(objects) {
  // build the new shader before touching any state, so that a scene which
  // fails to compile leaves the working one running instead of half applied
  var program = compileShader(tracerVertexSource, makeTracerFragmentSource(objects));

  if(this.tracerProgram != null) {
    // this used to delete `this.shaderProgram`, which does not exist, so every
    // material, environment or geometry change leaked a compiled program
    gl.deleteProgram(this.tracerProgram);
  }
  this.tracerProgram = program;
  this.tracerVertexAttribute = gl.getAttribLocation(this.tracerProgram, 'vertex');
  gl.enableVertexAttribArray(this.tracerVertexAttribute);

  this.uniforms = {};
  this.sampleCount = 0;
  this.objects = objects;
};

PathTracer.prototype.update = function(matrix, timeSinceStart) {
  // calculate uniforms
  for(var i = 0; i < this.objects.length; i++) {
    this.objects[i].setUniforms(this);
  }
  this.uniforms.eye = eye;
  this.uniforms.glossiness = glossiness;
  this.uniforms.ray00 = getEyeRay(matrix, -1, -1);
  this.uniforms.ray01 = getEyeRay(matrix, -1, +1);
  this.uniforms.ray10 = getEyeRay(matrix, +1, -1);
  this.uniforms.ray11 = getEyeRay(matrix, +1, +1);
  // the seed only has to be different every frame, not monotonic. Letting it
  // grow without bound eventually starves sin() of precision and the noise
  // pattern freezes into visible banding during a long render.
  this.uniforms.timeSinceStart = timeSinceStart % 1024;
  this.uniforms.textureWeight = this.sampleCount / (this.sampleCount + 1);

  // set uniforms
  gl.useProgram(this.tracerProgram);
  setUniforms(this.tracerProgram, this.uniforms);

  // render to texture
  gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
  gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.textures[1], 0);
  if (this.textureFormat.float && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    // Some drivers advertise float textures and report them as renderable, but
    // fail once a real sized attachment is used. Fall back to fixed point.
    this.textureFormat = byteTextureFormat();
    this.allocateTextures();
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.textures[1], 0);
  }
  gl.bindTexture(gl.TEXTURE_2D, this.textures[0]);
  gl.vertexAttribPointer(this.tracerVertexAttribute, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  // ping pong textures
  this.textures.reverse();
  this.sampleCount++;
};

PathTracer.prototype.render = function() {
  gl.useProgram(this.renderProgram);
  gl.bindTexture(gl.TEXTURE_2D, this.textures[0]);
  gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
  gl.vertexAttribPointer(this.renderVertexAttribute, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
};

////////////////////////////////////////////////////////////////////////////////
// class Renderer
////////////////////////////////////////////////////////////////////////////////

function Renderer() {
  var vertices = [
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
    1, 1, 0,
    0, 0, 1,
    1, 0, 1,
    0, 1, 1,
    1, 1, 1
  ];
  var indices = [
    0, 1, 1, 3, 3, 2, 2, 0,
    4, 5, 5, 7, 7, 6, 6, 4,
    0, 4, 1, 5, 2, 6, 3, 7
  ];

  // create vertex buffer
  this.vertexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);

  // create index buffer
  this.indexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);

  // create line shader
  this.lineProgram = compileShader(lineVertexSource, lineFragmentSource);
  this.vertexAttribute = gl.getAttribLocation(this.lineProgram, 'vertex');
  gl.enableVertexAttribArray(this.vertexAttribute);

  this.objects = [];
  this.selectedObject = null;
  this.pathTracer = new PathTracer();
  this.paused = false;
}


Renderer.prototype.pause = function() {
  this.paused = true;
}

Renderer.prototype.resume = function() {
  this.paused = false;
}


Renderer.prototype.setObjects = function(objects) {
  this.objects = objects;
  this.selectedObject = null;
  this.pathTracer.setObjects(objects);
};

Renderer.prototype.update = function(modelviewProjection, timeSinceStart) {
  if(!this.paused) {
    // sub pixel jitter for antialiasing, one pixel wide on each axis so that
    // non square canvases are not stretched
    var jitter = Matrix.Translation(Vector.create([
      (Math.random() * 2 - 1) / renderWidth,
      (Math.random() * 2 - 1) / renderHeight,
      0
    ]));
    var inverse = jitter.multiply(modelviewProjection).inverse();
    this.modelviewProjection = modelviewProjection;
    this.pathTracer.update(inverse, timeSinceStart);
  }
};

Renderer.prototype.render = function() {
  if(!this.paused) {
    this.pathTracer.render();
    // Render Ui overlay for selected object.
    if(this.selectedObject != null) {
      gl.useProgram(this.lineProgram);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
      gl.vertexAttribPointer(this.vertexAttribute, 3, gl.FLOAT, false, 0, 0);
      setUniforms(this.lineProgram, {
        cubeMin: this.selectedObject.getMinCorner(),
        cubeMax: this.selectedObject.getMaxCorner(),
        modelviewProjection: this.modelviewProjection
      });
      gl.drawElements(gl.LINES, 24, gl.UNSIGNED_SHORT, 0);
    }
  }
};

////////////////////////////////////////////////////////////////////////////////
// class UI
////////////////////////////////////////////////////////////////////////////////

function UI() {
  this.renderer = new Renderer();
  this.moving = false;
}

UI.prototype.setObjects = function(objects) {
  this.objects = objects;
  this.objects.splice(0, 0, new Light());

  // Object ids become GLSL identifiers, so they have to stay unique for the
  // lifetime of the shader. Each scene numbers its objects from zero, so
  // resync the counter here: otherwise loading a large scene over a small one
  // and then adding an object redeclares a uniform and the shader fails to
  // compile.
  for(var i = 0; i < this.objects.length; i++) {
    var id = this.objects[i].id;
    if(id !== undefined && id >= nextObjectId) {
      nextObjectId = id + 1;
    }
  }

  this.renderer.setObjects(this.objects);
};

UI.prototype.update = function(timeSinceStart) {
  this.modelview = makeLookAt(eye.elements[0], eye.elements[1], eye.elements[2], 0, 0, 0, 0, 1, 0);
  this.projection = makePerspective(fov, canvasWidth/canvasHeight, 0.1, 100);
  this.modelviewProjection = this.projection.multiply(this.modelview);
  // cached so that picking and dragging do not invert a 4x4 matrix per event
  this.modelviewProjectionInverse = this.modelviewProjection.inverse();
  this.renderer.update(this.modelviewProjection, timeSinceStart);
};

// convert a position in canvas pixels into a ray leaving the eye. Returns null
// until the first frame has run and the camera matrices exist.
UI.prototype.getRayForPixel = function(x, y) {
  if(!this.modelviewProjectionInverse) return null;
  return getEyeRay(this.modelviewProjectionInverse, (x / canvasWidth) * 2 - 1, 1 - (y / canvasHeight) * 2);
};

UI.prototype.mouseDown = function(x, y) {
  var t;
  var origin = eye;
  var ray = this.getRayForPixel(x, y);
  if(ray === null) return false;

  // test the selection box first
  if(this.renderer.selectedObject != null) {
    var minBounds = this.renderer.selectedObject.getMinCorner();
    var maxBounds = this.renderer.selectedObject.getMaxCorner();
    t = Cube.intersect(origin, ray, minBounds, maxBounds);

    if(t < Number.MAX_VALUE) {
      var hit = origin.add(ray.multiply(t));

      if(Math.abs(hit.elements[0] - minBounds.elements[0]) < 0.001) this.movementNormal = Vector.create([-1, 0, 0]);
      else if(Math.abs(hit.elements[0] - maxBounds.elements[0]) < 0.001) this.movementNormal = Vector.create([+1, 0, 0]);
      else if(Math.abs(hit.elements[1] - minBounds.elements[1]) < 0.001) this.movementNormal = Vector.create([0, -1, 0]);
      else if(Math.abs(hit.elements[1] - maxBounds.elements[1]) < 0.001) this.movementNormal = Vector.create([0, +1, 0]);
      else if(Math.abs(hit.elements[2] - minBounds.elements[2]) < 0.001) this.movementNormal = Vector.create([0, 0, -1]);
      else this.movementNormal = Vector.create([0, 0, +1]);

      this.movementDistance = this.movementNormal.dot(hit);
      this.originalHit = hit;
      this.moving = true;

      return true;
    }
  }

  t = Number.MAX_VALUE;
  this.renderer.selectedObject = null;

  for(var i = 0; i < this.objects.length; i++) {
    var objectT = this.objects[i].intersect(origin, ray);
    if(objectT < t) {
      t = objectT;
      this.renderer.selectedObject = this.objects[i];
    }
  }

  return (t < Number.MAX_VALUE);
};

UI.prototype.mouseMove = function(x, y) {
  if(this.moving) {
    var origin = eye;
    var ray = this.getRayForPixel(x, y);
    if(ray === null) return;

    var t = (this.movementDistance - this.movementNormal.dot(origin)) / this.movementNormal.dot(ray);
    var hit = origin.add(ray.multiply(t));
    this.renderer.selectedObject.temporaryTranslate(hit.subtract(this.originalHit));

    // clear the sample buffer
    this.renderer.pathTracer.sampleCount = 0;
  }
};

UI.prototype.mouseUp = function(x, y) {
  if(this.moving) {
    var origin = eye;
    var ray = this.getRayForPixel(x, y);
    if(ray === null) return;

    var t = (this.movementDistance - this.movementNormal.dot(origin)) / this.movementNormal.dot(ray);
    var hit = origin.add(ray.multiply(t));
    this.renderer.selectedObject.temporaryTranslate(Vector.create([0, 0, 0]));
    this.renderer.selectedObject.translate(hit.subtract(this.originalHit));
    this.moving = false;
  }
};

UI.prototype.render = function() {
  this.renderer.render();
};

UI.prototype.selectLight = function() {
  this.renderer.selectedObject = this.objects[0];
};

UI.prototype.addSphere = function() {
  this.objects.push(new Sphere(Vector.create([0, 0, 0]), 0.25, nextObjectId++));
  this.renderer.setObjects(this.objects);
};

UI.prototype.addCube = function() {
  this.objects.push(new Cube(Vector.create([-0.25, -0.25, -0.25]), Vector.create([0.25, 0.25, 0.25]), nextObjectId++));
  this.renderer.setObjects(this.objects);
};

UI.prototype.addExtrudedRectangle = function() {
  this.objects.push(new ExtrudedRectangle(Vector.create([-0.3, -0.3, -0.1]), Vector.create([0.3, 0.3, 0.1]), 0.1, nextObjectId++));
  this.renderer.setObjects(this.objects);
};

UI.prototype.deleteSelection = function() {
  for(var i = 0; i < this.objects.length; i++) {
    if(this.renderer.selectedObject == this.objects[i]) {
      this.objects.splice(i, 1);
      this.renderer.selectedObject = null;
      this.renderer.setObjects(this.objects);
      break;
    }
  }
};

UI.prototype.setLightPosition = function(position) {
  light = Vector.create(position);
};

UI.prototype.setLightVal = function(val) {
  lightVal = val;
};

UI.prototype.updateMaterial = function(newMaterial) {
  if(material != newMaterial) {
    material = newMaterial;
    this.renderer.setObjects(this.objects);
  }
};

UI.prototype.updateEnvironment = function(newEnvironment) {
  if(environment != newEnvironment) {
    environment = newEnvironment;
    this.renderer.setObjects(this.objects);
  }
};

UI.prototype.updateGlossiness = function(newGlossiness) {

  if(isNaN(newGlossiness)) newGlossiness = 0;
  newGlossiness = Math.max(0, Math.min(1, newGlossiness));
  if(material == MATERIAL_GLOSSY && glossiness != newGlossiness) {
    this.renderer.pathTracer.sampleCount = 0;
  }
  glossiness = newGlossiness;
};

////////////////////////////////////////////////////////////////////////////////
// main program
////////////////////////////////////////////////////////////////////////////////

var gl;
var ui;
var isWebGL2 = false;

let angleX = 0;
let angleY = 0;
let zoomZ = 2.5
let fov = 55
let eye = Vector.create([0, 0, 0]);
var light = Vector.create([0.4, 0.5, -0.6]);
let lightSize = 0.1;
let lightVal = 0.5;

let nextObjectId = 0;

const MATERIAL_DIFFUSE = 0;
const MATERIAL_MIRROR = 1;
const MATERIAL_GLOSSY = 2;
let material = MATERIAL_DIFFUSE;
let glossiness = 0.6;
let bounces = 5;

const YELLOW_BLUE_CORNELL_BOX = "cornell-yellow-blue";
const RED_GREEN_CORNELL_BOX = "cornell-red-green";
let environment; // default to no environment

/**
 * checks that the passed canvas has a usable drawing buffer
 */
function isValidCanvas(canvas) {
  return canvas.width > 0 && canvas.height > 0;
}

let canvasWidth;
let canvasHeight;
// size of the accumulation buffers, matches the canvas drawing buffer
let renderWidth;
let renderHeight;

let start;
let previousTimeStamp;
let animationFrame;

function tick(timeStamp) {
  // always queue the next frame first: bailing out early used to stop the
  // render loop for good instead of just skipping a frame
  animationFrame = window.requestAnimationFrame(tick);

  if (start === undefined) {
    start = timeStamp;
  }
  if (previousTimeStamp === timeStamp) {
    return;
  }
  previousTimeStamp = timeStamp;

  // nothing to accumulate or draw while paused, so skip the camera and matrix
  // work as well instead of doing it and throwing it away
  if (ui.renderer.paused) {
    return;
  }

  eye.elements[0] = zoomZ * Math.sin(angleY) * Math.cos(angleX);
  eye.elements[1] = zoomZ * Math.sin(angleX);
  eye.elements[2] = zoomZ * Math.cos(angleY) * Math.cos(angleX);

  ui.update((timeStamp - start) * 0.001);
  ui.render();
}

// none of these buffers are ever read back or blended with the page, and the
// tracer does its own antialiasing, so ask for the cheapest drawing buffer
const contextAttributes = {
  alpha: false,
  depth: false,
  stencil: false,
  antialias: false,
  preserveDrawingBuffer: false,
  powerPreference: 'high-performance'
};

function createContext(canvas) {
  isWebGL2 = false;
  // WebGL 2 gives renderable float textures on more browsers (notably Firefox)
  // and drops the power of two restrictions. The shaders are GLSL ES 1.00,
  // which a WebGL 2 context still accepts.
  var context = null;
  try { context = canvas.getContext('webgl2', contextAttributes); } catch(e) {}
  if(context) {
    isWebGL2 = true;
    return context;
  }
  try { context = canvas.getContext('webgl', contextAttributes); } catch(e) {}
  if(!context) {
    try { context = canvas.getContext('experimental-webgl', contextAttributes); } catch(e) {}
  }
  return context;
}

/**
 * Initialize the path tracer on the given canvas
 * @param {HTMLCanvasElement} canvas - Canvas to render to
 * @param {Object[]} objects - Array of Sphere, Cube and ExtrudedRectangle objects
 * @param {Object} [config] - Specify: material, glossiness (0-1), environment, bounces (light bounces per ray), zoom (in distance from center), fov (field of view, in degrees), lightPosition ([x,y,z]), lightSize, lightVal (0-1)
 * @param {bool} [interactive=true] - if the user should be able to interact with the scene
 * @param {function} [log] - a function to print log messages to, defaults to console.log
 * @returns {UI}
 */
function makePathTracer(canvas, objects, config = {}, interactive = true, log) {
  // `??` rather than `||` so that a deliberate 0 is not thrown away
  material = config.material ?? material;
  glossiness = config.glossiness ?? glossiness;
  bounces = config.bounces ?? bounces;
  environment = config.environment;
  nextObjectId = 0; // UI.setObjects() derives the real value from the scene

  if(config.zoom) {
    zoomZ = config.zoom;
  }
  if(config.fov) {
    fov = config.fov;
  }
  if(config.lightPosition) {
    light = Vector.create(config.lightPosition);
  }
  if(config.lightSize !== undefined) {
    lightSize = config.lightSize;
  }
  if(config.lightVal !== undefined) {
    lightVal = config.lightVal;
  }

  log = log || console.log;

  // starting over: stop any loop still running from a previous call before
  // dropping the instance it renders through
  if(animationFrame !== undefined) {
    window.cancelAnimationFrame(animationFrame);
    animationFrame = undefined;
  }
  ui = undefined;
  start = undefined;
  previousTimeStamp = undefined;

  gl = createContext(canvas);

  if(gl) {
    log('Loading...');

    if(isValidCanvas(canvas)) {
      canvasWidth = canvas.width;
      canvasHeight = canvas.height;
      renderWidth = canvas.width;
      renderHeight = canvas.height;

      ui = new UI();
      ui.setObjects(objects);
      animationFrame = window.requestAnimationFrame(tick);
    } else {
      log('canvas must have a non-zero width and height');
    }
  } else {
    log('Your browser does not support WebGL.<br>Please see <a href="http://www.khronos.org/webgl/wiki/Getting_a_WebGL_Implementation">Getting a WebGL Implementation</a>.');
  }

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

  var rotating = false, oldX, oldY;
  var listeners = [];

  function on(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    listeners.push({ target: target, type: type, handler: handler, options: options });
  }

  function onPointerDown(event) {
    var mouse = canvasPixelPos(event);
    oldX = mouse.x;
    oldY = mouse.y;

    if(mouse.x >= 0 && mouse.x < canvasWidth && mouse.y >= 0 && mouse.y < canvasHeight) {
      rotating = !ui.mouseDown(mouse.x, mouse.y);

      // dragging rotates the camera and moves objects, so suppress text selection
      event.preventDefault();
    }
  }

  function onPointerMove(event) {
    var mouse = canvasPixelPos(event);

    if(rotating) {
      // update the angles based on how far we moved since last time
      angleY -= (mouse.x - oldX) * 0.01;
      angleX += (mouse.y - oldY) * 0.01;

      // don't go upside down
      angleX = Math.max(angleX, -Math.PI / 2 + 0.01);
      angleX = Math.min(angleX, Math.PI / 2 - 0.01);

      // clear the sample buffer
      ui.renderer.pathTracer.sampleCount = 0;

      // remember this coordinate
      oldX = mouse.x;
      oldY = mouse.y;
    } else {
      ui.mouseMove(mouse.x, mouse.y);
    }
  }

  function onPointerUp(event) {
    rotating = false;

    var mouse = canvasPixelPos(event);
    ui.mouseUp(mouse.x, mouse.y);
  }

  function isTextEntry(element) {
    if(!element) return false;
    if(element.isContentEditable) return true;
    var tag = element.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  // if the context or the canvas was rejected there is nothing to drive
  if(!ui) {
    return ui;
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
        ui.deleteSelection();

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
        rotating = false;
      }
    }, { passive: false });

    on(window, 'touchmove', function(event) {
      if(event.touches.length === 1) {
        onPointerMove(event.touches[0]);
        if(rotating) event.preventDefault();
      }
    }, { passive: false });

    on(window, 'touchend', function(event) {
      if(event.changedTouches.length > 0) onPointerUp(event.changedTouches[0]);
      rotating = false;
    }, { passive: false });

    on(window, 'touchcancel', function() {
      rotating = false;
    }, { passive: false });
  }

  /** Stop rendering and detach every listener this instance installed. */
  ui.dispose = function() {
    if(animationFrame !== undefined) {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = undefined;
    }
    for(var i = 0; i < listeners.length; i++) {
      var listener = listeners[i];
      listener.target.removeEventListener(listener.type, listener.handler, listener.options);
    }
    listeners = [];
  };

  return ui;

};

export {makePathTracer, Sphere, Cube, ExtrudedRectangle}