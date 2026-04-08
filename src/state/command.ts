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
/// returns `true`.
export class Command<Param = null, Target extends Command.Target = Command.Target> {
  private constructor(
    readonly defaultHandler: (target: Target, param: Param) => boolean
  ) {}

  bind(param: Param): Command.Bound<Param, Target> { return {command: this, param} }

  static define<Param = null, Target extends Command.Target = Command.Target>(
    defaultHandler?: (target: Target, param: Param) => boolean
  ) {
    return new Command<Param, Target>(defaultHandler || (() => false))
  }
}

export namespace Command {
  export type Bound<Param, Target extends Command.Target> =
    {command: Command<Param, Target>, param: Param} | (Param extends null ? Command<null, Target> : never)

  export type Target = {state: GardState, dispatch: (tr: Transaction) => void}
}
