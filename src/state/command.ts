import {type Wordgard} from "wordgard/view"
import {GardState} from "./state"
import {Transaction} from "./transaction"

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
}
