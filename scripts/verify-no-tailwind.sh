#!/usr/bin/env bash
# verify-no-tailwind.sh — Detect Tailwind utility classes in page files.
#
# Usage:
#   bash scripts/verify-no-tailwind.sh frontend/src/pages/Signals.tsx
#   bash scripts/verify-no-tailwind.sh frontend/src/pages/   # glob
#
# Exit: 0 = clean (no Tailwind found), 1 = violations found
#
# Tailwind pattern: flex, grid, p-{n}, m-{n}, w-{n}, h-{n}, bg-{color},
#   text-{size/color}, font-{weight}, rounded-{size}, shadow-{size}, etc.
#   These are the telltale signs of Tailwind substitution.
#
# Note: compound CSS class names like "hw-grid", "eval-grid" are NOT
# Tailwind — they are prototype class names. The \bgrid\b pattern is
# replaced with a more precise match that excludes hyphenated compounds.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

TAILWIND_PATTERNS=(
  '\bflex\b'
  '(^|[^-a-zA-Z0-9_])grid([^-a-zA-Z0-9_]|$)'
  '\bw-[0-9]' '\bw-full\b' '\bw-auto\b' '\bw-screen\b' '\bw-1/'
  '\bh-[0-9]' '\bh-full\b' '\bh-auto\b' '\bh-screen\b'
  '\bp-[0-9]' '\bpx-[0-9]' '\bpy-[0-9]' '\bpt-[0-9]' '\bpb-[0-9]' '\bpl-[0-9]' '\bpr-[0-9]'
  '\bm-[0-9]' '\bmx-[0-9]' '\bmy-[0-9]' '\bmt-[0-9]' '\bmb-[0-9]' '\bml-[0-9]' '\bmr-[0-9]'
  '\bgap-[0-9]' '\bgap-x-[0-9]' '\bgap-y-[0-9]'
  '\bbg-(red|blue|green|yellow|purple|pink|indigo|gray|slate|zinc|neutral|stone|orange|amber|lime|emerald|teal|cyan|sky|violet|fuchsia|rose|white|black|transparent|current|inherit)(-[0-9]+)?\b'
  '\btext-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)\b'
  '\btext-(left|center|right|justify|start|end)\b'
  '\btext-(red|blue|green|yellow|purple|pink|indigo|gray|slate|zinc|neutral|stone|orange|amber|lime|emerald|teal|cyan|sky|violet|fuchsia|rose|white|black|transparent|current|inherit)(-[0-9]+)?\b'
  '\bfont-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black|mono|sans|serif)\b'
  '\brounded(-(none|sm|md|lg|xl|2xl|3xl|full))?\b'
  '\bshadow(-(sm|md|lg|xl|2xl|inner|none))?\b'
  '\bborder(-[0-9]+)?\b' '\bborder-(t|r|b|l|x|y)(-[0-9]+)?\b'
  '\bborder-(red|blue|green|yellow|gray|slate|zinc|neutral|white|black|transparent)(-[0-9]+)?\b'
  '\bitems-[a-z]' '\bjustify-[a-z]' '\bself-[a-z]'
  '\brelative\b' '\babsolute\b' '\bfixed\b' '\bsticky\b'
  '\bz-[0-9]'
  '\bopacity-[0-9]'
  '\btruncate\b'
  '\bgrow\b' '\bshrink\b' '\bgrow-[0-9]' '\bshrink-[0-9]'
  '\bring-[a-z]'
  '\btracking-[a-z]' '\bleading-[a-z]'
  '\bgrid-cols-[0-9]' '\bcol-span-[0-9]'
  '\bspace-x-[0-9]' '\bspace-y-[0-9]'
  '\buppercase\b' '\blowercase\b' '\bcapitalize\b'
  '\bcursor-[a-z]'
  '\boverflow-[a-z]'
  '\bobject-[a-z]'
  '\baspect-[a-z]'
  '\bsr-only\b'
  '\bpointer-events-[a-z]'
  '\btransition-[a-z]' '\bduration-[0-9]'
  '\bscale-[0-9]' '\brotate-[0-9]' '\btranslate-[a-z]'
  '\binset-[0-9]' '\btop-[0-9]' '\bright-[0-9]' '\bbottom-[0-9]' '\bleft-[0-9]'
  '\bmin-w-[a-z0-9]' '\bmax-w-[a-z0-9]' '\bmin-h-[a-z0-9]' '\bmax-h-[a-z0-9]'
  '\bwhitespace-[a-z]'
  '\bselect-[a-z]'
  '\bline-clamp-[0-9]'
  '\blist-[a-z]'
  '\bplace-[a-z]'
  '\bdivide-[a-z]'
)

# ── Build grep pattern ───────────────────────────────────────────────
PATTERN=$(printf '%s|' "${TAILWIND_PATTERNS[@]}")
PATTERN="${PATTERN%|}"  # Remove trailing |

VIOLATIONS=0
VIOLATION_FILES=()

# ── Scan files ───────────────────────────────────────────────────────
if [ $# -eq 0 ]; then
  echo "Usage: $0 <file|directory|glob>"
  echo "Example: $0 frontend/src/pages/Signals.tsx"
  exit 2
fi

# Collect target files
TARGETS=()
for arg in "$@"; do
  if [ -f "$arg" ]; then
    TARGETS+=("$arg")
  elif [ -d "$arg" ]; then
    while IFS= read -r -d '' f; do
      TARGETS+=("$f")
    done < <(find "$arg" -name '*.tsx' -o -name '*.ts' -o -name '*.jsx' -o -name '*.js' -print0 2>/dev/null || true)
  else
    # Glob
    for f in $arg; do
      if [ -f "$f" ]; then
        TARGETS+=("$f")
      fi
    done
  fi
done

if [ ${#TARGETS[@]} -eq 0 ]; then
  echo -e "${YELLOW}⚠ No files to scan${NC}"
  exit 0
fi

echo "Scanning ${#TARGETS[@]} file(s) for Tailwind classes..."

for file in "${TARGETS[@]}"; do
  # Skip node_modules, dist, out
  if [[ "$file" =~ (node_modules|/dist/|/out/|\.test\.|\.spec\.) ]]; then
    continue
  fi

  # Extract only className="..." content (same as verify-1to1.py behavior)
  class_content=$(grep -o 'className="[^"]*"' "$file" 2>/dev/null || true)
  if [ -z "$class_content" ]; then
    continue
  fi
  matches=$(echo "$class_content" | grep -oE "$PATTERN" 2>/dev/null | sort -u || true)

  if [ -n "$matches" ]; then
    VIOLATIONS=$((VIOLATIONS + 1))
    VIOLATION_FILES+=("$file")
    echo ""
    echo -e "${RED}❌ ${file}${NC}"
    while IFS= read -r cls; do
      # Show first occurrence line
      line=$(grep -n "$cls" "$file" | head -1)
      echo -e "   ${YELLOW}.${cls}${NC}  (line $(echo "$line" | cut -d: -f1))"
    done <<< "$matches"
  fi
done

echo ""
if [ $VIOLATIONS -eq 0 ]; then
  echo -e "${GREEN}✅ PASS — No Tailwind utility classes detected${NC}"
  exit 0
else
  echo -e "${RED}❌ FAIL — ${VIOLATIONS} file(s) contain Tailwind utility classes${NC}"
  echo "   Replace Tailwind classes with prototype CSS class names."
  echo "   Rerun: python3 scripts/verify-1to1.py <prototype>.html <Page>.tsx <page>.css"
  exit 1
fi
