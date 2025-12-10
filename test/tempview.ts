// Helper library for browser test scripts

import {EditorView} from "../dist/view.js"
import {type Extension} from "../dist/state.js"
import {DocNode, maybeTag} from "../dist/doc.js"

const workspace: HTMLElement = document.querySelector("#workspace")! as HTMLElement

let currentTempView: EditorView | null = null
let hide: any = null

/// Create a hidden view with the given document and extensions that
/// lives until the next call to `tempView`.
export function tempView(doc: string | DocNode, config: Extension = []): EditorView {
  if (currentTempView) {
    currentTempView.dom.remove()
    currentTempView = null
  }

  let t0, t1
  if (typeof doc != "string") {
    t0 = maybeTag(doc, 0); t1 = maybeTag(doc, 1)
  }
  currentTempView = new EditorView({doc, selection: t0 != null ? {anchor: t0, head: t1} : undefined, config})
  workspace.appendChild(currentTempView.dom)
  workspace.style.pointerEvents = ""
  if (hide == null) hide = setTimeout(() => {
    hide = null
    workspace.style.pointerEvents = "none"
  }, 100)
  return currentTempView
}

/// Focus the given view or raise an error when the window doesn't have focus.
export function requireFocus(view: EditorView): EditorView {
  if (!document.hasFocus())
    throw new Error("The document doesn't have focus, which is needed for this test")
  view.focus()
  return view
}
