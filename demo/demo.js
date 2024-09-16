import {EditorView} from "@willows/view"
import {basicSchema} from "@willows/doc"
import {schemaElement} from "@willows/state"

window.view = new EditorView({
  parent: document.body,
  doc: "<p>Hi <strong>you</strong></p>",
  extensions: schemaElement.of(basicSchema.tags.concat(basicSchema.props))
})
