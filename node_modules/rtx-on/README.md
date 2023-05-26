# rtx-on

Use proper ray traced shadow instead of the boring box-shadow

![Example of this library on example.com](screenshot.jpg)

## Using the module

Install the module with `npm install rtx-on`

### Quickstart

```html
<script type="importmap">
{
    "imports": {
        "webgl-path-tracing": "../node_modules/webgl-path-tracing/webgl-path-tracing.js",
        "sylvester": "../node_modules/webgl-path-tracing/sylvester.src.js",
        "rtx-on": "../rtx-on.js"
    }
}
</script>
<script type="module">
import * as rtx from 'rtx-on';

window.onload = function() {
    rtx.on();
}
</script>
```

See the [examples folder](./examples/) for more examples.

### API reference

#### `rtx.on({background, raised})`

Turn on the ray traced shadow effect on the provided background elements for the provided raised elements.
Removes any existing box shadow effect.

 * `background` element to apply the effect to, defaults to the entire body.
 * `raised[]` elevated elements, defaults to children of the background element if one is passed or to children of the body if none.
 * `disableIfDarkMode`: if `true`, will not apply the effect if the user has dark mode enabled. Defaults to `false`.
 * `enableForAllAspectRatio`: At the moment, the effect only applies if the page isn't too wide or high. Set to `true` to force enable the effect on any aspect ratio.

#### `rtx.off()`

Turn off the ray traced shadow effect.
Restores any existing box shadow effect.

#### `rtx.button()`

Display an RTX ON/OFF button on the page. For fun.

