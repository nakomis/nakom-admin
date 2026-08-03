#!/usr/bin/env bash
#
# Backfill the whole cv-chat corpus into the home pgvector store (ADMIN-7).
#
# This is a *driver*, not a second implementation. It rewinds the import
# cursor and then invokes the cvchat-forward Lambda repeatedly until it
# reports nothing left to send. Writing a separate scanner would mean a second
# DynamoDB->wire mapping to keep in step with the first, and the mapping is
# precisely where the bugs were (see ADMIN-6's commit message).
#
# Safe to run more than once, and safe to interrupt:
#
#   * The consumer upserts on the record id, so a record delivered twice
#     rewrites an identical row. That is the same property that makes the
#     whole Postgres copy regenerable from the queue.
#   * The forwarder advances the cursor only past records SQS actually
#     accepted, so an interrupted run resumes from where it stopped rather
#     than from the beginning.
#
# What it does NOT do is clear the destination first. It cannot: DynamoDB is
# the record of truth and this only ever adds or refreshes rows. To rebuild
# from empty, truncate cv_chat_logs and similar_pairs on Luke, then run this.
#
# Usage:
#   AWS_PROFILE=nakom.is-admin scripts/cvchat-backfill.sh [--from <ISO8601>] [--dry-run]
#
#   --from      Rewind the cursor to this point instead of the epoch. Use it to
#               re-forward a window after fixing something, without replaying
#               the whole corpus.
#   --dry-run   Report what the cursor would be set to and stop.

set -euo pipefail

FUNCTION_NAME="${FUNCTION_NAME:-nakom-admin-cvchat-forward}"
CURSOR_PARAM="${CURSOR_PARAM:-/nakom.is/analytics/CVCHAT/last-imported-timestamp}"
REGION="${AWS_REGION:-eu-west-2}"

# The sort key is an ISO timestamp, and the query is `sk > :cursor`. The empty
# string sorts before every timestamp, so it means "everything" — but SSM
# rejects an empty parameter value, hence a literal that is lexically below any
# ISO 8601 date. The chat backend started writing in 2026; "0" is safely below
# "2026-..." in string order, which is the only order that matters here.
FROM="0"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --from)    FROM="$2"; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        # `s/^#//; s/^ //` rather than `s/^# \?//`: BSD sed, which is what
        # macOS ships and this is run from, has no `\?` in a basic regex and
        # silently matches nothing — leaving the help text with its comment
        # markers still on.
        -h|--help) sed -n '2,30p' "$0" | sed 's/^#//; s/^ //'; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

# Absent is a normal state, not an error: nothing creates this parameter, so
# an environment that has never forwarded simply has no cursor. Only the
# ParameterNotFound case is tolerated — any other failure (no credentials,
# wrong account, denied) must still stop the run, because those look identical
# from here and "start from the beginning" is the wrong answer to all of them.
if PREVIOUS=$(aws ssm get-parameter --name "$CURSOR_PARAM" --region "$REGION" \
        --query 'Parameter.Value' --output text 2>/tmp/cvchat-cursor-read.err); then
    echo "cursor is currently: $PREVIOUS"
elif grep -q 'ParameterNotFound' /tmp/cvchat-cursor-read.err; then
    PREVIOUS=""
    echo "cursor does not exist yet — this environment has never forwarded"
else
    echo "could not read $CURSOR_PARAM:" >&2
    cat /tmp/cvchat-cursor-read.err >&2
    rm -f /tmp/cvchat-cursor-read.err
    exit 1
fi
rm -f /tmp/cvchat-cursor-read.err

echo "cursor will be set to: $FROM"

if [[ $DRY_RUN -eq 1 ]]; then
    echo "(dry run — nothing changed)"
    exit 0
fi

# Printed prominently because it is the one piece of state this script
# destroys. If the run goes wrong, this is what puts it back. Suppressed when
# there is no previous value — SSM rejects an empty one, so printing the
# command would offer a recovery step that cannot work.
if [[ -n "$PREVIOUS" ]]; then
    echo
    echo "To undo the rewind without replaying:"
    echo "  aws ssm put-parameter --name $CURSOR_PARAM --value '$PREVIOUS' \\"
    echo "      --type String --overwrite --region $REGION"
    echo
else
    echo
    echo "(no previous cursor to restore — nothing is being overwritten)"
    echo
fi

read -r -p "Rewind the cursor and start the backfill? [y/N] " reply
[[ "$reply" == "y" || "$reply" == "Y" ]] || { echo "aborted"; exit 1; }

aws ssm put-parameter --name "$CURSOR_PARAM" --value "$FROM" \
    --type String --overwrite --region "$REGION" >/dev/null

total=0
round=0
while :; do
    round=$((round + 1))
    out=$(mktemp)
    # `set -e` exits straight out of the loop if the invoke below fails, past
    # every explicit `rm` — so the cleanup has to be on EXIT, not inline.
    trap 'rm -f "$out"' EXIT
    # Synchronous invoke: the point is to read `forwarded` and decide whether
    # to go again. An async invoke would return immediately and this loop
    # would spin, re-invoking a function that is already running — and two
    # concurrent runs would both read the same cursor and send the same batch.
    aws lambda invoke \
        --function-name "$FUNCTION_NAME" \
        --invocation-type RequestResponse \
        --region "$REGION" \
        --cli-binary-format raw-in-base64-out \
        --payload '{}' \
        "$out" >/dev/null

    if grep -q '"errorMessage"' "$out"; then
        echo "round $round FAILED:" >&2
        cat "$out" >&2
        echo >&2
        echo "The cursor is left where the last successful round put it, so" >&2
        echo "re-running this script resumes rather than restarting." >&2
        rm -f "$out"
        exit 1
    fi

    forwarded=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("forwarded", 0))' "$out")
    cursor=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("cursor", "?"))' "$out")
    failed=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("failed", 0))' "$out")
    rm -f "$out"

    total=$((total + forwarded))
    echo "round $round: forwarded=$forwarded failed=$failed total=$total cursor=$cursor"

    if [[ "$failed" != "0" ]]; then
        echo
        echo "SQS rejected $failed message(s). The cursor stopped at the first" >&2
        echo "failure, so nothing was skipped — fix the cause and re-run." >&2
        exit 1
    fi

    [[ "$forwarded" == "0" ]] && break
done

echo
echo "backfill complete: $total record(s) enqueued over $round round(s)."
echo
echo "They are queued, not yet stored. Cal embeds serially at roughly 1.7s a"
echo "record, so $total records will take about $((total * 17 / 10 / 60)) minutes to drain."
echo "Watch it from the portal's Overview dashboard, or:"
echo "  curl -s https://api.cal.home.nakomis.com/convmem/queue-status | jq ."
