#!/usr/bin/env bash
set -euo pipefail

OPENCODE_SERVER_PORT="${OPENCODE_SERVER_PORT:-54321}"
TMP_DIR=""
LISTEN_PORTS_FILE=""
CLEANED_GROUPS_FILE=""
CLEANED_PORTS_FILE=""

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

is_opencode_command() {
  local command="$1"
  [[ "${command}" =~ (^|[[:space:]\/])opencode([[:space:]]|$) ]] && return 0
  [[ "${command}" =~ (^|[[:space:]\/])opencode-server([[:space:]]|$) ]] && return 0
  return 1
}

should_cleanup_process() {
  local pid="$1"
  local command="$2"

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
    return 0
  fi

  if has_listen_ports "${pid}"; then
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

kill_process_group_gracefully() {
  local pgid="$1"
  [[ -z "${pgid}" ]] && return 1
  if ! kill -0 "-${pgid}" >/dev/null 2>&1; then
    return 1
  fi

  kill "-${pgid}" >/dev/null 2>&1 || true
  sleep 1
  if kill -0 "-${pgid}" >/dev/null 2>&1; then
    kill -9 "-${pgid}" >/dev/null 2>&1 || true
  fi
  return 0
}

collect_candidate_processes() {
  collect_listening_ports

  ps -axo pid=,ppid=,pgid=,command= | awk '
    {
      pid = $1
      ppid = $2
      pgid = $3
      $1 = ""
      $2 = ""
      $3 = ""
      sub(/^[[:space:]]+/, "", $0)
      print pid "\t" ppid "\t" pgid "\t" $0
    }
  '
}

collect_residual_processes() {
  ps -axo pid=,ppid=,pgid=,command= | awk '
    {
      pid = $1
      ppid = $2
      pgid = $3
      $1 = ""
      $2 = ""
      $3 = ""
      sub(/^[[:space:]]+/, "", $0)
      print pid "\t" ppid "\t" pgid "\t" $0
    }
  '
}

main() {
  local matched=0
  local cleaned_process_groups=0
  local pid ppid pgid command ports cleanup_key
  local residual=0

  TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cleanup-opencode-local.XXXXXX")"
  LISTEN_PORTS_FILE="${TMP_DIR}/listen-ports.tsv"
  CLEANED_GROUPS_FILE="${TMP_DIR}/cleaned-groups.txt"
  CLEANED_PORTS_FILE="${TMP_DIR}/cleaned-ports.txt"
  trap 'rm -rf "${TMP_DIR}"' EXIT

  while IFS=$'\t' read -r pid ppid pgid command; do
    [[ -z "${pid}" ]] && continue
    command="$(trim "${command}")"
    [[ -z "${command}" ]] && continue

    if ! should_cleanup_process "${pid}" "${command}"; then
      continue
    fi

    cleanup_key="pid:${pid}"
    if [[ -n "${pgid}" && "${pgid}" != "0" ]]; then
      cleanup_key="pgid:${pgid}"
    fi
    if [[ -f "${CLEANED_GROUPS_FILE}" ]] && grep -Fxq "${cleanup_key}" "${CLEANED_GROUPS_FILE}"; then
      continue
    fi

    ports="$(resolve_listen_ports "${pid}")"
    echo "[cleanup] stop opencode local service process (pid=${pid}, ppid=${ppid}, pgid=${pgid:-n/a}${ports:+, ports=${ports}})"
    echo "          ${command}"
    if [[ -n "${pgid}" && "${pgid}" != "0" ]]; then
      if kill_process_group_gracefully "${pgid}"; then
        printf '%s\n' "${cleanup_key}" >> "${CLEANED_GROUPS_FILE}"
        cleaned_process_groups=$((cleaned_process_groups + 1))
      else
        kill_pid_gracefully "${pid}"
      fi
    else
      kill_pid_gracefully "${pid}"
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

  while IFS=$'\t' read -r pid ppid pgid command; do
    [[ -z "${pid}" ]] && continue
    command="$(trim "${command}")"
    [[ -z "${command}" ]] && continue
    if ! should_cleanup_process "${pid}" "${command}"; then
      continue
    fi

    ports="$(resolve_listen_ports "${pid}")"
    echo "[cleanup] residual opencode local service process remains (pid=${pid}, ppid=${ppid}, pgid=${pgid:-n/a}${ports:+, ports=${ports}})" >&2
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
  echo "[cleanup] removed ${matched} opencode local service process(es), ${cleaned_process_groups} process group(s), ${cleaned_ports} listening port(s)"
}

main "$@"
