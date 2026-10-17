Pod::Spec.new do |s|
  s.name           = 'MaestrlySpeech'
  s.version        = '0.1.0'
  s.summary        = "Dictation with Apple's SpeechTranscriber"
  s.description    = "Turns dictation into text with Apple's on-device SpeechTranscriber on iOS 26 and later."
  s.license        = 'MIT'
  s.author         = 'Maestrly contributors'
  s.homepage       = 'https://github.com/antonioducs/maestrly-app'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation', 'Speech'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,swift}"
end
