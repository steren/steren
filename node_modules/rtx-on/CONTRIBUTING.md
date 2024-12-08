# How to Contribute

## Publishing to npm

To update the [npm package](https://www.npmjs.com/package/rtx-on)

Run the following:

* `npm version minor`
* `git push --follow-tags`

Then a [GitHub Action](https://github.com/steren/rtx-on/blob/main/.github/workflows/npm-publish.yml) automatically publishes to npm.