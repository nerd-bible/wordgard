import {EditorView, keymap, defaultKeymap, showTooltip} from "@wordgard/view"
import {basicSchema} from "@wordgard/doc"

let view = window.view = new EditorView({
  parent: document.body,
  doc: "<p>12 34 56</p><hr><hr>",
  config: [
    basicSchema.elements,
    keymap.of(defaultKeymap),
    showTooltip.of({
      arrow: true,
      pos: 6,
      create: view => {
        let dom = document.createElement("div")
        dom.textContent = "tool tip"
        return {dom}
      }
    })
  ]
})
