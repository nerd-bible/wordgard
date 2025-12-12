import {EditorView, keymap, defaultKeymap} from "wordgard/view"
import {basicSchema} from "wordgard/doc"
import {menuBar, staticMenu} from "wordgard/menu"
import {history, historyKeymap} from "wordgard/history"

;(window as any).view = new EditorView({
  parent: document.body,
  doc: "<h3>Hello</h3><p>I am Wordgard</p>",
  config: [
    basicSchema.elements,
    keymap.of(defaultKeymap.concat(historyKeymap)),
    history(),
    staticMenu,
    menuBar()
  ]
})
