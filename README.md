# Wordgard

This [Wordgard](https://code.haverbeke.berlin/wordgard/wordgard) fork currently
offers no extra functionality besides daily publishing.

You should prefer using the
[official package](https://www.npmjs.com/package/@nerd-bible/wordgard) unless
you need a recent unpublished change.

```bash
npm install wordgard@npm:@nerd-bible/wordgard
```

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
