# shellcheck shell=bash disable=SC2034
# Notarizes a disk image and waits for Apple's verdict. Sourced by package-macos.sh.
#
# The packaging script gives Apple 45 minutes from its own start, and this file
# asks for the verdict every 30 seconds. That leaves the unchanged sixty-minute
# job time for stapling, validation and the smoke test.
#
#   notarize_dmg <disk image> <json file> <deadline> <interval> <notarytool command...>
#
# The deadline is an absolute value of $SECONDS. The command words are a
# notarytool prefix, for example "xcrun notarytool" or a function that adds the
# credentials; the verbs submit, info and log follow them. Returns 0 when Apple
# accepts the image, 1 in every other case, with the reason on the output.
# Works with Bash 3.2, so it runs on a stock Mac.

NOTARY_DEADLINE_SECONDS=2700
NOTARY_INTERVAL_SECONDS=30
NOTARY_REQUEST_SECONDS=60

# Prints the string value of a key in a JSON file. Fails when the file is empty or not JSON, or has no such value.
notary_field() {
  local value
  [ -s "$1" ] || return 1
  value="$(plutil -extract "$2" raw "$1" 2> /dev/null)" || return 1
  [ -n "$value" ] || return 1
  printf '%s\n' "$value"
}

# Runs a command with its output in a file, and kills it and everything it started when it is still running after the given seconds.
#
#   notary_bounded <seconds> <output file> <command...>
#
# Returns the exit code of the command, or 124 when the limit killed it. Each
# of the command and the watchdog runs in its own process group, so one signal
# reaches the command's children and the watchdog's sleep. There is no timeout
# tool on a Mac.
notary_bounded() {
  local limit="$1" out="$2" code=0 command_pid watchdog_pid marker="$2.timeout"
  shift 2
  rm -f "$marker"
  set -m
  "$@" > "$out" < /dev/null &
  command_pid=$!
  (
    sleep "$limit"
    : > "$marker"
    kill -s KILL -- "-$command_pid" 2> /dev/null
  ) &
  watchdog_pid=$!
  set +m
  wait "$command_pid" 2> /dev/null || code=$?
  kill -s KILL -- "-$watchdog_pid" 2> /dev/null || true
  wait "$watchdog_pid" 2> /dev/null || true
  if [ "$code" -eq 137 ] && [ -e "$marker" ]; then code=124; fi
  rm -f "$marker"
  return "$code"
}

# The seconds one request may take: the request limit, or what is left of the deadline.
notary_request_limit() {
  local remaining=$(($1 - SECONDS))
  if [ "$remaining" -lt "$NOTARY_REQUEST_SECONDS" ]; then
    echo "$remaining"
  else
    echo "$NOTARY_REQUEST_SECONDS"
  fi
}

# Prints Apple's log of a submission. A log that cannot be fetched does not change the outcome.
notary_print_log() {
  local submission="$1" deadline="$2" log_file="$3" limit code=0
  shift 3
  [ -n "$submission" ] || return 0
  limit="$(notary_request_limit "$deadline")"
  if [ "$limit" -le 0 ]; then
    echo "No time is left to fetch the notary log of submission $submission."
    return 0
  fi
  notary_bounded "$limit" "$log_file" "$@" log "$submission" || code=$?
  cat "$log_file" 2> /dev/null || true
  if [ "$code" -ne 0 ]; then echo "The notary log of submission $submission could not be fetched (exit code $code)."; fi
  return 0
}

notarize_dmg() {
  local dmg="$1" json="$2" deadline="$3" interval="$4" submission="" status="" code=0 remaining limit pause
  shift 4
  local info_file="$json.info" log_file="$json.log"

  remaining=$((deadline - SECONDS))
  if [ "$remaining" -le 0 ]; then
    echo "::error::No time is left to upload the disk image for notarization."
    return 1
  fi
  notary_bounded "$remaining" "$json" "$@" submit "$dmg" --output-format json || code=$?
  cat "$json" 2> /dev/null || true
  submission="$(notary_field "$json" id || true)"
  if [ "$code" -eq 0 ]; then status="$(notary_field "$json" status || true)"; fi

  if [ -z "$submission" ]; then
    echo "::error::The upload returned no submission id (exit code $code)."
    return 1
  fi
  case "$status" in
    Accepted) return 0 ;;
    Invalid)
      notary_print_log "$submission" "$deadline" "$log_file" "$@"
      echo "::error::Notarization ended with status '$status'."
      return 1
      ;;
  esac
  echo "Submission id: $submission"

  while true; do
    limit="$(notary_request_limit "$deadline")"
    [ "$limit" -gt 0 ] || break
    code=0
    status=""
    notary_bounded "$limit" "$info_file" "$@" info "$submission" --output-format json || code=$?
    if [ "$code" -eq 0 ]; then
      status="$(notary_field "$info_file" status || true)"
    else
      echo "Asking for the status ended with exit code $code."
    fi
    echo "Notarization status: ${status:-unknown}"
    case "$status" in
      Accepted) return 0 ;;
      Invalid)
        cat "$info_file" 2> /dev/null || true
        notary_print_log "$submission" "$deadline" "$log_file" "$@"
        echo "::error::Notarization ended with status '$status'."
        return 1
        ;;
    esac
    pause=$((deadline - SECONDS))
    [ "$pause" -gt 0 ] || break
    if [ "$pause" -gt "$interval" ]; then pause="$interval"; fi
    sleep "$pause"
  done

  echo "::error::Apple had not finished before the time limit. Submission id: $submission"
  echo "The maintainer can run the release workflow again from the same tag once Apple has accepted the submission."
  return 1
}
