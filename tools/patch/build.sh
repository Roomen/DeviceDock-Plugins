#!/bin/sh
# Supply an already checked-out recursive v0.4.3 tree. No download or execution of prebuilt binaries.
set -eu
source_dir=${1:?usage: build.sh /path/to/HPatchLite-v0.4.3}
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
[ "$(git -C "$source_dir" rev-parse HEAD)" = 86ad1420403a216e2a4c4c2ca6385b2b8e6f0edb ]
[ "$(git -C "$source_dir/HDiffPatch" rev-parse HEAD)" = a970d3655fe86cae03ea1d05e9258132e31d54f7 ]
[ "$(git -C "$source_dir/tinyuz" rev-parse HEAD)" = 46284e506104ae186eec323eff08e281816a1ab0 ]
emcc --version | head -1 | grep '6.0.13'
# Keep toolchain caches outside the installed SDK.
mkdir -p "${EM_CACHE:-/tmp/devicedock-em-cache}"
export EM_CACHE=$(CDPATH= cd -- "${EM_CACHE:-/tmp/devicedock-em-cache}" && pwd -P)
make -C "$source_dir" clean
CFLAGS="-ffile-prefix-map=$source_dir=/upstream/HPatchLite" CXXFLAGS="-fexceptions -ffile-prefix-map=$source_dir=/upstream/HPatchLite" emmake make -C "$source_dir" -j4 MT=0 ZLIB=0 LZMA=0 libhpatchlite.a
em++ "$repo_dir/tools/patch/wrapper.cpp" "$source_dir/libhpatchlite.a" -I"$source_dir" \
 -I"$source_dir/tinyuz/compress" -I"$source_dir/tinyuz/decompress" -I"$source_dir/HDiffPatch/libHDiffPatch/HPatchLite" \
 -D_CompressPlugin_tuz -D_IS_NEED_DEFAULT_CompressPlugin=0 -D_IS_USED_SHARE_hpatch_lite_types=1 -D_IS_USED_MULTITHREAD=0 \
 "-ffile-prefix-map=$source_dir=/upstream/HPatchLite" "-ffile-prefix-map=$repo_dir=/src/DeviceDock-Plugins" \
 -O3 -fexceptions --no-entry -sMODULARIZE=1 -sEXPORT_NAME=createHpatchLiteModule -sENVIRONMENT=worker \
 -sFILESYSTEM=0 -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=268435456 \
 '-sEXPORTED_FUNCTIONS=["_hdiffi_create_patch","_malloc","_free"]' \
 '-sEXPORTED_RUNTIME_METHODS=["getValue","setValue"]' -o "$repo_dir/plugins/patch/hdiffi.js"
cat "$repo_dir/plugins/patch/hdiffi.js" "$repo_dir/tools/patch/worker-runtime.js" > "$repo_dir/plugins/patch/worker.js"
# Standalone glue is a build intermediate; runtime uses only the self-contained worker.
rm "$repo_dir/plugins/patch/hdiffi.js"
