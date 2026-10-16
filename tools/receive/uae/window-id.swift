// Prints the CGWindowID of the first on-screen window owned by the named app (default FS-UAE).
import CoreGraphics
let owner = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "FS-UAE"
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
if let w = list.first(where: { ($0[kCGWindowOwnerName as String] as? String)?.hasPrefix(owner) == true }) {
  print(w[kCGWindowNumber as String] as! Int)
} else { exit(1) }
