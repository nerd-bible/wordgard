import {Facet} from "wordgard/state"
import {StyleModule, StyleSpec} from "style-mod"

export const theme = Facet.define<string, string>({combine: strs => strs.join(" ")})

export const darkTheme = Facet.define<boolean, boolean | null>({combine: values => values.length ? values[0] : null})

export const baseThemeID = StyleModule.newName(), baseLightID = StyleModule.newName(), baseDarkID = StyleModule.newName()

export const lightDarkIDs = {"&light": "." + baseLightID, "&dark": "." + baseDarkID}

export function buildTheme(main: string, spec: {[name: string]: StyleSpec}, scopes?: {[name: string]: string}) {
  return new StyleModule(spec, {
    finish(sel) {
      return /&/.test(sel) ? sel.replace(/&\w*/, m => {
        if (m == "&") return main
        if (!scopes || !scopes[m]) throw new RangeError(`Unsupported selector: ${m}`)
        return scopes[m]
      }) : main + " " + sel
    }
  })
}

export const baseTheme = buildTheme("." + baseThemeID, {
  "&": {
    "--wg-highlight-color": "#6af",
    position: "relative !important",
    boxSizing: "border-box",
    display: "flex !important",
    flexDirection: "column",
    border: "1px solid var(--wg-border-color)"
  },

  "&:has(wg-content:focus)": {
    outline: "1px solid var(--wg-highlight-color)",

    "& > wg-scroller > wg-cursor-layer": {
      animation: "steps(1) wg-blink 1.2s infinite"
    },

    "& > wg-scroller > wg-cursor-layer wg-cursor": {
      display: "block"
    }
  },

  "&light": {
    "--wg-panel-color": "#f3f3f5",
    "--wg-border-color": "#cacacb"
  },
  "&dark": {
    "--wg-panel-color": "#030303",
    "--wg-border-color": "#444"
  },

  "wg-scroller": {
    display: "block",
    height: "100%",
    overflowX: "auto",
    position: "relative",
    zIndex: 0,
  },

  "wg-content": {
    display: "block",
    margin: 0,
    whiteSpace: "pre-wrap",
    boxSizing: "border-box",
    minHeight: "100%",
    padding: "4px",
    outline: "none",
    caretColor: "transparent",
  },

  "wg-cursor-layer": {
    display: "block",
    position: "absolute",
    left: 0,
    top: 0,
    contain: "size style",
    "& > *": {
      position: "absolute"
    },
    pointerEvents: "none",
    zIndex: 150,
  },

  // Two animations defined so that we can switch between them to
  // restart the animation without forcing another style
  // recomputation.
  "@keyframes wg-blink": {"0%": {}, "50%": {opacity: 0}, "100%": {}},
  "@keyframes wg-blink2": {"0%": {}, "50%": {opacity: 0}, "100%": {}},

  "wg-cursor": {
    pointerEvents: "none",
    display: "none",
  },
  ".wg-cursor-v": {
    borderLeft: "1.8px solid currentColor",
    marginLeft: "-0.9px",
  },
  ".wg-cursor-h": {
    borderTop: "1.8px solid currentColor",
    marginTop: "-0.9px",
  },
  ".wg-selected-node": {
    outline: "2px solid #68f",
    "&::selection, & *::selection": {
      backgroundColor: "transparent"
    }
  },

  "wg-announced": {
    position: "fixed",
    top: "-10000px"
  },
  "@media print": {
    "wg-announced": { display: "none" }
  },

  "wg-panels": {
    display: "block",
    boxSizing: "border-box",
    position: "sticky",
    left: 0,
    right: 0,
    zIndex: 300,
    backgroundColor: "var(--wg-panel-color)"
  },

  "wg-dialog": {
    display: "block",
    padding: "2px 19px 4px 6px",
    position: "relative",
    "& label, & .wg-label": {
      fontSize: "80%"
    },
    borderBottom: "1px solid var(--wg-border-color)"
  },
  ".wg-dialog-close": {
    position: "absolute",
    top: "3px",
    right: "4px",
    backgroundColor: "inherit",
    border: "none",
    font: "inherit",
    fontSize: "14px",
    padding: "0"
  },
  ".wg-dialog-button": {
    color: "inherit",
    padding: ".1em .4em",
    border: "1px solid var(--wg-border-color)",
    borderRadius: "3px",
  },
  "&light .wg-dialog-button": {
    backgroundImage: "linear-gradient(#eff1f5, #d9d9df)",
    "&:active": {
      backgroundImage: "linear-gradient(#b4b4b4, #d0d3d6)"
    }
  },
  "&dark .wg-dialog-button": {
    backgroundImage: "linear-gradient(#393939, #111)",
    border: "1px solid #888",
    "&:active": {
      backgroundImage: "linear-gradient(#111, #333)"
    }
  },
}, lightDarkIDs)
