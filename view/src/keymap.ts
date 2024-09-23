import {EditorView} from "./editorview"
import {Command} from "./extension"
import {Facet, Prec} from "@willows/state"
import browser from "./browser"

/// Key bindings associate keys with [command](#view.Command)-style
/// functions that should be run when a matching keyboard event
/// happens.
///
/// A key binding can either specify a specific [character](#view.KeyBinding.char) to match on, w
///
/// Bindings for a given key event are evaluated in order of
/// precedence, with each getting a chance to handle the event,
/// stopping when the first handler returns true.
///
/// Key combinations are described by strings like
/// `"Shift-Ctrl-Enter"`—a key identifier prefixed with zero or more
/// modifiers. Key identifiers are based on the strings that can
/// appear in
/// [`KeyEvent.key`](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/key).
/// Use lowercase letters to refer to letter keys. You can use
/// `"Space"` as an alias for the `" "` name.
///
/// Modifiers can be given in any order. `Shift-` (or `s-`), `Alt-` (or
/// `a-`), `Ctrl-` (or `c-` or `Control-`) and `Cmd-` (or `m-` or
/// `Meta-`) are recognized.
///
/// You can use `Mod-` as a shorthand for `Cmd-` on Mac and `Ctrl-` on
/// other platforms. So `Mod-b` is `Ctrl-b` on Linux but `Cmd-b` on
/// macOS.
///
/// Unlike character bindings, key combination bindings should refer
/// to the unmodified base key that is being pressed, not the
/// character produced by combining that key with Shift or AltGraph.
/// Keyboard mappings that rearrange the positions of Latin characters
/// _are_ taken into account for this (the mapped position is used),
/// but the library tries to 'see through' keyboard mappings that
/// assign non-Latin characters to keys (so that both the Latin and
/// the non-Latin name can be used).
export interface KeyBinding {
  /// A textual character that this binding should trigger for.
  char?: string
  /// A key combination to use for this binding. If the
  /// platform-specific property (`mac`, `win`, or `linux`) for the
  /// current platform is used as well in the binding, that one takes
  /// precedence. If `key` isn't defined and the platform-specific
  /// binding isn't either, a binding is ignored.
  key?: string,
  /// Key to use specifically on macOS.
  mac?: string,
  /// Key to use specifically on Windows.
  win?: string,
  /// Key to use specifically on Linux.
  linux?: string,
  /// The command to execute when this binding is triggered.
  run: Command,
  /// When given, this defines a second binding, using the (possibly
  /// platform-specific) key name, prefixed with `Shift-`, to activate
  /// this command.
  shift?: Command
  /// When this property is present, the function is called for every
  /// key.
  any?: (view: EditorView, event: KeyboardEvent) => boolean
  /// By default, key bindings apply when focus is on the editor
  /// content (the `"editor"` scope). Some extensions, mostly those
  /// that define their own panels, might want to allow registering
  /// bindings local to that panel. Such bindings should use a custom
  /// scope name. You may also assign multiple scope names to a
  /// binding, separating them by spaces.
  scope?: string
  /// When set to true (the default is false), this will always
  /// prevent the further handling for the bound key, even if the
  /// command(s) return false. This can be useful for cases where the
  /// native behavior of the key is annoying or irrelevant but the
  /// command doesn't always apply (such as, Mod-u for undo selection,
  /// which would cause the browser to view source instead when no
  /// selection can be undone).
  preventDefault?: boolean
  /// When set to true, `stopPropagation` will be called on keyboard
  /// events that have their `preventDefault` called in response to
  /// this key binding (see also
  /// [`preventDefault`](#view.KeyBinding.preventDefault)).
  stopPropagation?: boolean
}

type PlatformName = "mac" | "win" | "linux" | "key"

const currentPlatform: PlatformName = browser.mac ? "mac" : browser.windows ? "win" : browser.linux ? "linux" : "key"

function normalizeKeyName(name: string, platform: PlatformName): string {
  const parts = name.split(/-(?!$)/)
  let result = parts[parts.length - 1]
  if (result == "Space") result = " "
  else if (/^[A-Z]$/.test(result)) result = result.toLowerCase()
  let alt, ctrl, shift, meta
  for (let i = 0; i < parts.length - 1; ++i) {
    const mod = parts[i]
    if (/^(cmd|meta|m)$/i.test(mod)) meta = true
    else if (/^a(lt)?$/i.test(mod)) alt = true
    else if (/^(c|ctrl|control)$/i.test(mod)) ctrl = true
    else if (/^s(hift)?$/i.test(mod)) shift = true
    else if (/^mod$/i.test(mod)) { if (platform == "mac") meta = true; else ctrl = true }
    else throw new Error("Unrecognized modifier name: " + mod)
  }
  if (alt) result = "Alt-" + result
  if (ctrl) result = "Ctrl-" + result
  if (meta) result = "Meta-" + result
  if (shift) result = "Shift-" + result
  return result
}

function modifiers(name: string, event: KeyboardEvent) {
  if (event.altKey) name = "Alt-" + name
  if (event.ctrlKey) name = "Ctrl-" + name
  if (event.metaKey) name = "Meta-" + name
  if (event.shiftKey) name = "Shift-" + name
  return name
}

const enum BindingFlag {
  Char = 1,
  Key = 2,
  Any = 4,
  PreventDefault = 8,
  StopPropagation = 16,
}

class NormalizedBinding {
  constructor(
    readonly flags: BindingFlag,
    readonly name: string,
    readonly command: Command
  ) {}
}

type Keymap = Record<string, NormalizedBinding[]>

const handleKeyEvents = Prec.default(EditorView.domEventHandlers({
  keydown(event, view) {
    return runScopeHandlers(view, event, "editor")
  }
}))

/// Facet used for registering key bindings.
///
/// You can add multiple keymaps to an editor. Their priorities
/// determine their precedence (the ones specified early or with high
/// priority get checked first). When a handler has returned `true`
/// for a given key, no further handlers are called.
export const keymap = Facet.define<readonly KeyBinding[], readonly KeyBinding[]>({
  combine: maps => maps.length ? maps.reduce((a, b) => a.concat(b)) : [],
  enables: handleKeyEvents
})

/// Run the key handlers registered for a given scope. The event
/// object should be a `"keydown"` event. Returns true if any of the
/// handlers handled it.
export function runScopeHandlers(view: EditorView, event: KeyboardEvent, scope: string) {
  return runHandlers(getKeymap(view.state.facet(keymap)), event, view, scope)
}

const keymapCache = new WeakMap<readonly KeyBinding[], Keymap>()

function getKeymap(bindings: readonly KeyBinding[]) {
  let found = keymapCache.get(bindings)
  if (!found) keymapCache.set(bindings, found = buildKeymap(bindings, currentPlatform))
  return found
}

function buildKeymap(bindings: readonly KeyBinding[], platform: PlatformName) {
  let scopes: Keymap = Object.create(null)

  for (let b of bindings) {
    let baseFlags = (b.preventDefault ? BindingFlag.PreventDefault : 0) |
      (b.stopPropagation ? BindingFlag.StopPropagation : 0)
    for (let scope of b.scope ? b.scope.split(" ") : ["editor"]) {
      let array = scopes[scope] || (scopes[scope] = [])
      if (b.char)
        array.push(new NormalizedBinding(baseFlags | BindingFlag.Char, b.char, b.run))
      let key = b[platform] || b.key
      if (key)
        array.push(new NormalizedBinding(baseFlags | BindingFlag.Key, normalizeKeyName(key, platform), b.run))
      if (key && b.shift)
        array.push(new NormalizedBinding(baseFlags | BindingFlag.Key, normalizeKeyName("Shift-" + key, platform), b.shift))
      if (b.any)
        array.push(new NormalizedBinding(BindingFlag.Any, "", anyHandler(b.any)))
    }
  }
  return scopes
}

let currentKeyEvent: KeyboardEvent | null = null

function anyHandler(handler: (view: EditorView, event: KeyboardEvent) => boolean): Command {
  return view => handler(view, currentKeyEvent!)
}

function runHandlers(map: Keymap, event: KeyboardEvent, view: EditorView, scope: string): boolean {
  let handlers = map[scope]
  if (!handlers) return false
  
  currentKeyEvent = event
  let key = event.key, charCode = key.codePointAt(0)!
  let altGr = event.getModifierState("AltGraph"), fromCode = charKeyCodes[event.keyCode]
  let isChar = codePointSize(charCode) == key.length &&
    (altGr || !(event.ctrlKey || event.altKey || event.metaKey))
  let char = isChar ? String.fromCodePoint(charCode) : null
  let base = modifiers(key, event)
  // If the key used (not the physical key, but the remapped base key)
  // doesn't match the character put in event.key (due to remapping in
  // an international keyboard, or shift status), match against that
  // as well.
  let fallback = isChar && !altGr && fromCode && fromCode != base ? modifiers(fromCode, event) : null

  let handled = false, preventDefault = false, stopPropagation = false
  for (let binding of handlers) {
    let matched = ((binding.flags & BindingFlag.Char) && binding.name == char) ||
      ((binding.flags & BindingFlag.Key) && (binding.name == base || binding.name == fallback)) ||
      (binding.flags & BindingFlag.Any)
    if (matched) {
      if (!handled && binding.command(view)) {
        handled = true
        if (binding.flags & BindingFlag.StopPropagation) stopPropagation = true
      }
      if (binding.flags & BindingFlag.PreventDefault) preventDefault = true
    }
  }
  if (handled) {
    if (stopPropagation) event.stopPropagation()
    if (preventDefault) event.preventDefault()
  }
  return handled
}

function codePointSize(code: number): 1 | 2 { return code < 0x10000 ? 1 : 2 }

export const charKeyCodes: Record<number, string> = {
  32: " ", 59: ";", 61: "=", 106: "*", 107: "+", 108: ",", 109: "-", 110: ".", 111: "/", 173: "-",
  186: ";", 187: "=", 188: ",", 189: "-", 190: ".", 191: "/", 192: "`", 219: "[", 220: "\\", 221: "]", 222: "'"
}
for (var i = 0; i < 10; i++) charKeyCodes[48 + i] = String(i) // Digits
for (var i = 1; i <= 24; i++) charKeyCodes[i + 111] = "F" + i // Function keys
for (var i = 65; i <= 90; i++) charKeyCodes[i] = String.fromCharCode(i + 32) // Letters
