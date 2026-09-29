import AVFoundation
import CoreMedia
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let asset = AVURLAsset(url: url)
let sem = DispatchSemaphore(value: 0)
Task {
  do {
    let playable = try await asset.load(.isPlayable)
    let dur = try await asset.load(.duration)
    let tracks = try await asset.load(.tracks)
    print("playable=\(playable) duration=\(String(format: "%.1f", CMTimeGetSeconds(dur)))s tracks=\(tracks.count)")
    for t in tracks {
      let fds = try await t.load(.formatDescriptions)
      let sub = fds.map { fd -> String in
        let c = CMFormatDescriptionGetMediaSubType(fd)
        return String(bytes: [UInt8((c >> 24) & 255), UInt8((c >> 16) & 255), UInt8((c >> 8) & 255), UInt8(c & 255)], encoding: .ascii) ?? "?"
      }.joined(separator: ",")
      let size = try await t.load(.naturalSize)
      print("  \(t.mediaType.rawValue) codec=\(sub) size=\(Int(size.width))x\(Int(size.height))")
    }
    let gen = AVAssetImageGenerator(asset: asset)
    let (img, _) = try await gen.image(at: CMTime(seconds: min(3, CMTimeGetSeconds(dur) / 2), preferredTimescale: 600))
    print("decoded frame: \(img.width)x\(img.height)")
  } catch { print("ERROR: \(error)") }
  sem.signal()
}
sem.wait()
