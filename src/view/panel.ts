// FIXME figure out how to provide easy-to-use default styling for these

import {Facet, GardState} from "wordgard/state"
import {Wordgard} from "./editorview"
import {rmDOM} from "./dom"

type PanelConfig = {
  /// By default, panels will be placed inside the editor's DOM
  /// structure. You can use this option to override where panels with
  /// `top: true` are placed.
  topContainer?: HTMLElement
  /// Override where panels with `top: false` are placed.
  bottomContainer?: HTMLElement
}

const panelConfig = Facet.define<PanelConfig, PanelConfig>({
  combine(configs: readonly PanelConfig[]) {
    let topContainer, bottomContainer
    for (let c of configs) {
      topContainer ||= c.topContainer
      bottomContainer ||= c.bottomContainer
    }
    return {topContainer, bottomContainer}
  }
})

/// Configures the panel-managing extension.
export function panels(config?: PanelConfig): GardState.Extension {
  return config ? [panelConfig.of(config)] : []
}

/// Object that describes an active panel.
export interface Panel {
  /// The element representing this panel. The library will add the
  /// `"wg-panel"` DOM class to this.
  dom: HTMLElement,
  /// Controls whether the panel should be at the top or bottom of the
  /// editor. Defaults to false.
  top?: boolean
  /// Update the panel DOM for a given view update.
  update?(update: Wordgard.Update): void
  /// Called, when present, when the panel has been added the DOM.
  connect?(view: Wordgard): void
  /// Called when the editor with the panel is disconnected from the
  /// DOM.
  disconnect?(view: Wordgard): void
  /// Called when the panel is removed from the editor.
  destroy?(view: Wordgard): void
}

/// Get the active panel created by the given constructor, if any.
/// This can be useful when you need access to your panels' DOM
/// structure.
export function getPanel(view: Wordgard, panel: PanelConstructor) {
  let plugin = view.plugin(panelPlugin)
  let index = plugin ? plugin.specs.indexOf(panel) : -1
  return index > -1 ? plugin!.panels[index] : null
}

const panelPlugin = Wordgard.Plugin.fromClass(class {
  input: readonly (null | PanelConstructor)[]
  specs: readonly PanelConstructor[]
  panels: Panel[]
  top: PanelGroup
  bottom: PanelGroup

  constructor(view: Wordgard) {
    this.input = view.state.facet(showPanel)
    this.specs = this.input.filter(s => s) as PanelConstructor[]
    this.panels = this.specs.map(spec => spec(view))
    for (let p of this.panels) p.dom.classList.add("wg-panel")
    let conf = view.state.facet(panelConfig)
    this.top = new PanelGroup(view, true, conf.topContainer)
    this.bottom = new PanelGroup(view, false, conf.bottomContainer)
    this.top.sync(this.panels.filter(p => p.top), view)
    this.bottom.sync(this.panels.filter(p => !p.top), view)
  }

  update(update: Wordgard.Update) {
    let conf = update.state.facet(panelConfig)
    if (this.top.container != conf.topContainer) {
      this.top.sync([], update.view)
      this.top = new PanelGroup(update.view, true, conf.topContainer)
    }
    if (this.bottom.container != conf.bottomContainer) {
      this.bottom.sync([], update.view)
      this.bottom = new PanelGroup(update.view, false, conf.bottomContainer)
    }
    this.top.syncClasses()
    this.bottom.syncClasses()
    let input = update.state.facet(showPanel)
    if (input != this.input) {
      let specs = input.filter(x => x) as PanelConstructor[]
      let panels = [], top: Panel[] = [], bottom: Panel[] = [], mount = []
      for (let spec of specs) {
        let known = this.specs.indexOf(spec), panel
        if (known < 0) {
          panel = spec(update.view)
          mount.push(panel)
        } else {
          panel = this.panels[known]
          if (panel.update) panel.update(update)
        }
        panels.push(panel)
        ;(panel.top ? top : bottom).push(panel)
      }
      this.specs = specs
      this.panels = panels
      this.top.sync(top, update.view)
      this.bottom.sync(bottom, update.view)
      for (let p of mount) {
        p.dom.classList.add("wg-panel")
        if (p.connect && update.view.connected) p.connect(update.view)
      }
    } else {
      for (let p of this.panels) if (p.update) p.update(update)
    }
  }

  connect(view: Wordgard) {
    for (let p of this.panels) p.connect?.(view)
  }

  disconnect(view: Wordgard) {
    for (let p of this.panels) p.disconnect?.(view)
  }

  destroy(view: Wordgard) {
    this.top.sync([], view)
    this.bottom.sync([], view)
  }
}, {
  provide: plugin => Wordgard.scrollMargins.of(view => {
    let value = view.plugin(plugin)
    return value && {top: value.top.scrollMargin(), bottom: value.bottom.scrollMargin()}
  })
})

class PanelGroup {
  dom: HTMLElement | undefined = undefined
  classes = ""
  panels: Panel[] = []

  constructor(readonly view: Wordgard, readonly top: boolean, readonly container: HTMLElement | undefined) {
    this.syncClasses()
  }

  sync(panels: Panel[], view: Wordgard) {
    for (let p of this.panels) if (!panels.includes(p)) {
      if (view.connected) p.disconnect?.(view)
      p.destroy?.(view)
    }
    this.panels = panels
    this.syncDOM()
  }

  syncDOM() {
    if (this.panels.length == 0) {
      if (this.dom) {
        this.dom.remove()
        this.dom = undefined
      }
      return
    }

    if (!this.dom) {
      this.dom = document.createElement("wg-panels")
      this.dom.className = this.top ? "wg-panels-top" : "wg-panels-bottom"
      this.dom.style[this.top ? "top" : "bottom"] = "0"
      let parent = this.container || this.view.dom
      parent.insertBefore(this.dom, this.top ? parent.firstChild : null)
    }

    let curDOM = this.dom.firstChild
    for (let panel of this.panels) {
      if (panel.dom.parentNode == this.dom) {
        while (curDOM != panel.dom) curDOM = rmDOM(curDOM!)
        curDOM = curDOM!.nextSibling
      } else {
        this.dom.insertBefore(panel.dom, curDOM)
      }
    }
    while (curDOM) curDOM = rmDOM(curDOM)
  }

  scrollMargin() {
    return !this.dom || this.container ? 0
      : Math.max(0, this.top ?
        this.dom.getBoundingClientRect().bottom - Math.max(0, this.view.scrollDOM.getBoundingClientRect().top) :
        Math.min(innerHeight, this.view.scrollDOM.getBoundingClientRect().bottom) - this.dom.getBoundingClientRect().top)
  }

  syncClasses() {
    if (!this.container || this.classes == this.view.themeClasses) return
    for (let cls of this.classes.split(" ")) if (cls) this.container.classList.remove(cls)
    for (let cls of (this.classes = this.view.themeClasses).split(" ")) if (cls) this.container.classList.add(cls)
  }
}

/// A function that initializes a panel. Used in
/// [`showPanel`](#view.showPanel).
export type PanelConstructor = (view: Wordgard) => Panel

/// Opening a panel is done by providing a constructor function for
/// the panel through this facet. (The panel is closed again when its
/// constructor is no longer provided.) Values of `null` are ignored.
export const showPanel = Facet.define<PanelConstructor | null>({
  enables: panelPlugin
})
