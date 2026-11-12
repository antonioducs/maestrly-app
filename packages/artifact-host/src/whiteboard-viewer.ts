/** The canvas the host serves for every whiteboard, in place of the files of a version. */
export interface WhiteboardViewer {
  file(path: string): Promise<{ bytes: Uint8Array; contentType: string } | null>
}
