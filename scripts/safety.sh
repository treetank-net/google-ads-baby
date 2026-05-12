#!/bin/bash
#
# Two-phase mutation safety for Google Ads MCP.
# Blocks confirm_mutation unless a real user message arrived after prepare_*.
#
# Flow:
#   prepare_*         → state = "pending"
#   user types "tak"  → state = "user-confirmed"
#   confirm_mutation   → allowed only if state = "user-confirmed"

STATE_DIR="${CLAUDE_PLUGIN_DATA:-/tmp}"
STATE_FILE="$STATE_DIR/.gads-confirm-state"

HOOK_TYPE="$1"
INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)

case "$HOOK_TYPE" in
  pre-tool)
    if echo "$TOOL_NAME" | grep -q '^mcp__google-ads__prepare_'; then
      echo "pending:$(date +%s)" > "$STATE_FILE"
      exit 0
    fi

    if [ "$TOOL_NAME" = "mcp__google-ads__confirm_mutation" ]; then
      if [ ! -f "$STATE_FILE" ]; then
        echo '{"error":"Brak operacji do potwierdzenia. Najpierw wywołaj prepare_*."}'
        exit 2
      fi

      STATE=$(cut -d: -f1 < "$STATE_FILE")

      if [ "$STATE" != "user-confirmed" ]; then
        echo '{"error":"Wymagana odpowiedź użytkownika przed potwierdzeniem. Zapytaj użytkownika i poczekaj na odpowiedź."}'
        exit 2
      fi

      rm -f "$STATE_FILE"
      exit 0
    fi
    ;;

  user-submit)
    if [ -f "$STATE_FILE" ]; then
      STATE=$(cut -d: -f1 < "$STATE_FILE")
      if [ "$STATE" = "pending" ]; then
        echo "user-confirmed:$(date +%s)" > "$STATE_FILE"
      fi
    fi
    exit 0
    ;;
esac

exit 0
