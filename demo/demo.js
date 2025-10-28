import {EditorView, keymap, defaultKeymap, showPanel} from "@wordgard/view"
import {basicSchema} from "@wordgard/doc"

let view = window.view = new EditorView({
  parent: document.body,
  doc: "<p>-</p><hr><hr>",
  config: [
    basicSchema.elements,
    keymap.of(defaultKeymap),
    showPanel.of(view => {
      let dom = document.createElement("div")
      dom.textContent = "this is my panel"
      return {dom}
    })
  ]
})
