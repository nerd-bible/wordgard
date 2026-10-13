import {Transaction, GardState} from "wordgard/state"
import {phrases} from "wordgard/phrases"
import {Tooltip} from "./tooltip"
import {Wordgard} from "./editor"

/// Dialogs are UI elements opened as a side-effect and closed by user
/// action. They may be either placed near some document position (as
/// a {@link Tooltip tooltip}), or free-floating.
export interface Dialog {
  /// A function to render the content of the dialog. The result
  /// should contain at least one `<form>` element. Submit handlers
  /// and a handler for the Escape key will be added to the form.
  ///
  /// If this is not given, the `label`, `input`, and `submitLabel`
  /// fields will be used to create a simple form for you.
  content?: (wg: Wordgard, close: () => void) => Element | DocumentFragment
  /// When `content` isn't given, this provides the text shown in the
  /// dialog.
  label?: string
  /// The attributes for an input element shown next to the label. If
  /// not given, no input element is added.
  input?: {[attr: string]: string}
  /// The label for the button that submits the form. Defaults to
  /// `"OK"`.
  submitLabel?: string,
  /// Extra classes to add to the element.
  class?: string
  /// A query selector to find the field that should be focused when
  /// the dialog is opened. When set to true, this picks the first
  /// `<input>` or `<button>` element in the form. When set to
  /// `false`, focus is not moved into the dialog.
  focus?: string | boolean
  /// If given, a transaction for which the predicate returns true
  /// will automatically close the dialog.
  closedBy?: (tr: Transaction) => boolean
  /// Provide this option to position this dialog like a tooltip,
  /// relative to some document position.
  tooltip?: Omit<Tooltip, "create">
}

export namespace Dialog {
  /// Show a dialog to display a message or prompt the user for input.
  /// Returns an effect that can be dispatched to close the dialog,
  /// and a promise that resolves when the dialog is closed or a form
  /// inside of it is submitted.
  ///
  /// You are encouraged, if your handling of the result of the promise
  /// dispatches a transaction, to include the `close` effect in it. If
  /// you don't, this function will automatically dispatch a separate
  /// transaction right after.
  export function show(wg: Wordgard, config: Dialog): {
    close: Transaction.Effect<unknown>,
    result: Promise<HTMLFormElement | null>
  } {
    let resolve: (form: HTMLFormElement | null) => void
    let result = new Promise<HTMLFormElement | null>(r => resolve = r)
    let dialog: OpenDialog = new OpenDialog(config, resolve!, config.tooltip ? {
      ...config.tooltip,
      create: (wg: Wordgard) => createDialog(wg, dialog),
    } : null)

    let effects: Transaction.Effect<unknown>[] = [openDialog.of(dialog)]
    if (!wg.state.field(dialogs, false))
      effects.push(GardState.appendConfig.of([dialogs, renderDialogs]))
    wg.dispatch({effects})
    // Make sure this dialog gets resolved even if it never makes it to the plugin
    wg.scheduleDOMRead(() => {
      if (!wg.state.field(dialogs).includes(dialog)) dialog.resolve(null)
    })

    return {close: closeDialog.of(dialog), result}
  }

  /// Close an open dialog by class name.
  export function close(wg: Wordgard, className: string) {
    let active = wg.state.field(dialogs, false)
    if (!active) return false
    let found = active.find(d => d.spec.class == className)
    if (!found) return false
    wg.dispatch({effects: closeDialog.of(found)})
    return true
  }
}

function createDialog(wg: Wordgard, dialog: OpenDialog): {
  dom: HTMLElement,
  connect: () => void
} {
  let config = dialog.spec
  let content = config.content ? config.content(wg, () => done(null)) : null
  if (!content) {
    content = document.createElement("form")
    content.className = "wg-form"
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
  close.setAttribute("aria-label", phrases.get(wg.state, "dialog_close"))
  close.className = "wg-dialog-close"
  close.type = "button"
  close.append("×")
  let dom = document.createElement("dialog")
  dom.open = true
  dom.append(content, close)
  if (config.class) dom.className = config.class

  function done(form: HTMLFormElement | null) {
    if (dom.contains(wg.win.document.activeElement)) wg.focus()
    dialog.resolve(form)
    wg.dispatch({effects: closeDialog.of(dialog)})
  }
  let mustFocus = config.focus
  return {
    dom,
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

class OpenDialog {
  constructor(
    readonly spec: Dialog,
    readonly resolve: (form: HTMLFormElement | null) => void,
    readonly tooltip: Tooltip | null,
  ) {}
}

const openDialog = Transaction.Effect.define<OpenDialog>()
const closeDialog = Transaction.Effect.define<OpenDialog>()

const dialogs = GardState.Field.define<readonly OpenDialog[]>({
  create: () => [],
  update: (value, tr) => {
    for (let e of tr.effects) {
      if (e.is(openDialog)) value = value.concat(e.value)
      else if (e.is(closeDialog)) value = value.filter(d => d != e.value)
    }
    for (let i = 0; i < value.length; i++) {
      let {closedBy} = value[i].spec
      if (closedBy && closedBy(tr)) {
        value = value.slice(0, i).concat(value.slice(i + 1))
        i--
      }
    }
    return value
  },
  provide: f => Tooltip.show.computeN(state => {
    let tooltips: Tooltip[] = []
    for (let d of state.field(f)) if (d.tooltip) tooltips.push(d.tooltip)
    return tooltips
  })
})

const renderDialogs = Wordgard.Plugin.fromClass(class {
  active: readonly OpenDialog[] = []
  elements: (HTMLElement | null)[] = []
  mustPosition = false

  constructor(wg: Wordgard) {
    this.positionDialogs = this.positionDialogs.bind(this)
    this.updateTo(wg, wg.state.field(dialogs))
    if (this.mustPosition) wg.scheduleDOMRead(this.positionDialogs)
  }

  update(update: Wordgard.Update) {
    let active = update.state.field(dialogs)
    if (this.active != active) this.updateTo(update.editor, active)
    if (update.geometryChanged && this.mustPosition) update.editor.scheduleDOMRead(this.positionDialogs)
  }

  updateTo(wg: Wordgard, active: readonly OpenDialog[]) {
    for (let i = 0; i < this.active.length; i++) if (!active.includes(this.active[i])) {
      let elt = this.elements[i], dialog = this.active[i]
      if (elt) elt.remove()
      dialog.resolve(null)
    }
    this.mustPosition = false
    this.elements = active.map((dialog, i) => {
      if (dialog.tooltip) return null
      this.mustPosition = true
      let panel: HTMLElement | undefined
      let found = this.active.indexOf(dialog)
      if (found > -1) {
        panel = this.elements[found]!
      } else {
        let {dom, connect} = createDialog(wg, dialog)
        dom.classList.add("wg-free-dialog")
        wg.dom.appendChild(dom)
        connect()
        panel = dom
      }
      panel.style.zIndex = String(400 + i)
      return panel
    })
    this.active = active
  }

  positionDialogs(wg: Wordgard) {
    let sizes = this.elements.map(e => e && e.getBoundingClientRect())
    let editor = wg.dom.getBoundingClientRect()
    let windowWidth = wg.win.innerWidth, windowHeight = wg.win.innerHeight
    let midX = (Math.max(0, editor.left) + Math.min(windowWidth, editor.right)) / 2
    let midY = (Math.max(0, editor.top) + Math.min(windowHeight, editor.bottom)) / 2
    wg.scheduleDOMWrite(() => {
      for (let i = 0; i < sizes.length; i++) {
        let size = sizes[i]
        if (!size) continue
        let baseX = midX - size.width / 2, baseY = midY - size.height / 2
        if (baseX < 0) baseX = 0
        else if (baseX + size.width > windowWidth && size.width < windowWidth) baseX = windowWidth - size.width
        if (baseY < 0) baseY = 0
        else if (baseY + size.height > windowHeight && size.height < windowHeight) baseY = windowHeight - size.height
        let elt = this.elements[i]!
        elt.style.left = baseX + "px"
        elt.style.top = baseY + "px"
      }
    })
  }

  destroy() {
    for (let elt of this.elements) if (elt) elt.remove()
  }
})
