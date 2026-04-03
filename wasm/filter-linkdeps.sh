#!/bin/bash
# Filter soffice.js.linkdeps to produce type-specific library lists.
# Usage: bash filter-linkdeps.sh <writer|calc|impress> < soffice.js.linkdeps
#
# Classifies all libraries into COMMON, WRITER, CALC, IMPRESS.
# Outputs only COMMON + the requested type.

TYPE="$1"
if [[ -z "$TYPE" ]]; then
    echo "Usage: $0 <writer|calc|impress>" >&2
    exit 1
fi

# Read all flags from stdin
DEPS=$(cat)

# Writer-only libraries
WRITER_LIBS="swlo swdlo swuilo sw_writerfilterlo mswordlo hwplo t602filterlo wpftwriterlo"

# Calc-only libraries
CALC_LIBS="sclo scdlo scuilo scfiltlo wpftcalclo solverlo"

# Impress-only libraries
IMPRESS_LIBS="sdlo sddlo sduilo slideshowlo animcorelo PresentationMinimizerlo wpftimpresslo wpftdrawlo smlo smdlo"

# Canvas libs (needed by impress and optionally calc charts)
CANVAS_LIBS="cairocanvaslo canvasfactorylo simplecanvaslo vclcanvaslo canvastoolslo cppcanvaslo"

# Determine which libs to EXCLUDE
EXCLUDE=""
case "$TYPE" in
    writer)
        EXCLUDE="$CALC_LIBS $IMPRESS_LIBS $CANVAS_LIBS"
        ;;
    calc)
        EXCLUDE="$WRITER_LIBS $IMPRESS_LIBS"
        # Calc keeps canvas for chart rendering
        ;;
    impress)
        EXCLUDE="$WRITER_LIBS $CALC_LIBS"
        # Impress keeps canvas
        ;;
    *)
        echo "Unknown type: $TYPE (use writer|calc|impress)" >&2
        exit 1
        ;;
esac

# Build regex of excluded -l flags
EXCLUDE_PATTERN=""
for lib in $EXCLUDE; do
    if [[ -n "$EXCLUDE_PATTERN" ]]; then
        EXCLUDE_PATTERN="${EXCLUDE_PATTERN}|"
    fi
    EXCLUDE_PATTERN="${EXCLUDE_PATTERN}-l${lib}"
done

if [[ -n "$EXCLUDE_PATTERN" ]]; then
    echo "$DEPS" | tr ' ' '\n' | grep -vE "^(${EXCLUDE_PATTERN})$" | tr '\n' ' '
else
    echo "$DEPS"
fi
echo ""
