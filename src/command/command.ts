import {type Wordgard} from "wordgard/view"
import {GardState, Transaction, Facet} from "wordgard/state"

const commandHandler = Facet.define<
  [Command<any>, (view: Wordgard, param: any) => boolean],
  Map<Command<any>, readonly ((view: Wordgard, param: any) => boolean)[]>
>({
  combine(handlers) {
    let map = new Map<Command<any>, readonly ((view: Wordgard, param: any) => boolean)[]>()
    for (let [cmd, handler] of handlers) {
      let list = map.get(cmd) as ((view: Wordgard, param: any) => boolean)[] | undefined
      if (!list) map.set(cmd, list = [])
      list.push(handler)
    }
    return map
  }
})

/// Commands functions are used by things like key bindings, menus,
/// and event handlers to dispatch a specific type of user action.
/// They have a parameter type (which may be null and ignored) and
/// optionally a default handler.
///
/// Extensions can register additional handlers for a command, which
/// will be called in order of precedence (until one returns true)
/// when the command is dispatched.
///
/// Command handlers should check whether their effect can be applied
/// to the editor they are given, and return false if it cannot. If it
/// can, the handler performs it as a side effect (which usually means
/// [dispatching](#view.Wordgard.dispatch) a transaction) and
/// returns `true`. FIXME update
export type Command<Param = null> = (target: Wordgard, param: Param) => boolean

export namespace Command {
  // FIXME better name
  export type State<Param = null> = (target: {state: GardState, dispatch: (tr: Transaction) => void}, param: Param) => boolean

  export class Bound<Param> {
    declare private tag: "Command.Bound"
    private constructor(readonly command: Command<Param>, readonly param: Param) {}
    /// @internal
    static bind<Param>(command: Command<Param>, param: Param): Command.Bound<Param> {
      return new Bound(command, param)
    }
  }

  export const bind = Bound.bind

  export type Target = {state: GardState, dispatch: (tr: Transaction) => void}

  /// Create an extension that adds a handler for the given {@link
  /// state.Command | command}.
  export function handler<Param>(command: Command<Param>, handler: (view: Wordgard, param: Param) => boolean): GardState.Extension {
    return commandHandler.of([command, handler] as any)
  }

  export function dispatch<Param>(view: Wordgard, command: Command<null> | Command.Bound<any>): boolean
  export function dispatch<Param>(view: Wordgard, command: Command<Param>, param: Param): boolean
  export function dispatch<Param>(view: Wordgard, command: Command<any> | Command.Bound<any>, p?: Param): boolean {
    let {command: cmd, param} = command instanceof Command.Bound ? command : {command, param: p ?? null}
    let handlers = view.state.facet(commandHandler).get(cmd)
    if (handlers) for (let handler of handlers) {
      let result = handler(view, param)
      if (result) return true
    }
    return cmd(view, param)
  }
}
