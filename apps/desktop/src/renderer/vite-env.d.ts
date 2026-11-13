declare module '*.svg?raw' {
  const content: string
  export default content
}

declare module '*.css'

declare module '*?worker&url' {
  const url: string
  export default url
}
