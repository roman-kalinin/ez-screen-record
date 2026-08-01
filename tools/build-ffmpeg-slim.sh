#!/usr/bin/env bash
#
# Build a minimal LGPL ffmpeg.exe for Ez Screen Record.
#
# The stock BtbN "full" build is 138.5 MB and carries AV1 encoders, x265,
# dav1d, DVD/Bluray, ZeroMQ, VMAF, SDL2, OpenAL and dozens of other libraries
# this app never calls. It is also the single largest thing in the installer by
# an order of magnitude -- see the size table in winui/PLAN.md.
#
# This builds ONLY what src/main/native-recorder.ts actually invokes:
#
#   ddagrab       Desktop Duplication screen capture  (the entire capture path)
#   libplacebo    Vulkan compositing of camera/image overlays
#   h264_nvenc    hardware encode
#   dshow         camera + microphone input
#   aac           audio encode
#   mp4/h264      muxing and the copy path
#
# LICENSING: this build is GPL, and that is a deliberate reversal.
#
# The original plan was LGPL (no --enable-gpl, no x264), which would have
# cleared the GPL encumbrance resources/ffmpeg/README.md flags as blocking an
# MIT release. Dropping x264 turned out to cost too much: it is the ONLY
# software encoder, so a machine without NVENC or AMF -- any Intel-graphics
# laptop -- would have no encoder at all and could not record.
#
# Intel QSV would have covered that gap, but --enable-libmfx needs an external
# SDK that is not part of this toolchain, so it is not an option here.
#
# The choice is therefore: LGPL and the app cannot record on Intel machines, or
# GPL and it records everywhere. Recording everywhere wins. To revisit, drop
# --enable-gpl / --enable-libx264 / --enable-encoder=libx264 and the x264 build
# step below, and accept the hardware-encoder requirement.
#
# Run from WSL / any Linux with mingw-w64. Cross-compiles to win64.
#
#   sudo apt-get install build-essential mingw-w64 binutils-mingw-w64 nasm \
#       yasm pkg-config git cmake ninja-build meson curl
#   bash tools/build-ffmpeg-slim.sh
#
# binutils-mingw-w64 is easy to miss: without it libplacebo's configure fails
# with "Program 'llvm-dlltool dlltool' not found" after several minutes of
# otherwise-successful work.
#
# Output: $OUT/ffmpeg.exe

set -euo pipefail

ROOT="${BUILD_ROOT:-$HOME/ffbuild}"
PREFIX="$ROOT/prefix"
OUT="${OUT_DIR:-$ROOT/out}"
JOBS="$(nproc)"
TARGET=x86_64-w64-mingw32

mkdir -p "$ROOT" "$PREFIX" "$OUT"
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"

echo "==> build root: $ROOT   jobs: $JOBS"

# --- meson cross file -------------------------------------------------------
cat > "$ROOT/mingw.cross" <<EOF
[binaries]
c = '$TARGET-gcc'
cpp = '$TARGET-g++'
ar = '$TARGET-ar'
strip = '$TARGET-strip'
pkg-config = 'pkg-config'
windres = '$TARGET-windres'
# libplacebo's meson looks for a bare 'dlltool'; the mingw package installs it
# only under the target-prefixed name, so point at it explicitly. Without this
# the configure step fails with "Program 'llvm-dlltool dlltool' not found".
dlltool = '$TARGET-dlltool'

[host_machine]
system = 'windows'
cpu_family = 'x86_64'
cpu = 'x86_64'
endian = 'little'

[properties]
needs_exe_wrapper = true
EOF

# --- 1. Vulkan headers (libplacebo's only hard external need) ---------------
if [ ! -d "$PREFIX/include/vulkan" ]; then
  echo "==> Vulkan-Headers"
  rm -rf "$ROOT/Vulkan-Headers"
  git clone --depth 1 -b v1.3.296 https://github.com/KhronosGroup/Vulkan-Headers "$ROOT/Vulkan-Headers"
  cmake -S "$ROOT/Vulkan-Headers" -B "$ROOT/Vulkan-Headers/build" -G Ninja \
    -DCMAKE_INSTALL_PREFIX="$PREFIX" >/dev/null
  cmake --install "$ROOT/Vulkan-Headers/build" >/dev/null
fi

# --- 2. shaderc (GLSL -> SPIR-V; libplacebo compiles its shaders at runtime) -
# glslang and SPIRV-Tools come in via shaderc's own sync script, which pins
# versions known to work together. Hand-picking them separately is the usual
# way this build breaks.
if [ ! -f "$PREFIX/lib/libshaderc_combined.a" ]; then
  echo "==> shaderc (+ glslang, SPIRV-Tools)"
  rm -rf "$ROOT/shaderc"
  git clone --depth 1 -b v2024.3 https://github.com/google/shaderc "$ROOT/shaderc"
  ( cd "$ROOT/shaderc" && ./utils/git-sync-deps )
  cmake -S "$ROOT/shaderc" -B "$ROOT/shaderc/build" -G Ninja \
    -DCMAKE_SYSTEM_NAME=Windows \
    -DCMAKE_C_COMPILER="$TARGET-gcc" \
    -DCMAKE_CXX_COMPILER="$TARGET-g++" \
    -DCMAKE_RC_COMPILER="$TARGET-windres" \
    -DCMAKE_FIND_ROOT_PATH="/usr/$TARGET;$PREFIX" \
    -DCMAKE_FIND_ROOT_PATH_MODE_PROGRAM=NEVER \
    -DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=ONLY \
    -DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=ONLY \
    -DCMAKE_INSTALL_PREFIX="$PREFIX" \
    -DCMAKE_BUILD_TYPE=Release \
    -DSHADERC_SKIP_TESTS=ON -DSHADERC_SKIP_EXAMPLES=ON \
    -DSHADERC_SKIP_COPYRIGHT_CHECK=ON \
    -DBUILD_SHARED_LIBS=OFF >/dev/null
  cmake --build "$ROOT/shaderc/build" -j"$JOBS" >/dev/null
  cmake --install "$ROOT/shaderc/build" >/dev/null
fi

# --- 3. libplacebo ----------------------------------------------------------
# The GPU compositor. Vulkan only -- no OpenGL/D3D11 backend needed, since
# ffmpeg hands it Vulkan frames via hwupload.
if [ ! -f "$PREFIX/lib/pkgconfig/libplacebo.pc" ]; then
  echo "==> libplacebo"
  rm -rf "$ROOT/libplacebo"
  # Must be new enough for the ffmpeg tag below. v7.349 against ffmpeg n8.0
  # fails to compile vf_libplacebo.c: its libav_internal.h still calls
  # av_stream_get_side_data(), which n8.0 removed.
  git clone --depth 1 -b v7.351.0 --recursive https://code.videolan.org/videolan/libplacebo.git "$ROOT/libplacebo"
  meson setup "$ROOT/libplacebo/build" "$ROOT/libplacebo" \
    --cross-file "$ROOT/mingw.cross" \
    --prefix="$PREFIX" \
    --buildtype=release \
    --default-library=static \
    -Dvulkan=enabled -Dshaderc=enabled \
    -Dopengl=disabled -Dd3d11=disabled -Ddemos=false -Dtests=false >/dev/null
  meson compile -C "$ROOT/libplacebo/build" -j"$JOBS" >/dev/null
  meson install -C "$ROOT/libplacebo/build" >/dev/null

fi

# shaderc.pc advertises -lshaderc_shared, but shaderc was built static above and
# only ships libshaderc_combined.a. libplacebo.pc pulls it in via
# `Requires: shaderc`, so the bad flag reaches ffmpeg's configure, whose link
# test then fails and reports the thoroughly misleading
# "libplacebo >= 4.192.0 not found using pkg-config" -- as though libplacebo
# were missing, when the real problem is one unresolvable dependency of it.
#
# Patch shaderc.pc (NOT libplacebo.pc, which never names the library directly).
sed -i 's/-lshaderc_shared/-lshaderc_combined -lstdc++/g' \
  "$PREFIX/lib/pkgconfig/shaderc.pc"

# --- 4. nv-codec-headers (NVENC; MIT, no NVIDIA binary redistributed) -------
if [ ! -f "$PREFIX/lib/pkgconfig/ffnvcodec.pc" ]; then
  echo "==> nv-codec-headers"
  rm -rf "$ROOT/nv-codec-headers"
  git clone --depth 1 -b n12.2.72.0 https://github.com/FFmpeg/nv-codec-headers "$ROOT/nv-codec-headers"
  make -C "$ROOT/nv-codec-headers" PREFIX="$PREFIX" install >/dev/null
fi

# --- 5. AMF headers (AMD hardware encode) -----------------------------------
# Header-only, like nv-codec-headers: no AMD binary is redistributed, the
# runtime DLL comes from the driver. Without these, --enable-amf fails with
# "amf requested but not found".
if [ ! -d "$PREFIX/include/AMF" ]; then
  echo "==> AMF headers"
  rm -rf "$ROOT/amf"
  # Must keep step with the ffmpeg ref below: ffmpeg enforces a MINIMUM AMF
  # version, so an older header set fails configure with the unhelpful
  # "amf requested but not found" -- which reads as though AMF were not
  # requested properly rather than merely being too old.
  git clone --depth 1 -b v1.5.2 https://github.com/GPUOpen-LibrariesAndSDKs/AMF "$ROOT/amf"
  mkdir -p "$PREFIX/include/AMF"
  cp -r "$ROOT/amf/amf/public/include/"* "$PREFIX/include/AMF/"
fi

# --- 6. x264 (software encode fallback; see the licensing note at the top) ---
if [ ! -f "$PREFIX/lib/pkgconfig/x264.pc" ]; then
  echo "==> x264"
  rm -rf "$ROOT/x264"
  git clone --depth 1 -b stable https://code.videolan.org/videolan/x264.git "$ROOT/x264"
  ( cd "$ROOT/x264" && ./configure \
      --prefix="$PREFIX" \
      --host="$TARGET" \
      --cross-prefix="$TARGET-" \
      --enable-static \
      --disable-cli \
      --disable-opencl \
      --bit-depth=8 >/dev/null \
    && make -j"$JOBS" >/dev/null && make install >/dev/null )
fi

# --- 7. ffmpeg --------------------------------------------------------------
echo "==> ffmpeg"
# master, not a release tag.
#
# The recorder's compositing graph uses vf_libplacebo's `fit_mode` option, which
# is an FFMPEG-side option (not a libplacebo one) and has not made it into a
# release yet -- it is absent from both n7.1 and n8.0. Without it, camera and
# image overlays die at start with "Error applying option 'fit_mode' to filter
# 'libplacebo': Option not found" while screen-only takes work fine, so the gap
# is easy to miss.
#
# The stock BtbN build the app previously shipped was also a master build, so
# this matches what the graph was written and measured against. Tracking master
# does mean an upstream change can break the build; FFMPEG_REF pins it if that
# happens.
FFMPEG_REF="${FFMPEG_REF:-master}"
if [ ! -d "$ROOT/ffmpeg" ]; then
  git clone --depth 1 -b "$FFMPEG_REF" https://github.com/FFmpeg/FFmpeg "$ROOT/ffmpeg"
fi
cd "$ROOT/ffmpeg"
make distclean >/dev/null 2>&1 || true

# --disable-everything then re-enable exactly what the recorder uses. This is
# where the 138 MB -> ~20 MB comes from; the enable list below IS the app's
# real dependency surface, so anything added to the ffmpeg command line in
# native-recorder.ts must be added here too or it will fail at record time.
#
# NOTE the lavfi entries. ddagrab is a FILTER, but the recorder reaches it as
# `-f lavfi -i ddagrab=...`, so the lavfi input device and demuxer are needed
# too. Enabling the filter alone builds and lists ddagrab happily, then fails at
# record time with "Error opening input file ddagrab=..." -- which reads like a
# broken filter rather than a missing device.
#
# NOTE ALSO wrapped_avframe. A lavfi input arrives as a `wrapped_avframe`
# stream (visible in ffmpeg's own stream report as
# "Video: wrapped_avframe, d3d11"), so its decoder is needed to unwrap the
# frames before any filter or encoder can touch them. Without it ddagrab opens
# fine, reports the right resolution, and then fails with "Error opening output
# files: Invalid argument" -- an output-side message for what is really a
# missing input codec. That misdirection cost real time; do not remove it.
./configure \
  --prefix="$PREFIX" \
  --pkg-config=pkg-config \
  --pkg-config-flags=--static \
  --cross-prefix="$TARGET-" \
  --arch=x86_64 \
  --target-os=mingw32 \
  --enable-cross-compile \
  --disable-debug \
  --disable-doc \
  --disable-shared \
  --enable-static \
  --disable-everything \
  --disable-network \
  --disable-autodetect \
  --enable-w32threads \
  \
  --enable-ffmpeg \
  --disable-ffplay \
  --disable-ffprobe \
  \
  --enable-d3d11va \
  --enable-dxva2 \
  --enable-vulkan \
  --enable-libplacebo \
  --enable-ffnvcodec \
  --enable-nvenc \
  --enable-amf \
  \
  --enable-indev=dshow \
  --enable-indev=gdigrab \
  --enable-indev=lavfi \
  --enable-demuxer=lavfi \
  --enable-filter=ddagrab \
  --enable-filter=libplacebo \
  --enable-filter=hwupload \
  --enable-filter=hwdownload \
  --enable-filter=hwmap \
  --enable-filter=format \
  --enable-filter=scale \
  --enable-filter=hflip \
  --enable-filter=vflip \
  --enable-filter=fps \
  --enable-filter=null \
  --enable-filter=anull \
  --enable-filter=aresample \
  --enable-filter=amix \
  --enable-filter=volume \
  --enable-filter=aformat \
  --enable-filter=mpdecimate \
  \
  --enable-encoder=h264_nvenc \
  --enable-encoder=hevc_nvenc \
  --enable-encoder=h264_amf \
  --enable-encoder=hevc_amf \
  --enable-encoder=libx264 \
  --enable-libx264 \
  --enable-gpl \
  --enable-encoder=aac \
  --enable-encoder=pcm_s16le \
  --enable-encoder=mjpeg \
  --enable-encoder=png \
  \
  --enable-decoder=h264 \
  --enable-decoder=hevc \
  --enable-decoder=aac \
  --enable-decoder=pcm_s16le \
  --enable-decoder=mjpeg \
  --enable-decoder=png \
  --enable-decoder=bmp \
  --enable-decoder=gif \
  --enable-decoder=webp \
  --enable-decoder=rawvideo \
  --enable-decoder=wrapped_avframe \
  \
  --enable-demuxer=mov \
  --enable-demuxer=matroska \
  --enable-demuxer=h264 \
  --enable-demuxer=aac \
  --enable-demuxer=wav \
  --enable-demuxer=image2 \
  --enable-demuxer=png_pipe \
  --enable-demuxer=jpeg_pipe \
  --enable-demuxer=webp_pipe \
  --enable-demuxer=rawvideo \
  \
  --enable-muxer=mp4 \
  --enable-muxer=mov \
  --enable-muxer=matroska \
  --enable-muxer=h264 \
  --enable-muxer=wav \
  --enable-muxer=image2 \
  --enable-muxer=rawvideo \
  \
  --enable-parser=h264 \
  --enable-parser=hevc \
  --enable-parser=aac \
  --enable-parser=png \
  --enable-parser=mjpeg \
  \
  --enable-protocol=file \
  --enable-protocol=pipe \
  \
  --enable-bsf=h264_mp4toannexb \
  --enable-bsf=hevc_mp4toannexb \
  --enable-bsf=extract_extradata \
  \
  --enable-encoder=rawvideo \
  --enable-encoder=wrapped_avframe \
  \
  --extra-cflags="-I$PREFIX/include -O2" \
  --extra-ldflags="-L$PREFIX/lib -static -static-libgcc -static-libstdc++" \
  --extra-libs="-lstdc++ -lshaderc_combined -lole32 -loleaut32 -lstrmiids -luuid -lgdi32 -ld3d11 -ldxgi"

make -j"$JOBS"
"$TARGET-strip" ffmpeg.exe
cp ffmpeg.exe "$OUT/ffmpeg.exe"

echo
echo "==> built: $OUT/ffmpeg.exe"
ls -lh "$OUT/ffmpeg.exe" | awk '{print "    size: " $5}'
