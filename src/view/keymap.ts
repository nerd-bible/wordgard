import {enter, deleteUnit, deleteWord, deleteToLineEnd, insertLineBreak, transposeChars,
        moveByUnit, moveToLineSide, moveToDocSide, moveByWord, moveByLine, moveByPage,
        selectAll, undo, redo} from "wordgard/command"
import {Facet, Prec, Extension} from "wordgard/state"
import {EditorView} from "./editorview"
import browser from "./browser"

/// Key bindings associate keys with functions that should be run when
/// a matching keyboard event happens.
///
/// A key binding can either specify a specific
/// [character](#view.KeyBinding.Spec.char) to match on, which will be
/// compared against the actual character produced by a key event, or
/// describe a [key combination](#view.KeyBinding.Spec.key).
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
export class KeyBinding {
  /// Bindings count as extensions and can be included in an editor
  /// configuration.
  extension: Extension

  private constructor(readonly spec: KeyBinding.Spec) {
    this.extension = keyBinding.of(this)
  }

  /// Define a binding.
  static define(spec: KeyBinding.Spec) { return new KeyBinding(spec) }
}

export namespace KeyBinding {
  /// A description of a key binding.
  export interface Spec {
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
    run: (view: EditorView) => boolean
    /// When given, this defines a second binding, using the (possibly
    /// platform-specific) key name, prefixed with `Shift-`, to activate
    /// this command.
    shift?: (view: EditorView) => boolean
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
    /// By default, all keys events for which a handler exists have
    /// their `preventDefault` called. You can set this to true to
    /// disable that behavior.
    allowDefault?: boolean
  }
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
  AllowDefault = 8,
}

class NormalizedBinding {
  constructor(
    readonly flags: BindingFlag,
    readonly name: string,
    readonly command: (view: EditorView, event: KeyboardEvent) => boolean
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
export const keyBinding = Facet.define<KeyBinding, readonly KeyBinding[]>({
  enables: handleKeyEvents
})

/// Run the key handlers registered for a given scope. The event
/// object should be a `"keydown"` event. Returns true if any of the
/// handlers handled it.
export function runScopeHandlers(view: EditorView, event: KeyboardEvent, scope: string) {
  return runHandlers(getKeymap(view.state.facet(keyBinding)), event, view, scope)
}

const keymapCache = new WeakMap<readonly KeyBinding[], Keymap>()

function getKeymap(bindings: readonly KeyBinding[]) {
  let found = keymapCache.get(bindings)
  if (!found) keymapCache.set(bindings, found = buildKeymap(bindings, currentPlatform))
  return found
}

function buildKeymap(bindings: readonly KeyBinding[], platform: PlatformName) {
  let scopes: Keymap = Object.create(null)

  for (let {spec: b} of bindings) {
    let baseFlags = (b.allowDefault ? BindingFlag.AllowDefault : 0)
    for (let scope of b.scope ? b.scope.split(" ") : ["editor"]) {
      let array = scopes[scope] || (scopes[scope] = [])
      let key = b[platform] || b.key
      if (b.char) {
        if (key) throw new Error("A key binding may not provide both a char and a key field")
        if (b.shift) throw new Error("Shift-modified bindings are not supported for char bindings")
        array.push(new NormalizedBinding(baseFlags | BindingFlag.Char, b.char, b.run))
      }
      if (key)
        array.push(new NormalizedBinding(baseFlags | BindingFlag.Key, normalizeKeyName(key, platform), b.run))
      if (key && b.shift)
        array.push(new NormalizedBinding(baseFlags | BindingFlag.Key, normalizeKeyName("Shift-" + key, platform), b.shift))
      if (b.any)
        array.push(new NormalizedBinding(BindingFlag.Any, "", b.any))
    }
  }
  return scopes
}

function runHandlers(map: Keymap, event: KeyboardEvent, view: EditorView, scope: string): boolean {
  let handlers = map[scope]
  if (!handlers) return false
  
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

  let handled = false, allowDefault = false
  for (let binding of handlers) {
    let matched = ((binding.flags & BindingFlag.Char) && binding.name == char) ||
      ((binding.flags & BindingFlag.Key) && (binding.name == base || binding.name == fallback)) ||
      (binding.flags & BindingFlag.Any)
    if (matched) {
      if (!handled && binding.command(view, event)) {
        handled = true
      } else {
        if (binding.flags & BindingFlag.AllowDefault) allowDefault = true
      }
    }
  }
  if (!allowDefault) event.preventDefault()
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

// FIXME test whether beforeinput events make it possible to do without most of these

export const defaultKeymap: readonly KeyBinding[] = ([
  {key: "Enter", run: enter.bind()},
  {key: "Shift-Enter", run: insertLineBreak.bind()},
  {key: "Backspace", run: deleteUnit.bind("backward")},
  {key: "Delete", run: deleteUnit.bind("forward")},
  {key: "Ctrl-Backspace", mac: "Alt-Backspace", run: deleteWord.bind("backward")},
  {key: "Ctrl-Delete", mac: "Alt-Delete", run: deleteWord.bind("forward")},
  {mac: "Cmd-Backspace", run: deleteToLineEnd.bind("backward")},
  {mac: "Cmd-Delete", run: deleteToLineEnd.bind("forward")},
  {key: "ArrowLeft", run: moveByUnit.bind({dir: "left"}), shift: moveByUnit.bind({dir: "left", extend: true})},
  {key: "ArrowRight", run: moveByUnit.bind({dir: "right"}), shift: moveByUnit.bind({dir: "right", extend: true})},
  {key: "ArrowDown", run: moveByLine.bind({dir: "down"}), shift: moveByLine.bind({dir: "down", extend: true})},
  {key: "ArrowUp", run: moveByLine.bind({dir: "up"}), shift: moveByLine.bind({dir: "down", extend: true})},
  {key: "Mod-ArrowLeft", run: moveByWord.bind({dir: "left"}), shift: moveByWord.bind({dir: "left", extend: true})},
  {key: "Mod-ArrowRight", run: moveByWord.bind({dir: "right"}), shift: moveByWord.bind({dir: "right", extend: true})},
  {mac: "Cmd-ArrowLeft", run: moveToLineSide.bind({dir: "left"}), shift: moveToLineSide.bind({dir: "left", extend: true})},
  {mac: "Cmd-ArrowRight", run: moveToLineSide.bind({dir: "right"}), shift: moveToLineSide.bind({dir: "right", extend: true})},
  {mac: "Cmd-ArrowUp", run: moveToDocSide.bind({side: "start"}), shift: moveToDocSide.bind({side: "start", extend: true})},
  {mac: "Cmd-ArrowDown", run: moveToDocSide.bind({side: "end"}), shift: moveToDocSide.bind({side: "end", extend: true})},
  {mac: "Ctrl-ArrowUp", run: moveByPage.bind({dir: "up"}), shift: moveByPage.bind({dir: "up", extend: true})},
  {mac: "Ctrl-ArrowDown", run: moveByPage.bind({dir: "down"}), shift: moveByPage.bind({dir: "down", extend: true})},
  {key: "PageUp", run: moveByPage.bind({dir: "up"}), shift: moveByPage.bind({dir: "up", extend: true})},
  {key: "PageDown", run: moveByPage.bind({dir: "down"}), shift: moveByPage.bind({dir: "down", extend: true})},
  {key: "Home", run: moveToLineSide.bind({dir: "backward"}), shift: moveToLineSide.bind({dir: "backward", extend: true})},
  {key: "End", run: moveToLineSide.bind({dir: "forward"}), shift: moveToLineSide.bind({dir: "forward", extend: true})},
  {key: "Mod-Home", run: moveToDocSide.bind({side: "start"}), shift: moveToDocSide.bind({side: "start", extend: true})},
  {key: "Mod-End", run: moveToDocSide.bind({side: "end"}), shift: moveToDocSide.bind({side: "end", extend: true})},
  {key: "Mod-a", run: selectAll.bind()},
  {key: "Mod-z", run: undo.bind()},
  {key: "Mod-y", mac: "Mod-Shift-z", run: redo.bind()},
  {linux: "Ctrl-Shift-z", run: redo.bind()},
  // MacOS Emacs-ish bindings
  {mac: "Ctrl-b", run: moveByUnit.bind({dir: "backward"}), shift: moveByUnit.bind({dir: "backward", extend: true})},
  {mac: "Ctrl-f", run: moveByUnit.bind({dir: "forward"}), shift: moveByUnit.bind({dir: "forward", extend: true})},
  {mac: "Ctrl-p", run: moveByLine.bind({dir: "up"}), shift: moveByLine.bind({dir: "up", extend: true})},
  {mac: "Ctrl-n", run: moveByLine.bind({dir: "down"}), shift: moveByLine.bind({dir: "down", extend: true})},
  // FIXME go to start/end of textblock
  {mac: "Ctrl-a", run: moveToLineSide.bind({dir: "backward"}), shift: moveToLineSide.bind({dir: "backward", extend: true})},
  {mac: "Ctrl-e", run: moveToLineSide.bind({dir: "forward"}), shift: moveToLineSide.bind({dir: "forward", extend: true})},
  {mac: "Ctrl-d", run: deleteUnit.bind("forward")},
  {mac: "Ctrl-h", run: deleteUnit.bind("backward")},
  {mac: "Ctrl-k", run: deleteToLineEnd.bind("forward")},
  {mac: "Ctrl-Alt-h", run: deleteWord.bind("backward")},
  {mac: "Ctrl-o", run: insertLineBreak.bind()},
  {mac: "Ctrl-t", run: transposeChars.bind()},
  {mac: "Ctrl-v", run: moveByPage.bind({dir: "down"})},
] as KeyBinding.Spec[]).map(KeyBinding.define)
