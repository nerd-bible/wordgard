# Wordgard

This is a downstream fork of
[Wordgard](https://code.haverbeke.berlin/wordgard/wordgard). 

It follows these tagging rules:

- If this upstream repo tagged the latest commit, it'll publish that version.
- Otherwise, it'll add a -beta1 suffix. If the last tag already has such a suffix, it'll bump it.
- The beta tag is always latest rather than prerelease. If you want only the upstream tagged versions, use the [official package](https://www.npmjs.com/package/@nerd-bible/wordgard).

```bash
npm install wordgard@npm:@nerd-bible/wordgard
```

The upstream support has been so excellent that I currently don't plan on doing anything with my fork besides CI.

```javascript
import {Wordgard, menuBar} from "wordgard/editor"
import {fullSchema} from "wordgard/schema"
import {history} from "wordgard/history"

const myEditor = Wordgard.create({
  parent: document.body,
  doc: `<h2>Hello World</h2>`,
  config: [fullSchema(), history(), menuBar()]
})
```
