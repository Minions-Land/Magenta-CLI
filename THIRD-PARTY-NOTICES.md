# Third-party notices

Magenta CLI is licensed under the MIT License (see [LICENSE](LICENSE)). It is
derived from the Pi coding agent (<https://github.com/badlogic/pi-mono>), which
is used under the following license:

```text
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Software bundled in releases

A Magenta release also contains third-party software that keeps its own
copyright and license terms: the npm packages bundled into the executable or
shipped beside it, the embedded [ripgrep](https://github.com/BurntSushi/ripgrep)
executables, and the [marked](https://github.com/markedjs/marked) and
[highlight.js](https://github.com/highlightjs/highlight.js) libraries embedded
in HTML exports. Starting with the next release, the full notices, including
every bundled package's license text, ship in `docs/THIRD-PARTY-NOTICES.md`
inside the `magenta-resources-universal.tar.gz` asset; after installation the
same file is in the `docs` folder next to the `magenta` executable.

## Software in the browser app

The browser app under `docs/app/` (served at
<https://minions-land.github.io/Magenta-CLI/app/>) bundles npm packages (the
OpenAI, Anthropic and Google Gen AI SDKs, TypeBox and their dependencies) and
the marked and highlight.js libraries. Their notices, including each bundled
package's license text, are in `docs/app/LICENSES.txt`, which is generated with
every build of the app.
