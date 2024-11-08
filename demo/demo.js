import {EditorView, keymap, defaultKeymap} from "@willows/view"
import {basicSchema} from "@willows/doc"
import {schemaElement} from "@willows/state"

window.view = new EditorView({
  parent: document.body,
  doc: "<p>One</p>",
  extensions: [
    schemaElement.of(basicSchema.tags.concat(basicSchema.props)),
    keymap.of(defaultKeymap)
  ]
})
