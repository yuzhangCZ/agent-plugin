#!/usr/bin/env bash
set -euo pipefail

OPENCODE_SERVER_PORT="${OPENCODE_SERVER_PORT:-4096}"
TMP_DIR=""
LISTEN_PORTS_FILE=""
SERVER_PORTS_FILE=""
CONNECTED_PIDS_FILE=""
CLEANED_PORTS_FILE=""
CLEANED_PIDS_FILE=""

CLEANUP_REASON=""

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "${value}"
}

describe_pid() {
  local pid="$1"
  ps -p "${pid}" -o command= 2>/dev/null || true
}

resolve_listen_ports() {
  local pid="$1"
  if [[ -z "${LISTEN_PORTS_FILE}" || ! -f "${LISTEN_PORTS_FILE}" ]]; then
    return 0
  fi

  awk -F '\t' -v pid="${pid}" '$1 == pid { print $2; exit }' "${LISTEN_PORTS_FILE}"
}

has_listen_ports() {
  local pid="$1"
  [[ -n "$(resolve_listen_ports "${pid}")" ]]
}

is_numeric_port() {
  local value="$1"
  [[ "${value}" =~ ^[0-9]+$ ]]
}

collect_listening_ports() {
  [[ -n "${LISTEN_PORTS_FILE}" ]] || return 1

  : > "${LISTEN_PORTS_FILE}"
  while IFS=$'\t' read -r pid port_list; do
    [[ -z "${pid}" ]] && continue
    port_list="$(trim "${port_list}")"
    [[ -z "${port_list}" ]] && continue
    printf '%s\t%s\n' "${pid}" "${port_list}" >> "${LISTEN_PORTS_FILE}"
  done < <(
    lsof -nP -iTCP -sTCP:LISTEN -F pn 2>/dev/null | awk '
      BEGIN {
        pid = ""
      }
      /^p/ {
        pid = substr($0, 2)
        next
      }
      /^n/ {
        if (pid == "") {
          next
        }
        split(substr($0, 2), parts, ":")
        port = parts[length(parts)]
        if (ports[pid] == "") {
          ports[pid] = port
        } else {
          ports[pid] = ports[pid] "," port
        }
      }
      END {
        for (pid in ports) {
          print pid "\t" ports[pid]
        }
      }
    ' | sort -u
  )
}

is_explicitly_excluded_command() {
  local command="$1"
  [[ "${command}" =~ (^|[[:space:]\/])opencode[[:space:]]+auth[[:space:]]+login([[:space:]]|$) ]] && return 0
  return 1
}

is_service_command() {
  local command="$1"
  [[ "${command}" =~ (^|[[:space:]\/])opencode-server([[:space:]]|$) ]] && return 0
  [[ "${command}" =~ (^|[[:space:]\/])opencode([[:space:]]|$) ]] && [[ "${command}" =~ (^|[[:space:]])serve([[:space:]]|$) ]] && return 0
  return 1
}

is_local_attach_command() {
  local command="$1"
  if [[ ! "${command}" =~ (^|[[:space:]\/])opencode([[:space:]]|$) ]]; then
    return 1
  fi
  if [[ ! "${command}" =~ (^|[[:space:]])attach([[:space:]]|$) ]]; then
    return 1
  fi

  [[ "${command}" =~ https?://(localhost|127\.0\.0\.1)(:[0-9]+)?([/?[:space:]]|$) ]]
}

is_opencode_command() {
  local command="$1"
  [[ "${command}" =~ (^|[[:space:]\/])opencode([[:space:]]|$) ]] && return 0
  [[ "${command}" =~ (^|[[:space:]\/])opencode-server([[:space:]]|$) ]] && return 0
  return 1
}

should_cleanup_process() {
  local pid="$1"
  local command="$2"
  local state="${3:-}"
  CLEANUP_REASON=""

  if [[ "${pid}" == "$$" || "${pid}" == "${PPID:-}" ]]; then
    return 1
  fi

  if ! is_opencode_command "${command}"; then
    return 1
  fi

  if is_explicitly_excluded_command "${command}"; then
    return 1
  fi

  if is_service_command "${command}"; then
    CLEANUP_REASON="server"
    return 0
  fi

  if [[ "${state}" == T* ]]; then
    CLEANUP_REASON="suspended-client"
    return 0
  fi

  if is_local_attach_command "${command}"; then
    CLEANUP_REASON="attach"
    return 0
  fi

  if is_connected_to_local_server "${pid}"; then
    CLEANUP_REASON="connected-client"
    return 0
  fi

  return 1
}

kill_pid_gracefully() {
  local pid="$1"
  if ! kill -0 "${pid}" >/dev/null 2>&1; then
    return 0
  fi

  kill "${pid}" >/dev/null 2>&1 || true
  sleep 1
  if kill -0 "${pid}" >/dev/null 2>&1; then
    kill -9 "${pid}" >/dev/null 2>&1 || true
  fi
}

collect_candidate_processes() {
  collect_listening_ports
  collect_server_ports
  collect_connected_pids

  ps -axo pid=,ppid=,pgid=,state=,command= | awk '
    {
      pid = $1
      ppid = $2
      pgid = $3
      state = $4
      $1 = ""
      $2 = ""
      $3 = ""
      $4 = ""
      sub(/^[[:space:]]+/, "", $0)
      print pid "\t" ppid "\t" pgid "\t" state "\t" $0
    }
  '
}

collect_residual_processes() {
  ps -axo pid=,ppid=,pgid=,state=,command= | awk '
    {
      pid = $1
      ppid = $2
      pgid = $3
      state = $4
      $1 = ""
      $2 = ""
      $3 = ""
      $4 = ""
      sub(/^[[:space:]]+/, "", $0)
      print pid "\t" ppid "\t" pgid "\t" state "\t" $0
    }
  '
}

collect_server_ports() {
  [[ -n "${SERVER_PORTS_FILE}" ]] || return 1
  : > "${SERVER_PORTS_FILE}"

  if is_numeric_port "${OPENCODE_SERVER_PORT}"; then
    printf '%s\n' "${OPENCODE_SERVER_PORT}" >> "${SERVER_PORTS_FILE}"
  fi

  local pid command ports port
  while IFS=$'\t' read -r pid command; do
    [[ -z "${pid}" ]] && continue
    command="$(trim "${command}")"
    if ! is_service_command "${command}"; then
      continue
    fi

    ports="$(resolve_listen_ports "${pid}")"
    [[ -z "${ports}" ]] && continue
    IFS=',' read -r -a port_list <<< "${ports}"
    for port in "${port_list[@]}"; do
      port="$(trim "${port}")"
      if is_numeric_port "${port}"; then
        printf '%s\n' "${port}" >> "${SERVER_PORTS_FILE}"
      fi
    done
  done < <(
    ps -axo pid=,command= | awk '
      {
        pid = $1
        $1 = ""
        sub(/^[[:space:]]+/, "", $0)
        print pid "\t" $0
      }
    '
  )

  if [[ -s "${SERVER_PORTS_FILE}" ]]; then
    sort -u "${SERVER_PORTS_FILE}" -o "${SERVER_PORTS_FILE}"
  fi
}

collect_connected_pids() {
  [[ -n "${CONNECTED_PIDS_FILE}" ]] || return 1
  : > "${CONNECTED_PIDS_FILE}"

  if [[ -z "${SERVER_PORTS_FILE}" || ! -s "${SERVER_PORTS_FILE}" ]]; then
    return 0
  fi

  local port
  while IFS= read -r port; do
    port="$(trim "${port}")"
    [[ -z "${port}" ]] && continue
    if ! is_numeric_port "${port}"; then
      continue
    fi
    lsof -nP -iTCP:"${port}" -F p 2>/dev/null | awk '
      /^p/ {
        pid = substr($0, 2)
        if (pid != "") {
          print pid
        }
      }
    ' >> "${CONNECTED_PIDS_FILE}"
  done < "${SERVER_PORTS_FILE}"

  if [[ -s "${CONNECTED_PIDS_FILE}" ]]; then
    sort -u "${CONNECTED_PIDS_FILE}" -o "${CONNECTED_PIDS_FILE}"
  fi
}

is_connected_to_local_server() {
  local pid="$1"
  if [[ -z "${CONNECTED_PIDS_FILE}" || ! -f "${CONNECTED_PIDS_FILE}" ]]; then
    return 1
  fi

  grep -Fxq "${pid}" "${CONNECTED_PIDS_FILE}"
}

main() {
  local matched=0
  local cleaned_server=0
  local cleaned_attach=0
  local cleaned_connected_client=0
  local cleaned_suspended_client=0
  local pid ppid pgid state command ports cleanup_key cleanup_reason
  local residual=0

  TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cleanup-opencode-local.XXXXXX")"
  LISTEN_PORTS_FILE="${TMP_DIR}/listen-ports.tsv"
  SERVER_PORTS_FILE="${TMP_DIR}/server-ports.txt"
  CONNECTED_PIDS_FILE="${TMP_DIR}/connected-pids.txt"
  CLEANED_PORTS_FILE="${TMP_DIR}/cleaned-ports.txt"
  CLEANED_PIDS_FILE="${TMP_DIR}/cleaned-pids.txt"
  trap 'rm -rf "${TMP_DIR}"' EXIT

  while IFS=$'\t' read -r pid ppid pgid state command; do
    [[ -z "${pid}" ]] && continue
    command="$(trim "${command}")"
    [[ -z "${command}" ]] && continue

    if ! should_cleanup_process "${pid}" "${command}" "${state}"; then
      continue
    fi
    cleanup_reason="${CLEANUP_REASON}"
    [[ -n "${cleanup_reason}" ]] || cleanup_reason="unknown"

    cleanup_key="pid:${pid}"
    if [[ -f "${CLEANED_PIDS_FILE}" ]] && grep -Fxq "${cleanup_key}" "${CLEANED_PIDS_FILE}"; then
      continue
    fi

    ports="$(resolve_listen_ports "${pid}")"
    echo "[cleanup] stop opencode local process (reason=${cleanup_reason}, pid=${pid}, ppid=${ppid}, pgid=${pgid:-n/a}, state=${state:-n/a}${ports:+, ports=${ports}})"
    echo "          ${command}"
    kill_pid_gracefully "${pid}"
    printf '%s\n' "${cleanup_key}" >> "${CLEANED_PIDS_FILE}"
    if [[ "${cleanup_reason}" == "server" ]]; then
      cleaned_server=$((cleaned_server + 1))
    elif [[ "${cleanup_reason}" == "suspended-client" ]]; then
      cleaned_suspended_client=$((cleaned_suspended_client + 1))
    elif [[ "${cleanup_reason}" == "attach" ]]; then
      cleaned_attach=$((cleaned_attach + 1))
    elif [[ "${cleanup_reason}" == "connected-client" ]]; then
      cleaned_connected_client=$((cleaned_connected_client + 1))
    fi
    if [[ -n "${ports}" ]]; then
      local port
      IFS=',' read -r -a port_list <<< "${ports}"
      for port in "${port_list[@]}"; do
        [[ -z "${port}" ]] && continue
        if [[ ! -f "${CLEANED_PORTS_FILE}" ]] || ! grep -Fxq "${port}" "${CLEANED_PORTS_FILE}"; then
          printf '%s\n' "${port}" >> "${CLEANED_PORTS_FILE}"
        fi
      done
    fi
    matched=$((matched + 1))
  done < <(collect_candidate_processes)

  if [[ "${matched}" == "0" ]]; then
    echo "[cleanup] no stale opencode local service process found"
    return 0
  fi

  while IFS=$'\t' read -r pid ppid pgid state command; do
    [[ -z "${pid}" ]] && continue
    command="$(trim "${command}")"
    [[ -z "${command}" ]] && continue
    if ! should_cleanup_process "${pid}" "${command}" "${state}"; then
      continue
    fi

    ports="$(resolve_listen_ports "${pid}")"
    echo "[cleanup] residual opencode local service process remains (pid=${pid}, ppid=${ppid}, pgid=${pgid:-n/a}, state=${state:-n/a}${ports:+, ports=${ports}})" >&2
    echo "          ${command}" >&2
    residual=$((residual + 1))
  done < <(collect_residual_processes)

  if [[ "${residual}" != "0" ]]; then
    echo "[cleanup] failed to fully remove opencode local service process(es): ${residual}" >&2
    return 1
  fi

  local cleaned_ports=0
  if [[ -f "${CLEANED_PORTS_FILE}" ]]; then
    cleaned_ports="$(wc -l < "${CLEANED_PORTS_FILE}" | tr -d '[:space:]')"
    cleaned_ports="${cleaned_ports:-0}"
  fi
  echo "[cleanup] removed ${matched} opencode local process(es) [server=${cleaned_server}, suspended-client=${cleaned_suspended_client}, attach=${cleaned_attach}, connected-client=${cleaned_connected_client}], ${cleaned_ports} listening port(s)"
}

main "$@"
