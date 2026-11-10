// DeviceDock wrapper for pinned HPatchLite v0.4.3; MIT licensed.
#include <cstdlib>
#include <cstring>
#include <vector>
#include "HDiffPatch/libHDiffPatch/HDiff/diff_for_hpatch_lite.h"
#include "HDiffPatch/compress_plugin_demo.h"
extern "C" int hdiffi_create_patch(const unsigned char* oldData, int oldSize,
                                  const unsigned char* newData, int newSize, unsigned char** output) {
 *output = nullptr;
 if (!oldData || !newData || oldSize <= 0 || newSize <= 0 || oldSize > 4000000 || newSize > 4000000) return -1;
 try {
  TCompressPlugin_tuz plugin = tuzCompressPlugin;
  plugin.props.dictSize = 1024;
  plugin.props.isNeedLiteralLine = true;
  hdiffi_TCompress compressor = { &plugin.base, hpi_compressType_tuz };
  std::vector<hpi_byte> patch;
  create_lite_diff(newData, newData + newSize, oldData, oldData + oldSize, patch, &compressor);
  if (patch.empty() || patch.size() > 8000000) return -2;
  *output = static_cast<unsigned char*>(malloc(patch.size()));
  if (!*output) return -3;
  memcpy(*output, patch.data(), patch.size());
  return static_cast<int>(patch.size());
 } catch (...) { return -4; }
}
