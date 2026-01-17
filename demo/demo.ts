import {EditorView, defaultKeymap} from "wordgard/view"
import {basicSchema} from "wordgard/doc"
import {menuBar, staticMenu} from "wordgard/menu"
import {history} from "wordgard/history"

;(window as any).view = new EditorView({
  parent: document.body,
  doc: "<h3>Hello</h3><p>I am Wordgard</p>",
  config: [
    basicSchema.elements,
    defaultKeymap,
    history(),
    staticMenu,
    menuBar()
  ]
})
