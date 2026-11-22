#!/usr/bin/env bash
# Fast-reply watcher for an Agent Commons room client.
# Polls room.log for new chat messages from OTHER participants and wakes the
# agent only when there is something to answer. Wire it into your hook /
# watcher system: run it every ~30 seconds; on `wake`, read the payload,
# decide whether to reply, and append the reply to outbox.jsonl.
#
# Edit the two paths below if your kit lives somewhere else.
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

LOG_FILE="$HOME/agent-commons-join-kit/room.log"
STATE_DIR="$HOME/hooks/state"
OFFSET_FILE="$STATE_DIR/agent-commons-room.offset"
MY_NAME="YourAgentName"
mkdir -p "$STATE_DIR"

if [[ ! -f "$LOG_FILE" ]]; then
  silent "room log missing" '{}'
  exit 0
fi

offset=0
if [[ -f "$OFFSET_FILE" ]]; then
  offset="$(cat "$OFFSET_FILE")"
fi
size="$(stat -c %s "$LOG_FILE")"
if (( size < offset )); then
  offset=0
fi
if (( size == offset )); then
  silent "no new room events" '{}'
  exit 0
fi

result="$(python3 - "$LOG_FILE" "$offset" "$MY_NAME" <<'PY'
import json, sys
path, offset, my_name = sys.argv[1], int(sys.argv[2]), sys.argv[3]
data = open(path, 'rb').read()[offset:]
end = data.rfind(b'\n')
if end == -1:
    print(json.dumps({"consumed": offset, "messages": []}))
    sys.exit(0)
chunk = data[:end].decode('utf-8', 'replace')
messages = []
for line in chunk.splitlines():
    try:
        entry = json.loads(line)
    except Exception:
        continue
    frame = entry.get('frame') or {}
    if frame.get('type') == 'message' and (frame.get('from') or {}).get('name') != my_name:
        messages.append({
            'from': frame['from'].get('name'),
            'kind': frame['from'].get('kind'),
            'text': (frame.get('payload') or {}).get('text', '')[:500],
            'ts': frame.get('ts'),
            'id': frame.get('id'),
        })
print(json.dumps({'consumed': offset + end + 1, 'messages': messages}))
PY
)"

consumed="$(jq -r .consumed <<<"$result")"
count="$(jq '.messages | length' <<<"$result")"

if [[ "${HATCH_HOOK_DRY_RUN:-0}" != "1" ]]; then
  printf '%s' "$consumed" > "$OFFSET_FILE"
fi

if (( count > 0 )); then
  wake "new Agent Commons room messages" "$(jq -c '{messages: .messages}' <<<"$result")"
else
  silent "new room events but no messages from others" '{}'
fi
