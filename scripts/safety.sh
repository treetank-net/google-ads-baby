#!/bin/bash
#
# Two-phase mutation safety for Google Ads MCP.
# Blocks confirm_mutation unless a real user message with the LLM-selected safe word arrived after prepare_*.
#
# Flow:
#   prepare_*         → state = "pending"
#   user types safe word → state = "user-confirmed"
#   confirm_mutation   → allowed only if state = "user-confirmed"

STATE_DIR="${GOOGLE_ADS_BABY_DATA:-${CLAUDE_PLUGIN_DATA:-${HOME:-/tmp}/.google-ads-baby}}"
STATE_FILE="$STATE_DIR/.gads-confirm-state"
SAFE_WORD_FILE="$STATE_DIR/.gads-safe-word"
CONFIG_FILE="$STATE_DIR/config.json"
mkdir -p "$STATE_DIR"

json_value() {
  if [ ! -f "$CONFIG_FILE" ]; then
    return 0
  fi
  node -e 'try { const fs = require("fs"); const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(String(cfg[process.argv[2]] || "")); } catch {}' "$CONFIG_FILE" "$1"
}

SAVED_SAFETY_LEVEL=$(json_value safetyLevel)
SAVED_STATE_TTL_SECONDS=$(json_value confirmStateTtlSeconds)
SAFETY_LEVEL="${GOOGLE_ADS_SAFETY_LEVEL:-${SAVED_SAFETY_LEVEL:-standard}}"
STATE_TTL_SECONDS="${GOOGLE_ADS_CONFIRM_STATE_TTL_SECONDS:-$SAVED_STATE_TTL_SECONDS}"

case "$SAFETY_LEVEL" in
  strict)
    DEFAULT_STATE_TTL_SECONDS=300
    ;;
  off)
    DEFAULT_STATE_TTL_SECONDS=0
    ;;
  standard|*)
    DEFAULT_STATE_TTL_SECONDS=3600
    ;;
esac

if ! echo "$STATE_TTL_SECONDS" | grep -Eq '^[0-9]+$'; then
  STATE_TTL_SECONDS="$DEFAULT_STATE_TTL_SECONDS"
fi

HOOK_TYPE="$1"
INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)

safe_word_present() {
  node -e '
const word = process.argv[1] || "";
const input = process.argv[2] || "";
let text = input;
try {
  const parsed = JSON.parse(input);
  text = String(parsed.prompt ?? parsed.message ?? parsed.text ?? input);
} catch {}
const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const re = new RegExp("(^|[^A-Za-z0-9_-])" + escaped + "(?=$|[^A-Za-z0-9_-])", "i");
process.exit(word && re.test(text) ? 0 : 1);
' "$1" "$INPUT"
}

case "$HOOK_TYPE" in
  pre-tool)
	    if echo "$TOOL_NAME" | grep -Eq '^mcp__google[-_]ads__prepare_'; then
	      echo "pending:$(date +%s)" > "$STATE_FILE"
	      SAFE_WORD=$(echo "$INPUT" | sed -n 's/.*"safe_word"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
	      if [ -n "$SAFE_WORD" ]; then
	        echo "$SAFE_WORD" > "$SAFE_WORD_FILE"
	      fi
	      exit 0
	    fi

	    if echo "$TOOL_NAME" | grep -Eq '^mcp__google[-_]ads__confirm_mutation$'; then
	      if [ "$SAFETY_LEVEL" = "off" ] || [ "${GOOGLE_ADS_YOLO:-}" = "1" ]; then
	        rm -f "$STATE_FILE"
	        exit 0
	      fi

      if [ ! -f "$STATE_FILE" ]; then
        echo '{"error":"Brak operacji do potwierdzenia. Najpierw wywołaj prepare_*."}'
        exit 2
      fi

	      STATE=$(cut -d: -f1 < "$STATE_FILE")
	      STATE_CREATED_AT=$(cut -d: -f2 < "$STATE_FILE")

	      if [ "$STATE_TTL_SECONDS" != "0" ] && [ -n "$STATE_CREATED_AT" ]; then
	        NOW=$(date +%s)
	        AGE=$((NOW - STATE_CREATED_AT))
	        if [ "$AGE" -gt "$STATE_TTL_SECONDS" ]; then
	          rm -f "$STATE_FILE"
	          echo '{"error":"Potwierdzenie wygasło. Przygotuj operację ponownie za pomocą prepare_*."}'
	          exit 2
	        fi
	      fi

	      if [ "$STATE" != "user-confirmed" ]; then
        echo '{"error":"Wymagana odpowiedź użytkownika przed potwierdzeniem. Zapytaj użytkownika i poczekaj na odpowiedź."}'
        exit 2
      fi

      exit 0
    fi
    ;;

	  user-submit)
	    if [ -f "$STATE_FILE" ]; then
	      STATE=$(cut -d: -f1 < "$STATE_FILE")
	      if [ "$STATE" = "pending" ]; then
	        if [ ! -f "$SAFE_WORD_FILE" ]; then
	          exit 0
	        fi
	        SAFE_WORD=$(cat "$SAFE_WORD_FILE")
	        if safe_word_present "$SAFE_WORD"; then
	          echo "user-confirmed:$(date +%s)" > "$STATE_FILE"
	        fi
	      fi
	    fi
    exit 0
    ;;
esac

exit 0
