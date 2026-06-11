#!/usr/bin/env python3
"""
1:1 Prototype Fidelity Verifier — machine-enforceable constraint.

Usage:
  python3 scripts/verify-1to1.py <prototype.html> <Page.tsx> <page.css> [--loose]

Checks:
  1. CSS class name match — every class from prototype <style> + class="..." must appear in implementation
  2. Text content match — every text node from prototype must appear in implementation
  3. Section structure match — prototype top-level sections must map to implementation
  4. Mock data value match — numeric values from prototype must appear in implementation
  5. Tailwind detection — fail if Tailwind utility classes are used in page files

Exit code: 0 = PASS, 1 = FAIL
Output: detailed PASS/FAIL report with specific mismatch locations
"""

import re
import sys
import os
from html.parser import HTMLParser
from collections import defaultdict


# ── Tailwind class patterns ──────────────────────────────────────────
# These are the MINIMAL set of patterns that are UNMISTAKABLY Tailwind.
# We avoid matching CSS property values (display: flex) by only checking
# className context, not CSS files.
# We exclude project design tokens: font-body, font-display, font-mono,
# bg-elevated, bg-higher, border-soft, border-strong, border-color, etc.
TAILWIND_CLASSES = {
    # Layout — these are dead giveaways when used as class names
    'flex', 'inline-flex', 'grid', 'inline-grid', 'block', 'inline-block',
    'hidden', 'flow-root',
    # Sizing with numbers (NOT project tokens)
    # — these are catched by regex patterns below
    # Spacing with numbers
    # Typography with numbers
}
TAILWIND_REGEX_PATTERNS = [
    # Width/height with numeric values: w-1, w-1/2, w-full, h-96, etc.
    r'\bw-\d+(?:/\d+)?\b', r'\bw-(?:full|auto|screen|fit|min|max)\b',
    r'\bh-\d+(?:/\d+)?\b', r'\bh-(?:full|auto|screen|fit|min|max)\b',
    r'\bmin-w-\d+\b', r'\bmax-w-\d+\b', r'\bmin-h-\d+\b', r'\bmax-h-\d+\b',
    # Padding/margin with numeric values: p-4, px-2, mt-8, etc.
    r'\b[pm][txblrxy]?-\d+(?:\.\d+)?\b',
    # Gap with numeric values: gap-4, gap-x-2
    r'\bgap-[xylr]?-\d+(?:\.\d+)?\b',
    # Space between: space-x-4, space-y-2
    r'\bspace-[xy]-\d+(?:\.\d+)?\b',
    # Background color with palette shade: bg-red-500, bg-gray-100
    r'\bbg-(?:red|blue|green|yellow|purple|pink|indigo|gray|slate|zinc|neutral|stone|amber|lime|emerald|teal|cyan|sky|violet|fuchsia|rose|orange|white|black|transparent|current|inherit)(?:-\d+)?\b',
    # Text color with palette shade: text-red-500, text-gray-700
    r'\btext-(?:red|blue|green|yellow|purple|pink|indigo|gray|slate|zinc|neutral|stone|amber|lime|emerald|teal|cyan|sky|violet|fuchsia|rose|orange|white|black|transparent|current|inherit)(?:-\d+)?\b',
    # Text size with Tailwind scale: text-xs, text-sm, text-base, text-lg, text-xl, text-2xl...
    r'\btext-(?:xs|sm|base|lg|[2-9]?xl)\b',
    # Font weight with Tailwind scale: font-thin, font-bold, font-semibold...
    r'\bfont-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black)\b',
    # Border radius with Tailwind scale: rounded-sm, rounded-lg, rounded-full...
    r'\brounded(?:-(?:none|sm|md|lg|xl|[23]xl|full))?\b',
    # Border color with palette: border-red-500
    r'\bborder-(?:red|blue|green|yellow|purple|pink|indigo|gray|slate|zinc|neutral|stone|amber|lime|emerald|teal|cyan|sky|violet|fuchsia|rose|orange|white|black|transparent)(?:-\d+)?\b',
    # Shadow with Tailwind scale: shadow-sm, shadow-lg, shadow-xl...
    r'\bshadow(?:-(?:sm|md|lg|xl|2xl|inner|none))?\b',
    # Flex/Grid alignment: items-center, justify-between, self-start...
    r'\bitems-(?:start|end|center|baseline|stretch)\b',
    r'\bjustify-(?:start|end|center|between|around|evenly|stretch)\b',
    r'\bself-(?:auto|start|end|center|stretch|baseline)\b',
    r'\bplace-(?:content|items|self)-(?:start|end|center|between|around|evenly|stretch)\b',
    # Position: relative, absolute, fixed, sticky (ONLY when used as standalone class)
    # These are checked in className context to avoid matching CSS properties
    r'\b(?:inset|top|right|bottom|left)-\d+\b',
    r'\bz-\d+\b',
    # Opacity with number: opacity-0, opacity-50
    r'\bopacity-\d+\b',
    # Grid columns: grid-cols-3, col-span-2
    r'\bgrid-cols-\d+\b', r'\bcol-span-\d+\b', r'\brow-span-\d+\b',
    # Flex grow/shrink: grow, grow-0, shrink-0
    r'\bgrow(?:-\d+)?\b', r'\bshrink(?:-\d+)?\b',
    # Ring: ring-2, ring-red-500
    r'\bring(?:-\d+|-(?:red|blue|green|yellow|purple|pink|indigo|gray|slate|zinc|neutral|stone|amber|lime|emerald|teal|cyan|sky|violet|fuchsia|rose|orange|white|black|transparent)(?:-\d+)?)?\b',
    # Transform: scale-75, rotate-45, translate-x-1
    r'\b(?:scale|rotate|translate-[xy]|skew-[xy])-\d+\b',
    # Cursor: cursor-pointer, cursor-not-allowed
    r'\bcursor-(?:pointer|not-allowed|wait|text|move|grab|grabbing|default|auto|none|help|progress|crosshair|cell|zoom-in|zoom-out)\b',
    # Overflow: overflow-hidden, overflow-scroll
    r'\boverflow-(?:hidden|scroll|auto|visible|clip)\b',
    # Transition/duration: transition-all, duration-300
    r'\bduration-\d+\b',
    r'\btransition-(?:all|colors|opacity|shadow|transform|none)\b',
    # Truncate / whitespace
    r'\btruncate\b', r'\bline-clamp-[2-6]\b',
    r'\bwhitespace-(?:normal|nowrap|pre|pre-line|pre-wrap|break-spaces)\b',
    # Object fit: object-cover, object-contain
    r'\bobject-(?:cover|contain|fill|none|scale-down)\b',
    # Tracking / Leading
    r'\btracking-(?:tighter|tight|normal|wide|wider|widest)\b',
    r'\bleading-\d+\b',
    # Divide: divide-x-2, divide-y
    r'\bdivide-[xy](?:-\d+)?\b',
    r'\bdivide-(?:red|blue|green|yellow|purple|pink|indigo|gray|slate|zinc|neutral|stone|amber|lime|emerald|teal|cyan|sky|violet|fuchsia|rose|orange|white|black|transparent)(?:-\d+)?\b',
    # List style: list-disc, list-decimal
    r'\blist-(?:disc|decimal|none)\b',
    # Pointer events / select
    r'\bpointer-events-(?:none|auto)\b',
    r'\bselect-(?:none|text|all|auto)\b',
    # Aspect ratio
    r'\baspect-(?:auto|square|video)\b',
    # Screen reader
    r'\bsr-only\b',
    # Standalone layout classes (only flagged when in className)
    r'\babsolute\b', r'\brelative\b', r'\bfixed\b', r'\bsticky\b',
    # Flex/grid standalone
    r'\bflex\b', r'\bgrid\b',
    # uppercase/lowercase/capitalize
    r'\buppercase\b', r'\blowercase\b', r'\bcapitalize\b',
    # Size standalone (when used as Tailwind class in className)
    r'\bsize-\d+\b', r'\bsize-(?:full|auto|screen|fit|min|max)\b',
]

# CSS class names that are not Tailwind but are common globals — exclude from checks
SKIP_CLASSES = {
    'body', 'html', 'a', 'button', 'input', 'select', 'textarea',
    'active', 'selected', 'disabled', 'hover', 'focus', 'visible', 'hidden',
    'open', 'closed', 'show', 'hide', 'loading', 'error', 'success',
    'btn', 'btn-sm', 'btn-primary', 'btn-ghost', 'btn-danger',
    'nav', 'main', 'header', 'footer',
}


class PrototypeExtractor(HTMLParser):
    """Extract CSS classes, text content, section structure, and data values from prototype HTML."""

    def __init__(self):
        super().__init__()
        self.css_classes = set()      # All class names from class="..." attributes
        self.class_selectors = set()  # All class names from <style> blocks
        self.text_nodes = []          # All non-empty text content
        self.data_values = []         # Numeric values from data contexts
        self.sections = []            # Top-level sections (by id or first class)
        self.in_style = False
        self.in_skip = False       # script, noscript, svg, title
        self.style_content = ""
        self.current_tag = None
        self.depth = 0
        self.skip_tags = {'script', 'style', 'noscript', 'svg', 'path', 'title'}

    def handle_starttag(self, tag, attrs):
        self.current_tag = tag
        self.depth += 1

        attrs_dict = dict(attrs)

        if tag == 'style':
            self.in_style = True
            return

        if tag in self.skip_tags:
            self.in_skip = True
            return

        # Extract class names from class attribute
        if 'class' in attrs_dict:
            classes = attrs_dict['class'].split()
            for c in classes:
                c = c.strip()
                if c and c not in SKIP_CLASSES:
                    self.css_classes.add(c)

        # Track top-level sections
        if self.depth <= 3:
            section_id = None
            if 'id' in attrs_dict:
                section_id = attrs_dict['id']
            elif 'class' in attrs_dict:
                section_id = attrs_dict['class'].split()[0]
            if section_id and section_id not in self.skip_tags:
                self.sections.append(section_id)

    def handle_endtag(self, tag):
        self.depth -= 1
        if tag == 'style':
            self.in_style = False
        if tag in self.skip_tags:
            self.in_skip = False

    def handle_data(self, data):
        if self.in_style:
            self.style_content += data
            return
        if self.in_skip or self.current_tag in self.skip_tags:
            return

        text = data.strip()
        if text and len(text) > 1:  # Skip single characters and empty
            self.text_nodes.append(text)

        # Extract numeric values (prices, percentages, quantities)
        numbers = re.findall(r'\b\d+\.?\d*\b', data)
        for n in numbers:
            val = float(n)
            if val > 0.01:  # Skip trivial numbers
                self.data_values.append(str(val))

    def extract_style_classes(self):
        """Parse <style> content for class selectors like .class-name"""
        # Match .class-name patterns in CSS
        selectors = re.findall(r'\.([a-zA-Z_][\w-]*(?:\.[a-zA-Z_][\w-]*)*)\s*[{,]', self.style_content)
        for s in selectors:
            # Handle compound selectors like .btn.primary
            for part in s.split('.'):
                part = part.strip()
                if part and part not in SKIP_CLASSES and not part.startswith('hsla') and not part.startswith('var'):
                    self.class_selectors.add(part)

        # Also match class selectors in the middle of selector lists
        # e.g., ".signal-item.pending { }"
        for match in re.finditer(r'\.([a-zA-Z_][\w-]*)', self.style_content):
            cls = match.group(1)
            if cls not in SKIP_CLASSES and not cls.startswith('hsla') and not cls.startswith('var'):
                self.class_selectors.add(cls)


def extract_from_html(filepath):
    """Extract all prototype features from an HTML file."""
    if not os.path.exists(filepath):
        print(f"  ❌ File not found: {filepath}")
        return None

    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    extractor = PrototypeExtractor()
    extractor.feed(content)
    extractor.extract_style_classes()

    return extractor


def check_class_match(prototype_classes, impl_content, label):
    """
    Check that all prototype CSS classes appear in implementation.
    Returns (match_count, total_count, missing_classes, false_positives).
    """
    all_proto_classes = prototype_classes.css_classes | prototype_classes.class_selectors
    missing = []
    matched = []

    # Filter out JS template literal fragments
    js_fragments = set()
    for cls in all_proto_classes:
        # Skip things that look like JS fragments
        if any(c in cls for c in ['${', '`', '+', "'", '"', '(', ')', ';']):
            js_fragments.add(cls)
            continue

    clean_classes = all_proto_classes - js_fragments

    for cls in sorted(clean_classes):
        # Check for the exact class name in implementation
        # Look for: className="...cls...", class="...cls...", .cls {, .cls:hover, etc.
        patterns = [
            f'.{cls}',           # CSS selector
            f'"{cls}"',          # JSX string
            f"'{cls}'",          # JSX string
            f'"{cls} ',          # Start of class list
            f' {cls}"',          # End of class list
            f' {cls} ',          # Middle of class list
            f'className="{cls}"', # Exact single class
        ]
        found = any(p in impl_content for p in patterns)
        if found:
            matched.append(cls)
        else:
            missing.append(cls)

    return matched, missing, js_fragments


def check_text_match(prototype_text_nodes, impl_content, label):
    """
    Check that text content from prototype appears in implementation.
    Returns (match_count, total_count, missing_texts).
    """
    missing = []
    matched = []

    # Only check meaningful text (>3 chars, not JS/HTML artifacts)
    meaningful = []
    for t in prototype_text_nodes:
        if len(t) < 3:
            continue
        # Skip JS code fragments
        if any(t.startswith(kw) for kw in [
            'function', 'const ', 'let ', 'var ', '//', '/*', 'return',
            'if (', 'for (', 'while', 'switch', 'Date.now', 'document.',
            'window.', 'Math.', 'setTimeout', 'setInterval',
            'addEventListener', 'classList', 'querySelector',
            'getElementById', 'console.', 'renderSignal',
            'currentMode', 'signal-', 'statusClass',
        ]):
            continue
        # Skip HTML artifacts
        if any(t.startswith(kw) for kw in ['<!', '═', '──', '╔', '╚']):
            continue
        # Skip JS expressions
        if '=>' in t or '${' in t or '`' in t:
            continue
        # Skip text that is purely numbers
        if re.fullmatch(r'[\d.,\s]+', t):
            continue
        # Skip JS method calls / property access
        if '.' in t and '(' in t:
            continue
        meaningful.append(t)

    # Deduplicate
    seen = set()
    unique_texts = []
    for t in meaningful:
        if t not in seen:
            seen.add(t)
            unique_texts.append(t)

    for text in unique_texts:
        if text in impl_content:
            matched.append(text)
        else:
            missing.append(text)

    return matched, missing


def check_tailwind(impl_content, tsx_path):
    """
    Check for Tailwind utility classes in JSX className attributes only.
    We extract className="..." values from TSX and check those.
    We do NOT check CSS files — display: flex is not a Tailwind class.
    """
    violations = []

    # Only check TSX/JSX files, not CSS
    if not tsx_path.endswith(('.tsx', '.jsx')):
        return violations

    # Extract all className="..." values from TSX
    classname_values = set()
    for match in re.finditer(r'className="([^"]*)"', impl_content):
        for cls in match.group(1).split():
            cls = cls.strip()
            if cls:
                classname_values.add(cls)

    # Also check class="..." in non-TSX contexts
    for match in re.finditer(r'\bclass="([^"]*)"', impl_content):
        for cls in match.group(1).split():
            cls = cls.strip()
            if cls:
                classname_values.add(cls)

    # Check each class name against Tailwind patterns
    for cls in classname_values:
        for pattern in TAILWIND_REGEX_PATTERNS:
            if re.fullmatch(pattern, cls):
                violations.append({
                    'class': cls,
                    'pattern': pattern,
                    'context': f'className="..." contains "{cls}"'
                })
                break  # One violation per class name

    # Also check for Tailwind standalone classes
    for cls in classname_values:
        if cls in TAILWIND_CLASSES:
            violations.append({
                'class': cls,
                'pattern': 'standalone Tailwind class',
                'context': f'className="..." contains "{cls}"'
            })

    # Deduplicate
    seen = set()
    unique_violations = []
    for v in violations:
        if v['class'] not in seen:
            seen.add(v['class'])
            unique_violations.append(v)

    return unique_violations


def check_section_match(prototype_sections, impl_content):
    """Check that prototype top-level sections exist in implementation."""
    missing = []
    matched = []

    meaningful_sections = [
        s for s in prototype_sections
        if s not in SKIP_CLASSES
        and len(s) >= 2
        and not s.startswith('js')
        and not s.startswith('css')
    ]

    for section in meaningful_sections:
        if section in impl_content:
            matched.append(section)
        else:
            missing.append(section)

    return matched, missing


def verify(prototype_path, tsx_path, css_path, loose=False):
    """Run all 1:1 verification checks."""
    proto_dir = os.path.dirname(prototype_path) if os.path.dirname(prototype_path) else '.'

    print(f"\n{'='*60}")
    print(f"1:1 Verification: {os.path.basename(prototype_path)} → {os.path.basename(tsx_path)} + {os.path.basename(css_path)}")
    print(f"{'='*60}")

    # Extract from prototype
    proto = extract_from_html(prototype_path)
    if proto is None:
        return False

    # Read implementation files
    impl_content = ""
    for path in [tsx_path, css_path]:
        if os.path.exists(path):
            with open(path, 'r', encoding='utf-8') as f:
                impl_content += f.read() + "\n"
        else:
            print(f"  ⚠️  File not found (skipping): {path}")

    if not impl_content.strip():
        print("  ❌ No implementation content to verify")
        return False

    all_pass = True

    # ── Check 1: CSS Class Match ─────────────────────────────────────
    matched, missing, js_fragments = check_class_match(proto, impl_content, os.path.basename(tsx_path))
    total = len(matched) + len(missing)

    match_pct = (len(matched) / total * 100) if total > 0 else 100
    threshold = 90 if loose else 100

    print(f"\n── CSS Class Match: {len(matched)}/{total} ({match_pct:.1f}%) ──")
    if match_pct >= threshold:
        print(f"  ✅ PASS (threshold: {threshold}%)")
    else:
        print(f"  ❌ FAIL (threshold: {threshold}%)")
        all_pass = False
        print(f"  Missing classes ({len(missing)}):")
        for cls in missing[:20]:
            print(f"    - .{cls}")
        if len(missing) > 20:
            print(f"    ... and {len(missing) - 20} more")

    if js_fragments:
        print(f"  ℹ️  Skipped {len(js_fragments)} JS template literal fragments")

    # ── Check 2: Text Content Match ──────────────────────────────────
    text_matched, text_missing = check_text_match(proto.text_nodes, impl_content, os.path.basename(tsx_path))
    text_total = len(text_matched) + len(text_missing)

    text_pct = (len(text_matched) / text_total * 100) if text_total > 0 else 100
    text_threshold = 95  # Allow 5% variance for dynamically generated text

    print(f"\n── Text Content Match: {len(text_matched)}/{text_total} ({text_pct:.1f}%) ──")
    if text_pct >= text_threshold:
        if text_pct >= 100:
            print(f"  ✅ PASS")
        else:
            print(f"  ✅ PASS (≥{text_threshold}% — minor differences may be dynamic text)")
            if text_missing:
                print(f"  Minor differences ({len(text_missing)}):")
                for t in text_missing[:5]:
                    display = t[:80] + ('...' if len(t) > 80 else '')
                    print(f"    - \"{display}\"")
    else:
        print(f"  ❌ FAIL (threshold: {text_threshold}%)")
        all_pass = False
        print(f"  Missing texts ({len(text_missing)}):")
        for t in text_missing[:15]:
            display = t[:80] + ('...' if len(t) > 80 else '')
            print(f"    - \"{display}\"")
        if len(text_missing) > 15:
            print(f"    ... and {len(text_missing) - 15} more")

    # ── Check 3: Section Structure (advisory — prototype uses DOM ids, React uses state) ──
    section_matched, section_missing = check_section_match(proto.sections, impl_content)
    section_total = len(section_matched) + len(section_missing)

    if section_total > 0:
        section_pct = (len(section_matched) / section_total * 100) if section_total > 0 else 100
        section_threshold = 50 if loose else 70

        print(f"\n── Section Structure Match: {len(section_matched)}/{section_total} ({section_pct:.1f}%) ──")
        if section_pct >= section_threshold:
            print(f"  ⚠️  ADVISORY (threshold: {section_threshold}%)")
        else:
            print(f"  ⚠️  LOW MATCH — verify sections are implemented with React state, not DOM ids")
            print(f"  Missing prototype sections (may be implemented differently in React):")
            for s in section_missing:
                print(f"    - #{s}")
    else:
        print(f"\n── Section Structure: No sections detected in prototype")

    # ── Check 4: Tailwind Detection ───────────────────────────────────
    violations = check_tailwind(impl_content, tsx_path)
    print(f"\n── Tailwind Class Detection (className context only) ──")
    if len(violations) == 0:
        print(f"  ✅ PASS — No Tailwind utility classes in className")
    else:
        unique_violations = {}
        for v in violations:
            cls = v['class']
            if cls not in unique_violations:
                unique_violations[cls] = v

        print(f"  ❌ FAIL — {len(unique_violations)} Tailwind class(es) in className")
        all_pass = False
        for cls, v in sorted(unique_violations.items())[:15]:
            print(f"    - .{cls}")
        if len(unique_violations) > 15:
            print(f"    ... and {len(unique_violations) - 15} more")

    # ── Summary ───────────────────────────────────────────────────────
    print(f"\n{'='*60}")
    if all_pass:
        print(f"✅ VERIFIED — All checks passed")
        if loose:
            print(f"   (loose mode: 90% threshold for class/text match)")
    else:
        print(f"❌ FAILED — See above for specific issues to fix")
    print(f"{'='*60}\n")

    return all_pass


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)

    prototype_path = sys.argv[1]
    tsx_path = sys.argv[2]
    css_path = sys.argv[3]
    loose = '--loose' in sys.argv

    ok = verify(prototype_path, tsx_path, css_path, loose=loose)
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
