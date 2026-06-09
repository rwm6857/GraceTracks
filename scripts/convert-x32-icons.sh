#!/usr/bin/env bash
#
# Vectorise the Behringer X32 scribble-strip BMPs into themeable SVGs.
#
# Source bitmaps:  /X32-icons/*.bmp   (64×64, white line-art on black bg)
# Output:          src/assets/channels/*.svg   (currentColor, viewBox 0 0 64 64)
#
# Requires: potrace (apt-get install potrace).
#
# The BMPs are white-on-black, so potrace runs with -i (invert) to trace the
# white line-art. Output fill is rewritten from #000000 to currentColor so the
# icons inherit the app's theme color. Run from the repo root:
#
#   ./scripts/convert-x32-icons.sh
#
set -euo pipefail

SRC_DIR="X32-icons"
OUT_DIR="src/assets/channels"
mkdir -p "$OUT_DIR"

# X32 source name -> GraceTracks stem name
declare -A MAP=(
  [drums]=drums [percussion]=perc [bass]=bass [elec]=elec
  [keys]=keys [synth]=synth [vocals]=vox [strings]=strings
)

for src in "${!MAP[@]}"; do
  dest="${MAP[$src]}"
  tmp="$(mktemp --suffix=.svg)"
  potrace -i -s -t 2 -a 1 -O 0.3 "$SRC_DIR/$src.bmp" -o "$tmp"
  # Keep only the <g>…</g> drawing, rewrite to currentColor, wrap in a clean <svg>.
  g="$(sed -n '/<g /,/<\/g>/p' "$tmp" | sed 's/fill="#000000"/fill="currentColor"/')"
  {
    printf '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="currentColor" aria-hidden="true">\n'
    printf '%s\n' "$g"
    printf '</svg>\n'
  } > "$OUT_DIR/$dest.svg"
  rm -f "$tmp"
  echo "  $src.bmp -> $OUT_DIR/$dest.svg"
done

echo "Done."
