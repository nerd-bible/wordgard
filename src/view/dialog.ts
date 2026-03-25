import {StateEffect, EditorState} from "wordgard/state"
import {showPanel, Panel, PanelConstructor, getPanel} from "./panel"
import {EditorView} from "./editorview"

type DialogConfig = {
  /// A function to render the content of the dialog. The result
  /// should contain at least one `<form>` element. Submit handlers
  /// and a handler for the Escape key will be added to the form.
  ///
  /// If this is not given, the `label`, `input`, and `submitLabel`
  /// fields will be used to create a simple form for you.
  content?: (view: EditorView, close: () => void) => HTMLElement
  /// When `content` isn't given, this provides the text shown in the
  /// dialog.
  label?: string
  /// The attributes for an input element shown next to the label. If
  /// not given, no input element is added.
  input?: {[attr: string]: string}
  /// The label for the button that submits the form. Defaults to
  /// `"OK"`.
  submitLabel?: string,
  /// Extra classes to add to the panel.
  class?: string
  /// A query selector to find the field that should be focused when
  /// the dialog is opened. When set to true, this picks the first
  /// `<input>` or `<button>` element in the form. When set to
  /// `false`, focus is not moved into the dialog.
  focus?: string | boolean
  /// By default, dialogs are shown above the editor. Set this to
  /// `false` to have it show up at the bottom.
  top?: boolean
}

/// Show a panel above or below the editor to show the user a message
/// or prompt them for input. Returns an effect that can be dispatched
/// to close the dialog, and a promise that resolves when the dialog
/// is closed or a form inside of it is submitted.
///
/// You are encouraged, if your handling of the result of the promise
/// dispatches a transaction, to include the `close` effect in it. If
/// you don't, this function will automatically dispatch a separate
/// transaction right after.
export function showDialog(view: EditorView, config: DialogConfig): {
  close: StateEffect<unknown>,
  result: Promise<HTMLFormElement | null>
} {
  let resolve: (form: HTMLFormElement | null) => void
  let promise = new Promise<HTMLFormElement | null>(r => resolve = r)
  let panelCtor = (view: EditorView) => createDialog(view, config, resolve)
  if (view.state.field(dialogField, false)) {
    view.dispatch({effects: openDialogEffect.of(panelCtor)})
  } else {
    view.dispatch({effects: StateEffect.appendConfig.of(dialogField.init(() => [panelCtor]))})
  }
  let close = closeDialogEffect.of(panelCtor)
  return {close, result: promise.then(form => {
    let queue = view.win.queueMicrotask || ((f: () => void) => view.win.setTimeout(f, 10))
    queue(() => {
      if (view.state.field(dialogField).indexOf(panelCtor) > -1)
        view.dispatch({effects: close})
    })
    return form
  })}
}

/// Find the [`Panel`](#view.Panel) for an open dialog, using a class
/// name as identifier.
export function getDialog(view: EditorView, className: string) {
  let dialogs = view.state.field(dialogField, false) || []
  for (let open of dialogs) {
    let panel = getPanel(view, open)
    if (panel && panel.dom.classList.contains(className)) return panel
  }
  return null
}

const dialogField = EditorState.Field.define<readonly PanelConstructor[]>({
  create() { return [] },
  update(dialogs, tr) {
    for (let e of tr.effects) {
      if (e.is(openDialogEffect)) dialogs = [e.value].concat(dialogs)
      else if (e.is(closeDialogEffect)) dialogs = dialogs.filter(d => d != e.value)
    }
    return dialogs
  },
  provide: f => showPanel.computeN(state => state.field(f))
})

const openDialogEffect = StateEffect.define<PanelConstructor>()
const closeDialogEffect = StateEffect.define<PanelConstructor>()

function createDialog(view: EditorView, config: DialogConfig, result: (form: HTMLFormElement | null) => void): Panel {
  let content = config.content ? config.content(view, () => done(null)) : null
  if (!content) {
    content = document.createElement("form")
    if (config.input) {
      let input = document.createElement("input")
      for (let attr in config.input) {
        if (attr == "style") input.style.cssText = config.input[attr]
        else input.setAttribute(attr, config.input[attr])
      }
      if (/^(text|password|number|email|tel|url)$/.test(input.type))
        input.classList.add("wg-textfield")
      if (!input.name) input.name = "input"
      let label = content.appendChild(document.createElement("label"))
      if (config.label) label.append(config.label + ": ")
      label.append(input)
    } else if (config.label) {
      content.append(document.createTextNode(config.label))
    }
    let button = document.createElement("button")
    button.className = "wg-dialog-button"
    button.type = "submit"
    content.append(" ", button)
    button.append(config.submitLabel ?? "OK")
  }
  let forms = content.nodeName == "FORM" ? [content] : content.querySelectorAll("form")
  for (let i = 0; i < forms.length; i++) {
    let form = forms[i] as HTMLFormElement
    form.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.keyCode == 27) { // Escape
        event.preventDefault()
        done(null)
      } else if (event.keyCode == 13) { // Enter
        event.preventDefault()
        done(form)
      }
    })
    form.addEventListener("submit", (event: Event) => {
      event.preventDefault()
      done(form)
    })
  }
  let close = document.createElement("button")
  close.onclick = () => done(null)
  close.setAttribute("aria-label", view.state.phrase("close"))
  close.className = "wg-dialog-close"
  close.type = "button"
  close.append("×")
  let panel = document.createElement("div")
  panel.append(content, close)
  if (config.class) panel.className = config.class
  panel.classList.add("wg-dialog")

  function done(form: HTMLFormElement | null) {
    if (panel.contains(panel.ownerDocument.activeElement))
      view.focus()
    result(form)
  }
  let mustFocus = config.focus
  return {
    dom: panel,
    top: config.top !== false,
    connect: () => {
      if (mustFocus) {
        mustFocus = false
        let focus: HTMLInputElement | HTMLButtonElement | undefined | null
        if (typeof config.focus == "string")
          focus = content!.querySelector(config.focus) as any
        else
          focus = content!.querySelector("input") || content!.querySelector("button")
        if (focus && "select" in focus) focus.select()
        else if (focus && "focus" in focus) focus.focus()
      }
    }
  }
}
