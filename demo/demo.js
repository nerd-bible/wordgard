import {EditorView, keymap, defaultKeymap} from "@wordgard/view"
import {basicSchema} from "@wordgard/doc"
import {menuBar, staticMenu} from "@wordgard/menu"

let view = window.view = new EditorView({
  parent: document.body,
  doc: "<p>12 34 56</p><hr><hr>",
  config: [
    basicSchema.elements,
    keymap.of(defaultKeymap),
    staticMenu,
    menuBar()
  ]
})
