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

import {Vector, Matrix, makeLookAt, makeOrtho, makePerspective} from './glUtils.js';

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

// vertex shader, interpolate the ray per-pixel. Both ends of the ray are
// interpolated across the image rather than just the direction: a perspective
// camera starts every ray at the eye and varies the direction, an orthographic
// camera keeps the direction fixed and varies the origin instead.
var tracerVertexSource =
' attribute vec3 vertex;' +
' uniform vec3 origin00, origin01, origin10, origin11;' +
' uniform vec3 ray00, ray01, ray10, ray11;' +
' varying vec3 initialOrigin;' +
' varying vec3 initialRay;' +
' void main() {' +
'   vec2 percent = vertex.xy * 0.5 + 0.5;' +
'   initialOrigin = mix(mix(origin00, origin01, percent.y), mix(origin10, origin11, percent.y), percent.x);' +
'   initialRay = mix(mix(ray00, ray01, percent.y), mix(ray10, ray11, percent.y), percent.x);' +
'   gl_Position = vec4(vertex, 1.0);' +
' }';

// start of fragment shader.
//
// lightSamples and bounceSamples hold this frame's point of the sample
// sequence: one point on the light and one outgoing direction per bounce, three
// dimensions each. See makeSampleSequence() for where the numbers come from.
function makeTracerFragmentSourceHeader() {
  return '' +
' precision highp float;' +
' varying vec3 initialOrigin;' +
' varying vec3 initialRay;' +
' uniform float textureWeight;' +
' uniform sampler2D texture;' +
' uniform float glossiness;' +
' uniform vec3 lightSamples[' + sampleArrayLength() + '];' +
' uniform vec3 bounceSamples[' + sampleArrayLength() + '];' +
' vec3 roomCubeMin = vec3(-1.0, -1.0, -1.0);' +
' vec3 roomCubeMax = vec3(1.0, 1.0, 1.0);';
}

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

// a hash of the fragment position, used to give every pixel its own offset into
// the sample sequence. The classic fract(sin(dot(...)) * 43758.5453) hash was
// visibly patterned here: sin() is only specified to a few digits of accuracy
// in GLSL ES, so different drivers streaked it differently and large seeds
// collapsed it into bands. This one (after Dave Hoskins) is plain multiply and
// fract arithmetic, which every driver agrees on.
var hashSource =
' vec3 hash33(vec3 p) {' +
'   p = fract(p * vec3(0.1031, 0.1030, 0.0973));' +
'   p += dot(p, p.yxz + 33.33);' +
'   return fract((p.xxy + p.yxx) * p.zyx);' +
' }';

// Take one point of the sample sequence and shift it by a constant offset
// belonging to this pixel, wrapping around the unit cube (a Cranley-Patterson
// rotation). Shifting an evenly spread set of points leaves it evenly spread,
// so each pixel still walks a well distributed sequence, but no two pixels walk
// the same one and the leftover noise looks random instead of streaked.
var sampleCubeSource =
' vec3 sampleCube(vec3 sequencePoint, float dimension) {' +
'   return fract(sequencePoint + hash33(vec3(gl_FragCoord.xy, dimension)));' +
' }';

// cosine-weighted distributed vector for the two given uniform numbers
// from http://www.rorydriscoll.com/2009/01/07/better-sampling/
var cosineWeightedDirectionSource =
' vec3 cosineWeightedDirection(vec2 uv, vec3 normal) {' +
'   float r = sqrt(uv.x);' +
'   float angle = 6.283185307179586 * uv.y;' +
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
'   return r*cos(angle)*sdir + r*sin(angle)*tdir + sqrt(1.-uv.x)*normal;' +
' }';

// normalized vector spread evenly over the sphere
var uniformlyRandomDirectionSource =
' vec3 uniformlyRandomDirection(vec2 uv) {' +
'   float z = 1.0 - 2.0 * uv.x;' +
'   float r = sqrt(1.0 - z * z);' +
'   float angle = 6.283185307179586 * uv.y;' +
'   return vec3(r * cos(angle), r * sin(angle), z);' +
' }';

// vector inside the unit sphere, from three uniform numbers
// note: this is probably not statistically uniform, saw raising to 1/3 power somewhere but that looks wrong?
var uniformlyRandomVectorSource =
' vec3 uniformlyRandomVector(vec3 uvw) {' +
'   return uniformlyRandomDirection(uvw.xy) * sqrt(uvw.z);' +
' }';

// compute specular lighting contribution. Independent of the outgoing ray, so
// it stays valid on the last bounce where no outgoing ray is generated.
var specularReflection =
' vec3 reflectedLight = normalize(reflect(lightPos - hit, normal));' +
' specularHighlight = max(0.0, dot(reflectedLight, normalize(hit - origin)));';

// the highlight a material adds at the hit point, and separately the outgoing
// ray it scatters into. They are kept apart so that the scattered ray can be
// skipped on the last bounce, where nothing would ever trace it.
var materialHighlight = [
  '',
  specularReflection + ' specularHighlight = 2.0 * pow(specularHighlight, 20.0);',
  specularReflection + ' specularHighlight = pow(specularHighlight, 3.0);'
];

var diffuseRay = ' ray = cosineWeightedDirection(bounceRandom.xy, normal);';

var materialRay = [
  diffuseRay,
  ' ray = reflect(ray, normal);',
  ' ray = normalize(reflect(ray, normal)) + uniformlyRandomVector(bounceRandom) * glossiness;'
];

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
  // the last bounce shades its hit point but nothing ever traces the ray it
  // would scatter into, so that ray is not generated at all
  var notLastBounce = ' if(bounce < ' + (bounces - 1).toFixed(0) + ')';

  return '' +
' vec3 calculateColor(vec3 origin, vec3 ray) {' +
'   vec3 colorMask = vec3(1.0);' +
'   vec3 accumulatedColor = vec3(0.0);' +

    // main raytracing loop
'   for(int bounce = 0; bounce < ' + bounces.toFixed(0) + '; bounce++) {' +
      // this bounce's two sample points: one to pick a point on the light, one
      // to pick the direction the surface scatters into. Every bounce draws
      // from its own dimensions of the sequence so that the choices stay
      // independent of each other.
'     vec3 lightRandom = sampleCube(lightSamples[bounce], float(bounce) * 2.0);' +
'     vec3 bounceRandom = sampleCube(bounceSamples[bounce], float(bounce) * 2.0 + 1.0);' +
      // jittering the light position per bounce (rather than once per path)
      // keeps the soft shadows of successive bounces from sharing an error
'     vec3 lightPos = light + uniformlyRandomVector(lightRandom) * ' + glFloat(lightSize) + ';' +

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
'     bool hitRoom = false;' +

      // calculate the normal (and change wall color)
'     if(t == tRoom.y) {' + // Room walls
'       normal = -normalForCube(hit, roomCubeMin, roomCubeMax);' +
        makeEnvironment() +
'       hitRoom = true;' +
'     } else if(t == ' + infinity + ') {' +
'       break;' +
'     } else {' + // Object surfaces
'       if(false) ;' + // hack to discard the first 'else' in 'else if'
        concat(objects, function(o){ return o.getNormalCalculationCode(); }) +
        materialHighlight[material] +
'     }' +

      // compute diffuse lighting contribution
'     vec3 toLight = lightPos - hit;' +
'     float diffuse = max(0.0, dot(normalize(toLight), normal));' +

      // trace a shadow ray to the light. Both lighting terms are multiplied by
      // the result, so when neither can contribute the ray is a whole scene
      // traversal thrown away: that is about half of all shading points on a
      // diffuse surface, which face away from the light.
'     float shadowIntensity = 0.0;' +
'     if(diffuse > 0.0 || specularHighlight > 0.0) {' +
'       shadowIntensity = shadow(hit + normal * ' + epsilon + ', toLight);' +
'     }' +

      // do light bounce
'     colorMask *= surfaceColor;' +
'     accumulatedColor += colorMask * (' + glFloat(lightVal) + ' * diffuse * shadowIntensity);' +
'     accumulatedColor += colorMask * specularHighlight * shadowIntensity;' +

      // scatter into the next ray, and calculate next origin
'     if(hitRoom) {' + // the room is always diffuse, whatever the objects are
        notLastBounce + '{' + diffuseRay + '}' +
'     } else {' +
        notLastBounce + '{' + materialRay[material] + '}' +
'     }' +
'     origin = hit;' +
'   }' +

'   return accumulatedColor;' +
' }';
}

function makeMain() {
  return `
 void main() {
   vec3 accumulated = texture2D(texture, gl_FragCoord.xy / vec2(${glFloat(renderWidth)}, ${glFloat(renderHeight)})).rgb;
   gl_FragColor = vec4(mix(calculateColor(initialOrigin, initialRay), accumulated, textureWeight), 1.0);
 }`;
}

function makeTracerFragmentSource(objects) {
  return makeTracerFragmentSourceHeader() +
  concat(objects, function(o){ return o.getGlobalCode(); }) +
  intersectCubeSource +
  normalForCubeSource +
  unionIntervalSource +
  intersectAxisCylinderSource +
  intersectExtrudedRectangleSource +
  normalForExtrudedRectangleSource +
  intersectSphereSource +
  normalForSphereSource +
  hashSource +
  sampleCubeSource +
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

// The world space point that (x, y) on the image plane sits at, given an
// inverted modelview projection.
function unprojectPoint(matrix, x, y) {
  return matrix.multiply(Vector.create([x, y, 0, 1])).divideByW().ensure3();
}

////////////////////////////////////////////////////////////////////////////////
// sample sequence
////////////////////////////////////////////////////////////////////////////////

// Every random choice a path makes is one coordinate of a point in a unit cube:
// two dimensions to place the sample inside the pixel, then three to pick a
// point on the light and three to pick a scattered direction, for each bounce.
//
// Drawing those points independently at random is what makes a path tracer
// grainy, because independent points clump together and leave gaps: the error
// only falls as 1/sqrt(samples). A low discrepancy sequence spreads its points
// out deliberately instead, and converges considerably faster for the same
// number of samples.
//
// This is a scrambled Halton sequence: coordinate d of point n is n written in
// base p_d (the d'th prime) with its digits reflected about the decimal point,
// which fills [0, 1) evenly for any number of samples. Writing the digits
// straight out leaves high dimensions marching in lockstep for long stretches
// (base 127 counts 1/127, 2/127, ... and so does base 131), so the digits are
// pushed through a fixed random permutation per dimension first, which is what
// keeps the dimensions independent of each other.
//
// The alternative, the golden ratio sequence R2, is cheaper but its per
// dimension strides crowd together past about eight dimensions, and a path with
// five bounces needs thirty two of them.
var SEQUENCE_SEED = 0x9e3779b9;

function sampleArrayLength() {
  return Math.max(1, bounces);
}

function firstPrimes(count) {
  var primes = [];
  for(var n = 2; primes.length < count; n++) {
    var prime = true;
    for(var i = 0; i < primes.length && primes[i] * primes[i] <= n; i++) {
      if(n % primes[i] == 0) { prime = false; break; }
    }
    if(prime) primes.push(n);
  }
  return primes;
}

function makeSampleSequence(dimensions) {
  var primes = firstPrimes(dimensions);
  // a fixed seed, so that two runs of the same scene produce the same image
  var random = SEQUENCE_SEED;
  function nextRandom() {
    random = (random * 1664525 + 1013904223) >>> 0;
    return random / 4294967296;
  }

  // digit permutation per dimension, leaving 0 in place so that the sequence
  // still starts at the origin of each stratum
  var permutations = [];
  for(var d = 0; d < dimensions; d++) {
    var base = primes[d];
    var permutation = new Int32Array(base);
    for(var i = 0; i < base; i++) permutation[i] = i;
    for(var i = base - 1; i > 1; i--) {
      var j = 1 + Math.floor(nextRandom() * i);
      var swap = permutation[i]; permutation[i] = permutation[j]; permutation[j] = swap;
    }
    permutations.push(permutation);
  }

  // computed in double precision, so that the index can grow into the millions
  // before the sequence loses resolution. A float32 shader could not do this.
  return function(index, out) {
    var n = index + 1; // point 0 of a Halton sequence is the origin
    for(var d = 0; d < dimensions; d++) {
      var base = primes[d];
      var permutation = permutations[d];
      var value = 0;
      var scale = 1 / base;
      for(var rest = n; rest > 0; rest = Math.floor(rest / base)) {
        value += permutation[rest % base] * scale;
        scale /= base;
      }
      out[d] = value;
    }
  };
}

// Holds one sample's worth of coordinates, in the layout the shader wants:
// a pixel offset, plus a light point and a scatter direction per bounce.
function SamplePoint() {
  this.dimensions = 2 + 6 * sampleArrayLength();
  this.sequence = makeSampleSequence(this.dimensions);
  this.values = new Float64Array(this.dimensions);
  this.pixel = [0, 0];
  this.lights = new Float32Array(3 * sampleArrayLength());
  this.bounces = new Float32Array(3 * sampleArrayLength());
}

SamplePoint.prototype.set = function(index) {
  this.sequence(index, this.values);
  this.pixel[0] = this.values[0];
  this.pixel[1] = this.values[1];
  for(var b = 0; b < bounces; b++) {
    var base = 2 + 6 * b;
    for(var d = 0; d < 3; d++) {
      this.lights[b * 3 + d] = this.values[base + d];
      this.bounces[b * 3 + d] = this.values[base + 3 + d];
    }
  }
};

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
    } else if(value instanceof Float32Array) {
      // an array of vec3, uploaded in one call. The name has to be the first
      // element of the array ('lightSamples[0]') for the location to be found.
      gl.uniform3fv(location, value);
    } else if(Array.isArray(value)) {
      gl.uniform3f(location, value[0], value[1], value[2]);
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
// serialization
////////////////////////////////////////////////////////////////////////////////

// A scene is built out of Sylvester vectors behind shape prototypes, none of
// which survives being posted to a worker: structured clone copies plain data
// and drops the prototypes with the methods that generate the shader. So a
// scene crossing that boundary travels as plain arrays and numbers and is
// rebuilt on the other side.

function vectorToArray(vector) {
  if(!vector) return undefined;
  var elements = vector.elements || vector;
  return [elements[0], elements[1], elements[2]];
}

function serializeObject(object) {
  var common = { id: object.id, color: vectorToArray(object.color) };

  if(object instanceof Sphere) {
    common.type = 'sphere';
    common.center = vectorToArray(object.center);
    common.radius = object.radius;
  } else if(object instanceof ExtrudedRectangle) {
    common.type = 'extrudedRectangle';
    common.minCorner = vectorToArray(object.minCorner);
    common.maxCorner = vectorToArray(object.maxCorner);
    common.borderRadius = object.borderRadius;
    common.axis = object.axis;
  } else if(object instanceof Cube) {
    common.type = 'cube';
    common.minCorner = vectorToArray(object.minCorner);
    common.maxCorner = vectorToArray(object.maxCorner);
  } else {
    return null;
  }

  return common;
}

/** Turn a scene into plain data that can be posted to a worker. */
function serializeObjects(objects) {
  var serialized = [];
  for(var i = 0; i < objects.length; i++) {
    var object = serializeObject(objects[i]);
    if(object !== null) serialized.push(object);
  }
  return serialized;
}

/** Rebuild a scene from what serializeObjects() produced. */
function deserializeObjects(serialized) {
  var objects = [];
  for(var i = 0; i < serialized.length; i++) {
    var data = serialized[i];
    var color = data.color ? Vector.create(data.color) : undefined;

    if(data.type === 'sphere') {
      objects.push(new Sphere(Vector.create(data.center), data.radius, data.id, color));
    } else if(data.type === 'cube') {
      objects.push(new Cube(Vector.create(data.minCorner), Vector.create(data.maxCorner), data.id, color));
    } else if(data.type === 'extrudedRectangle') {
      objects.push(new ExtrudedRectangle(Vector.create(data.minCorner), Vector.create(data.maxCorner),
          data.borderRadius, data.id, color, data.axis));
    }
  }
  return objects;
}

// Only the settings the core reads, so that a config carrying anything else
// (a DOM node, a callback) can still be posted to a worker.
var configKeys = ['material', 'glossiness', 'bounces', 'environment', 'zoom', 'fov',
    'projection', 'orthoHeight', 'lightPosition', 'lightSize', 'lightVal', 'samplesPerFrame'];

/** Copy the settings the core understands out of a user supplied config. */
function serializeConfig(config) {
  var copy = {};
  if(!config) return copy;
  for(var i = 0; i < configKeys.length; i++) {
    var key = configKeys[i];
    if(config[key] !== undefined) copy[key] = config[key];
  }
  if(copy.lightPosition) copy.lightPosition = vectorToArray(copy.lightPosition);
  return copy;
}

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
  this.samplePoint = new SamplePoint();
  // uniforms that change from one sample to the next, kept apart from the scene
  // uniforms so that a frame worth of samples only re-uploads what moved
  this.sampleUniforms = {
    origin00: [0, 0, 0],
    origin01: [0, 0, 0],
    origin10: [0, 0, 0],
    origin11: [0, 0, 0],
    ray00: [0, 0, 0],
    ray01: [0, 0, 0],
    ray10: [0, 0, 0],
    ray11: [0, 0, 0],
    textureWeight: 0,
    'lightSamples[0]': this.samplePoint.lights,
    'bounceSamples[0]': this.samplePoint.bounces
  };
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

  // the shader declares its sample arrays with the current bounce count, so the
  // buffers feeding them have to be rebuilt alongside it
  this.samplePoint = new SamplePoint();
  this.sampleUniforms['lightSamples[0]'] = this.samplePoint.lights;
  this.sampleUniforms['bounceSamples[0]'] = this.samplePoint.bounces;
};

// Where one corner of the view starts and which way it points. Multiplying the
// inverse modelview projection by (x, y, 0, 1) and dividing through by w gives
// the world space point that corner of the image plane sits at: a perspective
// camera shoots from the eye through it, an orthographic camera shoots from it
// along the fixed view direction. This is unprojectPoint() without Sylvester:
// it runs four times for every sample rather than once a frame, and the
// generic matrix code allocates half a dozen objects per call.
function cameraCornerInto(camera, x, y, origin, ray) {
  var rows = camera.inverse;
  var w = rows[3][0] * x + rows[3][1] * y + rows[3][3];
  var eyeElements = eye.elements;
  for(var i = 0; i < 3; i++) {
    var point = (rows[i][0] * x + rows[i][1] * y + rows[i][3]) / w;
    if(camera.orthographic) {
      origin[i] = point;
      ray[i] = camera.forward[i];
    } else {
      origin[i] = eyeElements[i];
      ray[i] = point - eyeElements[i];
    }
  }
}

// Uniforms that hold still for a whole frame: the scene, the camera and the
// material settings. Uploaded once, then left alone while the samples run.
PathTracer.prototype.beginFrame = function() {
  for(var i = 0; i < this.objects.length; i++) {
    this.objects[i].setUniforms(this);
  }
  this.uniforms.glossiness = glossiness;

  gl.useProgram(this.tracerProgram);
  setUniforms(this.tracerProgram, this.uniforms);

  gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
  gl.vertexAttribPointer(this.tracerVertexAttribute, 2, gl.FLOAT, false, 0, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.textures[1], 0);
  if (this.textureFormat.float && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    // Some drivers advertise float textures and report them as renderable, but
    // fail once a real sized attachment is used. Fall back to fixed point.
    this.textureFormat = byteTextureFormat();
    this.allocateTextures();
  }
};

PathTracer.prototype.endFrame = function() {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
};

// Accumulate one more sample into the running average. `camera` describes the
// frame's camera (see makeCamera()); the sub pixel offset that antialiases the
// image is applied to the corners of the view instead of to its matrix, so the
// matrix only has to be inverted once per frame.
PathTracer.prototype.sample = function(camera) {
  var point = this.samplePoint;
  point.set(this.sampleCount);

  // one pixel wide box filter on each axis, so that non square canvases are
  // not stretched. The offsets come out of the same sequence as everything
  // else, which makes the edges settle down much faster than random jitter.
  var dx = (point.pixel[0] * 2 - 1) / renderWidth;
  var dy = (point.pixel[1] * 2 - 1) / renderHeight;

  var uniforms = this.sampleUniforms;
  cameraCornerInto(camera, -1 - dx, -1 - dy, uniforms.origin00, uniforms.ray00);
  cameraCornerInto(camera, -1 - dx, +1 - dy, uniforms.origin01, uniforms.ray01);
  cameraCornerInto(camera, +1 - dx, -1 - dy, uniforms.origin10, uniforms.ray10);
  cameraCornerInto(camera, +1 - dx, +1 - dy, uniforms.origin11, uniforms.ray11);
  uniforms.textureWeight = this.sampleCount / (this.sampleCount + 1);
  setUniforms(this.tracerProgram, uniforms);

  // render to texture
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.textures[1], 0);
  gl.bindTexture(gl.TEXTURE_2D, this.textures[0]);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  // ping pong textures
  this.textures.reverse();
  this.sampleCount++;
};

PathTracer.prototype.update = function(camera, samples) {
  this.beginFrame();
  for(var i = 0; i < samples; i++) {
    this.sample(camera);
  }
  this.endFrame();
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

Renderer.prototype.update = function(modelviewProjection, samples) {
  if(!this.paused) {
    this.modelviewProjection = modelviewProjection;
    this.pathTracer.update(makeCamera(modelviewProjection), samples);
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
// camera
////////////////////////////////////////////////////////////////////////////////

// Height of the orthographic view volume, in world units. Left unset it frames
// the room: parallel rays do not spread out with distance, so any part of the
// view wider than the room is filled with rays that pass the room by and hit
// nothing at all. The margin keeps the corners of the view, and the sub pixel
// jitter around them, off the edges of the room where those rays run along a
// wall instead of into it.
function orthoViewHeight() {
  if(orthoHeight !== null) return orthoHeight;
  var aspect = canvasWidth / canvasHeight;
  return 2 * 0.95 * Math.min(1, 1 / aspect);
}

// A perspective camera converges its rays on the eye, so objects shrink with
// distance. An orthographic one keeps them parallel: parallel edges stay
// parallel and an object is the same size wherever it sits, which is what
// technical and isometric looking renders want.
function makeProjectionMatrix() {
  if(projection !== PROJECTION_ORTHOGRAPHIC) {
    return makePerspective(fov, canvasWidth/canvasHeight, 0.1, 100);
  }

  var halfHeight = orthoViewHeight() / 2;
  var halfWidth = halfHeight * canvasWidth / canvasHeight;
  // The view volume is centred on the eye rather than pushed out in front of
  // it, so unprojecting the image plane lands on the plane through the eye:
  // that is where the parallel rays start, outside the room like the eye of
  // the perspective camera. It reaches far enough either way to hold the whole
  // room whatever the zoom is.
  var depth = zoomZ + 2;
  return makeOrtho(-halfWidth, halfWidth, -halfHeight, halfHeight, -depth, depth);
}

// The camera a frame is traced through: the inverted modelview projection,
// which turns a point on the image into a point in the world, plus the single
// ray direction an orthographic camera uses for every pixel.
function makeCamera(modelviewProjection) {
  var camera = {
    orthographic: projection === PROJECTION_ORTHOGRAPHIC,
    inverse: modelviewProjection.inverse().elements,
    forward: [0, 0, 0]
  };

  if(camera.orthographic) {
    // the camera always looks at the origin, so it faces back down the eye
    var elements = eye.elements;
    var length = Math.sqrt(elements[0] * elements[0] + elements[1] * elements[1] + elements[2] * elements[2]) || 1;
    for(var i = 0; i < 3; i++) {
      camera.forward[i] = -elements[i] / length;
    }
  }

  return camera;
}

////////////////////////////////////////////////////////////////////////////////
// class UI
////////////////////////////////////////////////////////////////////////////////

function UI() {
  this.renderer = new Renderer();
  this.moving = false;
  this.rotating = false;
  this.oldX = 0;
  this.oldY = 0;
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

UI.prototype.update = function(samples) {
  this.modelview = makeLookAt(eye.elements[0], eye.elements[1], eye.elements[2], 0, 0, 0, 0, 1, 0);
  this.projection = makeProjectionMatrix();
  this.modelviewProjection = this.projection.multiply(this.modelview);
  // cached so that picking and dragging do not invert a 4x4 matrix per event
  this.modelviewProjectionInverse = this.modelviewProjection.inverse();
  this.renderer.update(this.modelviewProjection, samples === undefined ? 1 : samples);
};

// convert a position in canvas pixels into the ray the camera shoots through
// it, as an {origin, ray} pair: an orthographic camera starts every ray at a
// different point, so the origin is not always the eye. Returns null until the
// first frame has run and the camera matrices exist.
UI.prototype.getCameraRay = function(x, y) {
  if(!this.modelviewProjectionInverse) return null;

  var point = unprojectPoint(this.modelviewProjectionInverse, (x / canvasWidth) * 2 - 1, 1 - (y / canvasHeight) * 2);
  if(projection === PROJECTION_ORTHOGRAPHIC) {
    return { origin: point, ray: eye.toUnitVector().multiply(-1) };
  }
  return { origin: eye, ray: point.subtract(eye) };
};

UI.prototype.mouseDown = function(x, y) {
  var t;
  var camera = this.getCameraRay(x, y);
  if(camera === null) return false;
  var origin = camera.origin;
  var ray = camera.ray;

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
    var camera = this.getCameraRay(x, y);
    if(camera === null) return;
    var origin = camera.origin;
    var ray = camera.ray;

    var t = (this.movementDistance - this.movementNormal.dot(origin)) / this.movementNormal.dot(ray);
    var hit = origin.add(ray.multiply(t));
    this.renderer.selectedObject.temporaryTranslate(hit.subtract(this.originalHit));

    // clear the sample buffer
    this.renderer.pathTracer.sampleCount = 0;
  }
};

UI.prototype.mouseUp = function(x, y) {
  if(this.moving) {
    var camera = this.getCameraRay(x, y);
    if(camera === null) return;
    var origin = camera.origin;
    var ray = camera.ray;

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

////////////////////////////////////////////////////////////////////////////////
// pointer input
////////////////////////////////////////////////////////////////////////////////

// A pointer press either grabs an object or, when it lands on nothing, orbits
// the camera. Which one it is has to be decided where the scene lives, so the
// whole gesture is handled here and the layer above only maps events to canvas
// pixels. `x` and `y` are in canvas drawing buffer pixels.

// Returns true if the press hit an object, which is what tells the caller the
// gesture is a drag rather than a camera orbit.
UI.prototype.pointerDown = function(x, y) {
  var hit = this.mouseDown(x, y);
  this.rotating = !hit;
  this.oldX = x;
  this.oldY = y;
  return hit;
};

UI.prototype.pointerMove = function(x, y) {
  if(!this.rotating) {
    this.mouseMove(x, y);
    return;
  }

  // update the angles based on how far we moved since last time
  angleY -= (x - this.oldX) * 0.01;
  angleX += (y - this.oldY) * 0.01;

  // don't go upside down
  angleX = Math.max(angleX, -Math.PI / 2 + 0.01);
  angleX = Math.min(angleX, Math.PI / 2 - 0.01);

  // clear the sample buffer
  this.renderer.pathTracer.sampleCount = 0;

  // remember this coordinate
  this.oldX = x;
  this.oldY = y;
};

UI.prototype.pointerUp = function(x, y) {
  this.rotating = false;
  this.mouseUp(x, y);
};

UI.prototype.cancelPointer = function() {
  this.rotating = false;
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

// Switch between the perspective and the orthographic camera. `newProjection`
// is 'perspective' or 'orthographic'.
UI.prototype.updateProjection = function(newProjection) {
  newProjection = (newProjection === PROJECTION_ORTHOGRAPHIC) ? PROJECTION_ORTHOGRAPHIC : PROJECTION_PERSPECTIVE;
  if(projection != newProjection) {
    projection = newProjection;
    // every pixel now looks somewhere else, so what has been accumulated so
    // far belongs to a different image
    this.renderer.pathTracer.sampleCount = 0;
  }
};

// Set the height of the orthographic view volume in world units, which is what
// zooming means without a vanishing point. Pass null to go back to framing the
// room.
UI.prototype.updateOrthoHeight = function(newHeight) {
  newHeight = (typeof newHeight === 'number' && newHeight > 0) ? newHeight : null;
  if(orthoHeight != newHeight) {
    orthoHeight = newHeight;
    if(projection === PROJECTION_ORTHOGRAPHIC) {
      this.renderer.pathTracer.sampleCount = 0;
    }
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

const PROJECTION_PERSPECTIVE = 'perspective';
const PROJECTION_ORTHOGRAPHIC = 'orthographic';
let projection = PROJECTION_PERSPECTIVE;
// null sizes the orthographic view to the room, see orthoViewHeight()
let orthoHeight = null;

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

let previousTimeStamp;
let animationFrame;

// A dedicated worker rendering into an OffscreenCanvas drives requestAnimationFrame
// off its own global rather than a `window`, so go through the global scope
// instead of naming one. The timer fallback is for a worker without the
// animation frame provider at all, where the loop still has to run.
const requestFrame = (typeof self !== 'undefined' && self.requestAnimationFrame)
  ? self.requestAnimationFrame.bind(self)
  : function(callback) { return setTimeout(function() { callback(performance.now()); }, 16); };

const cancelFrame = (typeof self !== 'undefined' && self.cancelAnimationFrame)
  ? self.cancelAnimationFrame.bind(self)
  : function(handle) { clearTimeout(handle); };

////////////////////////////////////////////////////////////////////////////////
// frame budget
////////////////////////////////////////////////////////////////////////////////

// Accumulating exactly one sample per animation frame caps the path tracer at
// the refresh rate however fast the hardware is, and a sample of a modest scene
// takes a fraction of a frame on any recent GPU: the rest of the frame is spent
// waiting for the next vsync. Instead, accumulate as many samples per frame as
// fit in a frame's worth of time, measured from how long the frames actually
// take. On hardware that was already saturated this settles back at one sample
// per frame and behaves as it did before.

// how much of a 60fps frame to spend tracing, leaving the rest of it to the
// browser and to the page around the canvas
const sampleBudgetMs = 13;
const maxSamplesPerFrame = 64;
let samplesPerFrame = 1;
// null means adapt, a number pins the count (config.samplesPerFrame)
let fixedSamplesPerFrame = null;
// running estimate of what one sample costs, seeded pessimistically so that the
// renderer starts at one sample a frame and grows into whatever time is free
let msPerSample = sampleBudgetMs;

// Wait for the frame's drawing to actually happen before timing it. WebGL calls
// only queue work: left alone, the browser keeps calling requestAnimationFrame
// at the refresh rate while the driver falls further and further behind, and
// every frame looks like a comfortable 60fps no matter how much work is
// outstanding, which is exactly the wrong signal to size the sample budget
// from. gl.finish() is meant to do this and is a bare flush on several drivers;
// reading a pixel has to return real data, so it cannot be skipped. This costs
// the overlap between preparing one frame and drawing the previous one, well
// under a millisecond against a frame of tracing.
const syncPixel = new Uint8Array(4);

function waitForFrame() {
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, syncPixel);
}

function resetFrameBudget() {
  samplesPerFrame = fixedSamplesPerFrame === null ? 1 : fixedSamplesPerFrame;
  msPerSample = sampleBudgetMs;
}

// `workMs` is how long this frame's `samples` samples took, measured across the
// wait at the end of them, so it is real elapsed drawing time and not just how
// fast the commands were queued. Note that it also carries the fixed cost of
// that wait, which is why the count is grown until the budget is exceeded
// rather than divided out of the measurement directly: a per frame overhead
// divided by one sample looks like an expensive sample and would keep the
// count pinned at one forever.
function updateFrameBudget(workMs, samples) {
  if(fixedSamplesPerFrame !== null) {
    samplesPerFrame = fixedSamplesPerFrame;
    return;
  }
  if(!(workMs > 0)) return;

  if(workMs > sampleBudgetMs) {
    // Over budget, which finally puts a number on what a sample costs. Take it
    // at once rather than averaging it in, so that a scene which just got
    // heavier cannot spend several slow frames walking back down. Halving is
    // the floor on how far the estimate may drop in one step, so a hitch
    // elsewhere on the page cannot collapse the budget either.
    msPerSample = Math.max(workMs / samples, msPerSample * 0.5);
  } else {
    // Under budget, but that only says a sample costs at most this much, never
    // how much of the frame was left over: assume a little more room each time
    // and let the branch above catch the overshoot. Going over the budget is
    // not the same as dropping a frame, the budget leaves room to spare, so the
    // few percent this oscillates by stays invisible.
    msPerSample *= 0.92;
  }
  samplesPerFrame = Math.max(1, Math.min(maxSamplesPerFrame, Math.floor(sampleBudgetMs / msPerSample)));
}

function tick(timeStamp) {
  // always queue the next frame first: bailing out early used to stop the
  // render loop for good instead of just skipping a frame
  animationFrame = requestFrame(tick);

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

  var samples = samplesPerFrame;
  var startedAt = performance.now();
  ui.update(samples);
  ui.render();
  waitForFrame();
  updateFrameBudget(performance.now() - startedAt, samples);
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
 * Initialize the path tracer on the given canvas.
 *
 * This is the DOM free core: it renders and holds the scene, but it installs no
 * event listeners and never looks at the document, so it runs unchanged on the
 * main thread against a canvas or in a worker against an OffscreenCanvas. See
 * makePathTracer() in webgl-path-tracing.js for the interactive entry point.
 *
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas - Canvas to render to
 * @param {Object[]} objects - Array of Sphere, Cube and ExtrudedRectangle objects
 * @param {Object} [config] - Specify: material, glossiness (0-1), environment, bounces (light bounces per ray), zoom (in distance from center), projection ('perspective' or 'orthographic'), fov (field of view, in degrees, perspective only), orthoHeight (height of the orthographic view in world units, defaults to framing the room), lightPosition ([x,y,z]), lightSize, lightVal (0-1), samplesPerFrame (samples accumulated per animation frame, adaptive by default)
 * @param {function} [log] - a function to print log messages to, defaults to console.log
 * @returns {UI}
 */
function makePathTracerCore(canvas, objects, config = {}, log) {
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
  projection = (config.projection === PROJECTION_ORTHOGRAPHIC) ? PROJECTION_ORTHOGRAPHIC : PROJECTION_PERSPECTIVE;
  orthoHeight = (typeof config.orthoHeight === 'number' && config.orthoHeight > 0) ? config.orthoHeight : null;
  if(config.lightPosition) {
    light = Vector.create(config.lightPosition);
  }
  if(config.lightSize !== undefined) {
    lightSize = config.lightSize;
  }
  if(config.lightVal !== undefined) {
    lightVal = config.lightVal;
  }
  // how many samples to accumulate per animation frame. Left alone the
  // renderer measures the frame time and picks the largest count that still
  // holds the refresh rate; a number pins it, which is what a benchmark or a
  // deliberately light background animation wants.
  fixedSamplesPerFrame = null;
  if(typeof config.samplesPerFrame === 'number') {
    fixedSamplesPerFrame = Math.max(1, Math.round(config.samplesPerFrame));
  }

  log = log || console.log;

  // starting over: stop any loop still running from a previous call before
  // dropping the instance it renders through
  if(animationFrame !== undefined) {
    cancelFrame(animationFrame);
    animationFrame = undefined;
  }
  ui = undefined;
  previousTimeStamp = undefined;
  resetFrameBudget();

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
      animationFrame = requestFrame(tick);
    } else {
      log('canvas must have a non-zero width and height');
    }
  } else {
    log('Your browser does not support WebGL.<br>Please see <a href="http://www.khronos.org/webgl/wiki/Getting_a_WebGL_Implementation">Getting a WebGL Implementation</a>.');
  }

  // the caller drives the loop and the input from outside: the core never
  // touches the DOM, so that it can run in a worker against an OffscreenCanvas
  if(ui) {
    ui.dispose = function() {
      if(animationFrame !== undefined) {
        cancelFrame(animationFrame);
        animationFrame = undefined;
      }
    };
  }

  return ui;
};

////////////////////////////////////////////////////////////////////////////////
// command dispatch
////////////////////////////////////////////////////////////////////////////////

// Everything the page can ask of a running tracer, named so that it can travel
// as a message. The worker and the main thread fallback both drive the tracer
// through this, so the two paths cannot drift apart. `message.objects`, where
// there is one, holds live shapes: the worker rebuilds them before getting
// here.

// methods of the UI object a message is allowed to name
var uiMethods = {
  selectLight: true,
  addSphere: true,
  addCube: true,
  addExtrudedRectangle: true,
  deleteSelection: true,
  setLightPosition: true,
  setLightVal: true,
  updateMaterial: true,
  updateEnvironment: true,
  updateProjection: true,
  updateOrthoHeight: true,
  updateGlossiness: true
};

function applyMessage(ui, message) {
  if(!ui) return;

  switch(message.type) {
    case 'setObjects':
      ui.setObjects(message.objects);
      break;

    case 'call':
      // a name that is not on the list is a message from something other than
      // this library, so ignore it rather than calling whatever it points at
      if(uiMethods[message.method] === true) {
        ui[message.method].apply(ui, message.args || []);
      }
      break;

    case 'pause':
      ui.renderer.pause();
      break;

    case 'resume':
      ui.renderer.resume();
      break;

    case 'pointerdown':
      ui.pointerDown(message.x, message.y);
      break;

    case 'pointermove':
      ui.pointerMove(message.x, message.y);
      break;

    case 'pointerup':
      ui.pointerUp(message.x, message.y);
      break;

    case 'pointercancel':
      ui.cancelPointer();
      break;
  }
}

export {makePathTracerCore, applyMessage, Sphere, Cube, ExtrudedRectangle,
    serializeObjects, deserializeObjects, serializeConfig}
