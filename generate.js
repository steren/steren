/**
 * Reads the content of data.json and update index.html
 */

const Handlebars = require('handlebars')
const jsdom = require("jsdom")
const { JSDOM } = jsdom;
const fs = require("fs")

const data = require('./data.json')

var template = Handlebars.compile(`{{#each works}}
<steren-work class="card"
  data-id="{{this.id}}"
  data-featured="{{this.featured}}"
  data-size="{{this.size}}"
  data-completion="{{this.completion}}"
  data-seriousness="{{this.seriousness}}"
  data-type="{{this.type}}"
  data-participation="{{this.participation}}"
  data-category="{{this.category}}"
  data-date="{{this.date}}"
  >
  <a href="{{this.link.href}}" title="{{this.link.value}}" target="_blank" rel="noopener">
    {{#if this.image}}
    <div class="image-container">
      <img class="image" data-src="{{this.image}}" alt="{{this.title}} picture">
    </div>
    {{else}}
    <div class="logo-container">
      <img class="logo" data-src="{{this.logo}}" alt="{{this.title}} logo">
    </div>
    {{/if}}
    <div class="inner">
      <h3 class="title">{{this.title}}</h2>
      <p>{{this.description}}</p>
    </div>
  </a>
</steren-work>
{{/each}}`)

const result = template({works: data});
const file = 'index.html'

fs.readFile(file, 'utf8', function(error, html) {
  const { window } = new JSDOM(html)
  const elToReplace = window.document.getElementById('work-list')
  elToReplace.innerHTML = result
  fs.writeFile(file,
    window.document.documentElement.outerHTML,
    (e) => {
      if(e) {console.error(e)}
      else console.log(`${file} updated`)
    })
})
