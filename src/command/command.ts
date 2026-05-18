import {type Wordgard} from "wordgard/editor"
import {GardState, Transaction} from "wordgard/state"

const commandHandler = GardState.Facet.define<
  [Command<any>, (wg: Wordgard, param: any) => boolean],
  Map<Command<any>, readonly ((wg: Wordgard, param: any) => boolean)[]>
>({
  combine(handlers) {
    let map = new Map<Command<any>, readonly ((wg: Wordgard, param: any) => boolean)[]>()
    for (let [cmd, handler] of handlers) {
      let list = map.get(cmd) as ((wg: Wordgard, param: any) => boolean)[] | undefined
      if (!list) map.set(cmd, list = [])
      list.push(handler)
    }
    return map
  }
})

/// Commands functions are used by things like key bindings, menus,
/// and event handlers to dispatch a specific type of user action.
/// They have a parameter type (which may be null and ignored).
///
/// A command may return `true`, which indicates that it took effect
/// (via a side effect), or a transaction spec (which should be
/// dispatched as its effect). Or it can return `false` to indicate
/// that it doesn't apply.
///
/// Extensions can register additional handlers for a command, which
/// will be called in order of precedence (until one returns true)
/// when the command is {@link Command.dispatch | dispatched}.
/// Commands are recognized by function identity. So, for example, the
/// `enter` command is both the tag used to indicate invocation of an
/// enter press and the function that implements the default behavior
/// for that.
export type Command<Param = null> = (target: Wordgard, param: Param) => boolean | Transaction.Spec

export namespace Command {
  /// `Command.Pure` is a subtype of `Command` that relies only on the
  /// editor state, and performs no imperative effects. When
  /// implementing such a command function, it can be useful to tag it
  /// with this type, so that it can be invoked without a full editor
  /// component for testing or for use in a context where there is no
  /// editor.
  export type Pure<Param = null> = (target: {state: GardState}, param: Param) => false | Transaction.Spec

  /// Create an extension that adds a handler for the given {@link
  /// state.Command | command}.
  export function handler<Param>(command: Command<Param>, handler: Command<Param>): GardState.Extension {
    return commandHandler.of([command, handler] as any)
  }

  /// Bind a command with a parameter. The only thing you can do with
  /// a bound command is to {@link Command.dispatch | dispatch} it.
  export function bind<Param>(command: Command<Param>, param: Param): Command.Bound {
    return {command, param} as Command.Bound
  }

  /// Opaque type used for {@link Command.bind | bound} commands.
  export type Bound = {
    readonly tag: unique symbol,
    /// @internal
    readonly command: Command<any>,
    /// @internal
    readonly param: any
  }

  /// Apply a command to the given editor view. The command can either
  /// be passed directly, with the parameter, if any, passed
  /// separately, or in {@link
  /// Command.bind | bound} form.
  export function dispatch<Param>(wg: Wordgard, command: Command<null> | Command.Bound): boolean
  export function dispatch<Param>(wg: Wordgard, command: Command<Param>, param: Param): boolean
  export function dispatch<Param>(wg: Wordgard, command: Command<any> | Command.Bound, p?: Param): boolean {
    let {command: cmd, param} = typeof command == "object" ? command : {command, param: p ?? null}
    let handlers = wg.state.facet(commandHandler).get(cmd)
    if (handlers) for (let handler of handlers) {
      let result = handler(wg, param)
      if (result) {
        if (typeof result != "boolean") wg.dispatch(result)
        return true
      }
    }
    let result = cmd(wg, param)
    if (typeof result != "boolean") wg.dispatch(result)
    return !!result
  }
}
