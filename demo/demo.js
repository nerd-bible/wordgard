import {EditorView, keymap, defaultKeymap, InlineDecoration} from "@willows/view"
import {basicSchema} from "@willows/doc"
import {schemaElement, SpanSet} from "@willows/state"

window.view = new EditorView({
  parent: document.body,
  doc: "<p>One <strong>Two</strong></p><p>Three</p>",
  extensions: [
    schemaElement.of(basicSchema.tags.concat(basicSchema.props)),
    keymap.of(defaultKeymap),
    EditorView.decorations.of(SpanSet.of(new InlineDecoration({element: "strong"}).span(1, 3)))
  ]
})
