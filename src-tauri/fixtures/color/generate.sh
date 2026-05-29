#!/usr/bin/env bash
# Regenerate the WS6 color fixtures from FFmpeg's testsrc source.
# See README.md for the full rationale, expected ffprobe tags, and the
# Dolby Vision generation limitation.
#
# Run from this directory:
#   bash generate.sh
#
# Preconditions: FFmpeg + ffprobe on PATH. Tested against FFmpeg 8.1 on
# macOS arm64 (the version this repo's developers run via Homebrew).

set -euo pipefail

cd "$(dirname "$0")"

# Common testsrc input shape — 320x240 30fps 1s. Small + deterministic.
TESTSRC='testsrc=size=320x240:rate=30:duration=2'

echo "regenerating sdr_bt709_iphone.mov..."
ffmpeg -hide_banner -loglevel error -f lavfi -i "$TESTSRC" \
    -vf "format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709" \
    -c:v libx264 -preset veryfast \
    -x264-params "colorprim=bt709:transfer=bt709:colormatrix=bt709" \
    -movflags +faststart -y sdr_bt709_iphone.mov

echo "regenerating hlg_bt2020_iphone.mov..."
ffmpeg -hide_banner -loglevel error -f lavfi -i "$TESTSRC" \
    -vf "format=yuv420p10le,setparams=range=tv:color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc" \
    -c:v libx265 -preset ultrafast \
    -x265-params "colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:log-level=error" \
    -tag:v hvc1 -movflags +faststart -y hlg_bt2020_iphone.mov

echo "regenerating pq_bt2020.mp4..."
ffmpeg -hide_banner -loglevel error -f lavfi -i "$TESTSRC" \
    -vf "format=yuv420p10le,setparams=range=tv:color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc" \
    -c:v libx265 -preset ultrafast \
    -x265-params "colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:log-level=error" \
    -tag:v hvc1 -movflags +faststart -y pq_bt2020.mp4

echo "regenerating no_color_metadata.mp4..."
ffmpeg -hide_banner -loglevel error -f lavfi -i "$TESTSRC" \
    -c:v libx264 -preset veryfast -pix_fmt yuv420p -y no_color_metadata.mp4

echo "regenerating dolby_vision.mov (placeholder — see README §Dolby Vision limitation)..."
# Without dovi_tool / x265-with-DV, we can't synthesise a real DOVI side-data
# block. Commit an HLG base layer with the .mov extension so the directory
# is complete; the integration test for the DV branch is gated #[ignore]
# until the toolchain is available.
cp hlg_bt2020_iphone.mov dolby_vision.mov

echo "done."
echo
echo "per-fixture color tags:"
for f in sdr_bt709_iphone.mov hlg_bt2020_iphone.mov pq_bt2020.mp4 dolby_vision.mov no_color_metadata.mp4; do
    echo "  $f:"
    ffprobe -v error -select_streams v:0 \
        -show_entries stream=pix_fmt,color_primaries,color_transfer,color_space,color_range \
        -of default=nw=1 "$f" | sed 's/^/    /'
done
