import AVFoundation
import ExpoModulesCore
import Speech

/// Dictation with Apple's SpeechTranscriber (iOS 26 and later): the on-device model that punctuates by itself, far
/// better than SFSpeechRecognizer at long dictation. The app keeps expo-speech-recognition for older systems and for
/// languages whose model is not on the phone yet (see src/dictation/session.ts).
public class MaestrlySpeechModule: Module {
  /// The `LiveTranscription` listening now. Touched only on the main actor.
  private var current: AnyObject?
  /// Languages whose model is downloading. Touched only on the main actor.
  private var downloading: Set<String> = []

  public func definition() -> ModuleDefinition {
    Name("MaestrlySpeech")

    Events("result", "error", "end")

    Function("isAvailable") { () -> Bool in
      guard #available(iOS 26.0, *) else { return false }
      return SpeechTranscriber.isAvailable
    }

    AsyncFunction("supportedLocales") { () async -> [String] in
      guard #available(iOS 26.0, *) else { return [] }
      return await SpeechTranscriber.supportedLocales.map { $0.identifier(.bcp47) }
    }

    AsyncFunction("prepare") { (tag: String) async -> Bool in
      guard #available(iOS 26.0, *) else { return false }
      return await self.prepareModel(Locale(identifier: tag))
    }

    AsyncFunction("start") { (tag: String) async throws -> Void in
      guard #available(iOS 26.0, *) else { throw TranscriptionFailure.unavailable }
      try await self.startTranscription(Locale(identifier: tag))
    }

    Function("stop") { () -> Void in
      guard #available(iOS 26.0, *) else { return }
      Task { @MainActor in (self.current as? LiveTranscription)?.stop() }
    }

    Function("abort") { () -> Void in
      guard #available(iOS 26.0, *) else { return }
      Task { @MainActor in (self.current as? LiveTranscription)?.abort() }
    }

    OnDestroy {
      guard #available(iOS 26.0, *) else { return }
      Task { @MainActor in (self.current as? LiveTranscription)?.abort() }
    }
  }

  /// Whether the language's model is on the phone. When it is not, iOS starts downloading it for a later dictation,
  /// so this one never waits for it.
  @available(iOS 26.0, *)
  @MainActor
  private func prepareModel(_ locale: Locale) async -> Bool {
    let modules: [any SpeechModule] = [LiveTranscription.transcriber(locale)]
    switch await AssetInventory.status(forModules: modules) {
    case .installed:
      // Reserved, iOS keeps the model for the app instead of removing it after a while unused.
      _ = try? await AssetInventory.reserve(locale: locale)
      return true
    case .unsupported:
      return false
    default:
      download(locale)
      return false
    }
  }

  @available(iOS 26.0, *)
  @MainActor
  private func download(_ locale: Locale) {
    let key = locale.identifier(.bcp47)
    guard !downloading.contains(key) else { return }
    downloading.insert(key)
    let modules: [any SpeechModule] = [LiveTranscription.transcriber(locale)]
    Task { @MainActor [weak self] in
      // A failed download is tried again by the next dictation in the language.
      if let request = try? await AssetInventory.assetInstallationRequest(supporting: modules) {
        try? await request.downloadAndInstall()
      }
      self?.downloading.remove(key)
    }
  }

  @available(iOS 26.0, *)
  @MainActor
  private func startTranscription(_ locale: Locale) async throws {
    (current as? LiveTranscription)?.abort()
    let transcription = LiveTranscription(locale: locale) { [weak self] name, body in
      self?.sendEvent(name, body)
    }
    current = transcription
    do {
      try await transcription.start()
    } catch {
      // Says nothing to JavaScript, which hears the rejection and listens with the other recognizer.
      transcription.discard()
      if current === transcription { current = nil }
      throw error
    }
  }
}

enum TranscriptionFailure: Error {
  case unavailable
  case microphoneBusy
  case modelMissing
  case converter
  case cancelled
}

/// One dictation: the microphone through `AVAudioEngine`, converted to the format the model takes, into a
/// `SpeechAnalyzer` whose transcriber reports a guess for the phrase being spoken and then fixes it.
@available(iOS 26.0, *)
@MainActor
final class LiveTranscription {
  nonisolated static func transcriber(_ locale: Locale) -> SpeechTranscriber {
    SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [])
  }

  private let locale: Locale
  private let emit: (String, [String: Any?]) -> Void
  private let engine = AVAudioEngine()
  private var analyzer: SpeechAnalyzer?
  private var input: AsyncStream<AnalyzerInput>.Continuation?
  private var observers: [NSObjectProtocol] = []
  private var sessionActive = false
  private var tapInstalled = false
  /// Stopped or aborted: no new audio goes in.
  private var ended = false
  /// The results ended, and JavaScript heard so unless the dictation never started.
  private var finished = false
  private var silent = false

  init(locale: Locale, emit: @escaping (String, [String: Any?]) -> Void) {
    self.locale = locale
    self.emit = emit
  }

  func start() async throws {
    let transcriber = Self.transcriber(locale)
    let analyzer = SpeechAnalyzer(
      modules: [transcriber],
      // Keeps the model loaded for a while, so the next dictation starts sooner.
      options: SpeechAnalyzer.Options(priority: .userInitiated, modelRetention: .lingering)
    )
    self.analyzer = analyzer

    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .allowBluetoothHFP])
    try session.setActive(true, options: .notifyOthersOnDeactivation)
    sessionActive = true

    let microphone = engine.inputNode.outputFormat(forBus: 0)
    // Another app holding the microphone leaves its format empty.
    guard microphone.sampleRate > 0, microphone.channelCount > 0 else { throw TranscriptionFailure.microphoneBusy }
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber], considering: microphone)
    else { throw TranscriptionFailure.modelMissing }
    let converter = try MicrophoneConverter(from: microphone, to: format)
    if ended { throw TranscriptionFailure.cancelled }

    let (stream, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
    input = continuation
    Task { @MainActor [weak self] in
      do {
        for try await result in transcriber.results {
          self?.emit("result", ["transcript": String(result.text.characters), "isFinal": result.isFinal])
        }
        self?.finish(nil)
      } catch {
        self?.finish(error)
      }
    }
    try await analyzer.start(inputSequence: stream)
    if ended { throw TranscriptionFailure.cancelled }

    engine.inputNode.installTap(onBus: 0, bufferSize: 4096, format: microphone, block: Self.tap(converter, continuation))
    tapInstalled = true
    engine.prepare()
    try engine.start()
    observe()
  }

  /// Ends listening; the transcriber fixes what it heard, then the results end.
  func stop() {
    guard !ended else { return }
    ended = true
    release()
    guard let analyzer else { return finish(nil) }
    Task {
      do {
        try await analyzer.finalizeAndFinishThroughEndOfInput()
      } catch {
        await analyzer.cancelAndFinishNow()
      }
    }
  }

  /// Ends listening and drops what was not fixed yet.
  func abort() {
    ended = true
    release()
    guard let analyzer else { return finish(nil) }
    Task { await analyzer.cancelAndFinishNow() }
  }

  /// Ends a dictation that failed to start, without telling JavaScript.
  func discard() {
    silent = true
    abort()
  }

  private func finish(_ error: Error?) {
    guard !finished else { return }
    finished = true
    ended = true
    release()
    if silent { return }
    if let error, !(error is CancellationError) {
      emit("error", ["error": Self.code(error), "message": error.localizedDescription])
    }
    emit("end", [:])
  }

  /// Turns the microphone off and closes the audio going in.
  private func release() {
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    observers = []
    if tapInstalled {
      tapInstalled = false
      engine.stop()
      engine.inputNode.removeTap(onBus: 0)
    }
    input?.finish()
    input = nil
    if sessionActive {
      sessionActive = false
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
  }

  /// A call, Siri or a new audio route ends listening and keeps what was heard, as stopping does.
  private func observe() {
    let center = NotificationCenter.default
    observers = [
      center.addObserver(
        forName: AVAudioSession.interruptionNotification,
        object: AVAudioSession.sharedInstance(),
        queue: .main
      ) { [weak self] notification in
        let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
        guard raw.flatMap(AVAudioSession.InterruptionType.init(rawValue:)) == .began else { return }
        Task { @MainActor in self?.stop() }
      },
      center.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
        Task { @MainActor in self?.stop() }
      },
    ]
  }

  /// Made outside the main actor: the engine calls it on its own audio thread.
  private nonisolated static func tap(
    _ converter: MicrophoneConverter,
    _ continuation: AsyncStream<AnalyzerInput>.Continuation
  ) -> AVAudioNodeTapBlock {
    return { buffer, _ in
      guard let converted = try? converter.convert(buffer) else { return }
      continuation.yield(AnalyzerInput(buffer: converted))
    }
  }

  /// The errors of `src/dictation/session.ts`.
  private static func code(_ error: Error) -> String {
    if let speech = error as? SFSpeechError, speech.code == .insufficientResources { return "busy" }
    return "unknown"
  }
}

/// Converts the microphone's audio (usually 48 kHz floats) to the model's format.
final class MicrophoneConverter {
  private let converter: AVAudioConverter?
  private let format: AVAudioFormat

  init(from source: AVAudioFormat, to format: AVAudioFormat) throws {
    self.format = format
    if source == format {
      converter = nil
      return
    }
    guard let converter = AVAudioConverter(from: source, to: format) else { throw TranscriptionFailure.converter }
    // Without priming, each converted buffer covers exactly the time of the one it came from.
    converter.primeMethod = .none
    self.converter = converter
  }

  func convert(_ buffer: AVAudioPCMBuffer) throws -> AVAudioPCMBuffer {
    guard let converter else { return buffer }
    let ratio = format.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up))
    guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
      throw TranscriptionFailure.converter
    }
    var error: NSError?
    let given = Flag()
    let status = converter.convert(to: output, error: &error) { _, inputStatus in
      if given.isSet {
        inputStatus.pointee = .noDataNow
        return nil
      }
      given.isSet = true
      inputStatus.pointee = .haveData
      return buffer
    }
    if status == .error { throw error ?? TranscriptionFailure.converter }
    return output
  }
}

/// Whether the converter already took the buffer, kept in a reference so its input block needs no captured `var`.
private final class Flag {
  var isSet = false
}
