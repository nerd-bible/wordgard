import {EditorView} from "./editorview"
import {ViewUpdate} from "./extension"

export class DocView {
  constructor(readonly view: EditorView) {}

  update(update: ViewUpdate) {}
}
