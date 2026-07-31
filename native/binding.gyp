{
  "targets": [
    {
      "target_name": "ezcapture",
      "sources": [
        "src/addon.cpp",
        "src/capture.cpp",
        "src/encoder.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "include"
      ],
      "libraries": [
        "-ld3d11.lib",
        "-ldxgi.lib",
        "-ldxguid.lib",
        "-lwindowsapp.lib",
        "-lruntimeobject.lib"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "WINRT_LEAN_AND_MEAN",
        "NOMINMAX",
        "WIN32_LEAN_AND_MEAN"
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          # /bigobj is mandatory: the C++/WinRT headers overflow the COFF
          # section limit and fail with C1128 without it. /EHsc likewise —
          # winrt::check_hresult throws.
          "AdditionalOptions": [
            "/std:c++20",
            "/EHsc",
            "/bigobj",
            "/permissive-",
            "/Zc:__cplusplus",
            "/utf-8"
          ],
          "ExceptionHandling": 1
        }
      },
      # Node-API only (no node.h/v8.h/NAN), so the .node is ABI-stable across
      # Electron and Node versions and needs no electron-rebuild.
      "msvs_configuration_attributes": {
        "CharacterSet": "1"
      }
    }
  ]
}
