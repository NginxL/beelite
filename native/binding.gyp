{
  "targets": [
    {
      "target_name": "beelite_sparkle",
      "sources": ["src/beelite_sparkle.mm"],
      "defines": ["NAPI_VERSION=8"],
      "xcode_settings": {
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "CLANG_CXX_LIBRARY": "libc++",
        "MACOSX_DEPLOYMENT_TARGET": "13.0",
        "ARCHS": ["arm64"],
        "OTHER_CFLAGS": ["-F<(module_root_dir)/vendor"],
        "OTHER_LDFLAGS": [
          "-F<(module_root_dir)/vendor",
          "-framework", "Sparkle",
          "-framework", "Cocoa",
          "-Wl,-rpath,@loader_path"
        ]
      }
    }
  ]
}
