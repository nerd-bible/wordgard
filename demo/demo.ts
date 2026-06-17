import {Wordgard, menuBar} from "wordgard/editor"
import {fullSchema} from "wordgard/schema"
import {history} from "wordgard/history"
import {tables} from "wordgard/table"

;(window as any).wg = Wordgard.create({
  parent: document.body,
  doc: `<h2>Demo Content</h2><p>A <em>paragraph</em>.</p>`,
  config: [
    fullSchema(),
    history(),
    menuBar(),
    tables(),
  ]
})
