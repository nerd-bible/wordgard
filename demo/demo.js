import {EditorView, keymap, defaultKeymap} from "@wordgard/view"
import {basicSchema, Strong} from "@wordgard/doc"
import {schemaElement, EditorSelection} from "@wordgard/state"

let view = window.view = new EditorView({
  parent: document.body,
  doc: "<p>-</p>",
  selection: EditorSelection.cursor(2, -1, -1, [Strong]),
  extensions: [
    schemaElement.of(basicSchema.tags.concat(basicSchema.props)),
    keymap.of(defaultKeymap)
  ]
})

view.focus()
