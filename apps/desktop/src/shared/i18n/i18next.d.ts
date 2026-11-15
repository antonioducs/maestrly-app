import 'i18next'

declare module 'i18next' {
  interface CustomTypeOptions {
    // i18next 27 types every t() as requiring the variables of its string. The app passes t to helpers typed as
    // (key: string, vars?) => string, and its keys are untyped strings, so the check has nothing to check against.
    strictInterpolationChecks: false
  }
}
