import {EditorView, keymap, defaultKeymap} from "../dist/view.js"
import {basicSchema} from "../dist/doc.js"
import {menuBar, staticMenu} from "../dist/menu.js"
import {history, historyKeymap} from "../dist/history.js"

let view = (window as any).view = new EditorView({
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
