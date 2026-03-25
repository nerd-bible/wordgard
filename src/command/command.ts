import {Facet, EditorState} from "wordgard/state"
import {type EditorView} from "wordgard/view"

const commandHandler = Facet.define<
  [Command<unknown>, (view: EditorView, param: unknown) => boolean],
  Map<Command<unknown>, readonly ((view: EditorView, param: unknown) => boolean)[]>
>({
  combine(handlers) {
    let map = new Map<Command<unknown>, readonly ((view: EditorView, param: unknown) => boolean)[]>()
    for (let [cmd, handler] of handlers) {
      let list = map.get(cmd) as ((view: EditorView, param: unknown) => boolean)[] | undefined
      if (!list) map.set(cmd, list = [])
      list.push(handler)
    }
    return map
  }
})

/// Commands functions are used by things key bindings, menus, and
/// event handlers to dispatch a specific type of user action. They
/// have a parameter type (which may be null and ignored) and
/// optionally a default handler.
///
/// Extensions can register additional handlers for a command, which
/// will be called in order of precedence (until one returns true)
/// when the command is dispatched.
///
/// Command handlers should check whether their effect can be applied
/// to the editor they are given, and return false if it cannot. If it
/// can, the handler performs it as a side effect (which usually means
/// [dispatching](#view.EditorView.dispatch) a transaction) and
/// returns `true`.
export class Command<Param = null> {
  private constructor(
    readonly defaultHandler: (view: EditorView, param: Param) => boolean
  ) {}

  handler(handler: (view: EditorView, param: Param) => boolean): EditorState.Extension {
    return commandHandler.of([this, handler] as any)
  }

  dispatch(this: Command<null>, view: EditorView, param?: Param): boolean
  dispatch(view: EditorView, param: Param): boolean
  dispatch(view: EditorView, param: Param = null as Param): boolean {
    let handlers = view.state.facet(commandHandler).get(this as Command<unknown>)
    if (handlers) for (let handler of handlers) {
      let result = handler(view, param)
      if (result) return true
    }
    return this.defaultHandler(view, param)
  }

  bind(this: Command<null>): (view: EditorView) => boolean
  bind(param: Param): (view: EditorView) => boolean
  bind(param: Param = null as Param): (view: EditorView) => boolean {
    return view => this.dispatch(view, param)
  }

  static define<Param = null>(defaultHandler?: (view: EditorView, param: Param) => boolean) {
    return new Command<Param>(defaultHandler || (() => false))
  }
}
