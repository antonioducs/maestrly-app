declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[]
  }
}

// Imported before Excalidraw. In the artifact frame the origin is opaque, and Excalidraw resolves a relative asset
// path against `location.origin` ("null"), so it gets the frame's own directory as an absolute URL.
window.EXCALIDRAW_ASSET_PATH = new URL('./', location.href).href

export {}
