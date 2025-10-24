import {EditorView, keymap, defaultKeymap} from "@wordgard/view"
import {basicSchema} from "@wordgard/doc"

let view = window.view = new EditorView({
  parent: document.body,
  doc: "<p>-</p><hr><hr>",
  config: [
    basicSchema.elements,
    keymap.of(defaultKeymap)
  ]
})
