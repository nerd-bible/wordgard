import {Wordgard, menuBar, Decoration, decoratePlots} from "wordgard/editor"
import {fullSchema, codeBlockLanguage} from "wordgard/schema"
import {history} from "wordgard/history"
import {tables} from "wordgard/table"
import {Paragraph} from "wordgard/types"

const blue = Decoration.Range.attribute("style", "background: lightblue")

;(window as any).wg = Wordgard.create({
  parent: document.body,
  doc: `<h2>Demo Content</h2><p>A <em>paragraph</em>.</p>`,
  config: [
    fullSchema(),
    codeBlockLanguage({languages: ["JavaScript", "TypeScript", "Markdown", "C++", "Python"]}),
    history(),
    menuBar(),
    tables(),
    decoratePlots({
      type: Paragraph.type,
      ranges: (_, add) => add(blue, 0, 2)
    })
  ]
})
