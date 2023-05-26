# WebGL Path Tracing

![Screenshot](image.png)

[Try it live](https://webgl-path-tracing.steren.fr)

Path tracing is a realistic lighting algorithm that simulates light bouncing around a scene. This path tracer uses WebGL for realtime performance and supports diffuse, mirrored, and glossy surfaces. The path tracer is continually rendering, so the scene will start off grainy and become smoother over time.

The entire scene is dynamically compiled into a GLSL shader. Everything can be repositioned using the current shader, but any geometry or material change means a recompilation. To calculate a pixel color, a ray is shot into the scene and allowed to bounce around five times. At each bounce, the direct light incoming at that point (including shadows) is multiplied by all previous material colors and accumulated. Soft shadows are achieved by randomly jittering the light position per-pixel.

## Use the module

Install the module with `npm install webgl-path-tracing`

Add to your page with:

```html
<script type="importmap">
	{
		"imports": {
			"webgl-path-tracing": "./node_modules/webgl-path-tracing/webgl-path-tracing.js",
			"sylvester": "./node_modules/webgl-path-tracing/sylvester.src.js"
		}
	}
</script>

<script type="module">
	import {makePathTracer, Cube, Sphere} from 'webgl-path-tracing';
	import {Vector} from 'sylvester';

	let objects = [];
	let nextObjectId = 0;
	objects.push(new Cube(Vector.create([-0.25, -1, -0.25]), Vector.create([0.25, -0.75, 0.25]), nextObjectId++));
  objects.push(new Sphere(Vector.create([0, -0.75, 0]), 0.25, nextObjectId++)); 

	window.onload = function() {
		makePathTracer(document.getElementById('canvas'), objects);
	}
</script>
<canvas id="canvas" width="512" height="512"></canvas>
```
