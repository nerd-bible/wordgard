import {EditorView, keymap, defaultKeymap} from "@wordgard/view"
import {basicSchema} from "@wordgard/doc"
import {schemaElement} from "@wordgard/state"

window.view = new EditorView({
  parent: document.body,
  doc: "<p>-</p>",
  extensions: [
    schemaElement.of(basicSchema.tags.concat(basicSchema.props)),
    keymap.of(defaultKeymap)
  ]
})
