import {Wordgard, menuBar} from "wordgard/editor"
import {fullSchema, codeBlockLanguage} from "wordgard/schema"
import {history} from "wordgard/history"
import {tables} from "wordgard/table"

;(window as any).wg = Wordgard.create({
  parent: document.body,
  doc: `<h2>Demo Content</h2><pre></pre><p>A <em>paragraph</em>.</p><pre data-language=JavaScript>let x = 100</pre>`,
  config: [
    fullSchema(),
    codeBlockLanguage({languages: ["JavaScript", "TypeScript", "Markdown", "C++", "Python"]}),
    history(),
    menuBar(),
    tables(),
  ]
})
