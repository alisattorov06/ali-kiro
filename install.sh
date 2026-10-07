#!/usr/bin/env bash
#
# ali-kiro installer — one-command install/upgrade for AI coding assistants.
# Supports macOS and Linux. Windows users: use install.ps1 instead.
#
# Strategy (in order):
#   1. Download the architecture-matched prebuilt binary from GitHub Releases
#      into ~/.ali-kiro/bin/ (verified against SHA-256SUMS when present), then
#      exec it with any flags you passed.
#   2. If the binary is unavailable or fails to run, fall back to running
#      `node ali-kiro.mjs` from a source checkout at ~/.ali-kiro/src/.
#   3. If Node.js is missing, automatically install Node.js LTS, then run from
#      source.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/alisattorov06/ali-kiro/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/alisattorov06/ali-kiro/main/install.sh | bash -s -- --yes --only opencode
#   bash install.sh --dry-run
#   bash install.sh --help
#
# Environment overrides (optional):
#   ALI_KIRO_REPO   GitHub repo "owner/repo"      (default: alisattorov06/ali-kiro)
#   ALI_KIRO_HOME   install location              (default: ~/.ali-kiro)
#   ALI_KIRO_OS     force OS: linux | macos
#   ALI_KIRO_ARCH   force arch: x64 | arm64
#   NO_COLOR        set to disable colored output

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

REPO="${ALI_KIRO_REPO:-alisattorov06/ali-kiro}"
GITHUB_URL="https://github.com/${REPO}"
RAW_BASE="https://raw.githubusercontent.com/${REPO}/main"
RELEASES_URL="${GITHUB_URL}/releases/latest/download"

ALI_KIRO_HOME="${ALI_KIRO_HOME:-${HOME}/.ali-kiro}"
BIN_DIR="${ALI_KIRO_HOME}/bin"
SRC_DIR="${ALI_KIRO_HOME}/src"

# Only used when the Node.js LTS metadata endpoint cannot be reached.
NODE_LTS_FALLBACK="22.20.0"
INSTALLER_VERSION="1.0.0"

FLAG_YES=0
FLAG_DRY_RUN=0
TOOL_ARGS=()

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_BLUE=$'\033[1;34m'
  C_YEL=$'\033[1;33m'
  C_RED=$'\033[1;31m'
  C_OFF=$'\033[0m'
else
  C_BLUE=''
  C_YEL=''
  C_RED=''
  C_OFF=''
fi

log()  { printf '%s[ali-kiro]%s %s\n' "${C_BLUE}" "${C_OFF}" "$*"; }
warn() { printf '%s[ali-kiro]%s warning: %s\n' "${C_YEL}" "${C_OFF}" "$*" >&2; }
die()  { printf '%s[ali-kiro]%s error: %s\n' "${C_RED}" "${C_OFF}" "$*" >&2; exit 1; }

usage() {
  cat <<EOF
ali-kiro installer ${INSTALLER_VERSION} — one-command install/upgrade for AI coding assistants.

Usage:
  curl -fsSL https://raw.githubusercontent.com/alisattorov06/ali-kiro/main/install.sh | bash
  bash install.sh [options] [--] [ali-kiro args...]

Options:
  --yes, -y           assume yes (the installer is non-interactive by default)
  --dry-run, -n       print what would be done without changing anything
  --version           print the installer version and exit
  --help, -h          show this help
  --                  treat everything after as ali-kiro arguments

Any other argument is passed through to ali-kiro, e.g.:
  bash install.sh --only opencode --target ~/scratch

Environment:
  ALI_KIRO_REPO    GitHub repo "owner/repo"      (default: alisattorov06/ali-kiro)
  ALI_KIRO_HOME    install location              (default: ~/.ali-kiro)
  ALI_KIRO_OS      force OS: linux | macos
  ALI_KIRO_ARCH    force arch: x64 | arm64
EOF
}

# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------

detect_os() {
  case "$(uname -s)" in
    Linux) echo linux ;;
    Darwin) echo macos ;;
    MINGW*|MSYS*|CYGWIN*) die "Windows detected — use the PowerShell installer instead: https://raw.githubusercontent.com/alisattorov06/ali-kiro/main/install.ps1" ;;
    *) die "unsupported OS: $(uname -s). ali-kiro supports macOS, Linux, and Windows." ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo x64 ;;
    arm64|aarch64) echo arm64 ;;
    *) die "unsupported architecture: $(uname -m). ali-kiro publishes x64 and arm64 builds." ;;
  esac
}

OS="${ALI_KIRO_OS:-$(detect_os)}"
ARCH="${ALI_KIRO_ARCH:-$(detect_arch)}"

# ---------------------------------------------------------------------------
# Small utilities
# ---------------------------------------------------------------------------

has() { command -v "$1" >/dev/null 2>&1; }

# download <url> <dest> — curl first, wget second. Returns non-zero on failure.
download() {
  local url="$1" dest="$2"
  if has curl; then
    curl -fsSL --retry 2 --connect-timeout 15 -o "$dest" "$url"
  elif has wget; then
    wget -q --tries=3 --timeout=15 -O "$dest" "$url"
  else
    return 1
  fi
}

# download_stdout <url> — prints the response body to stdout.
download_stdout() {
  if has curl; then
    curl -fsSL --retry 2 --connect-timeout 15 "$1"
  elif has wget; then
    wget -q --tries=3 --timeout=15 -O - "$1"
  else
    return 1
  fi
}

compute_sha256() {
  local file="$1"
  if has sha256sum; then
    sha256sum "$file" | awk '{print $1}'
  elif has shasum; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    echo ""
  fi
}

print_download_links() {
  echo
  echo "  Neither curl nor wget was found on this system."
  echo
  echo "  Install ali-kiro manually:"
  echo "    1. Download the prebuilt binary:"
  echo "         ${RELEASES_URL}/ali-kiro-${OS}-${ARCH}"
  echo "    2. Make it executable and run it:"
  echo "         chmod +x ali-kiro-${OS}-${ARCH}"
  echo "         ./ali-kiro-${OS}-${ARCH} --help"
  echo
  echo "  Or install curl/wget and re-run this installer."
  echo
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --yes|-y) FLAG_YES=1; shift ;;
      --dry-run|-n|--dryrun) FLAG_DRY_RUN=1; shift ;;
      --version) echo "ali-kiro installer ${INSTALLER_VERSION}"; exit 0 ;;
      --help|-h) usage; exit 0 ;;
      --) shift; TOOL_ARGS+=("$@"); break ;;
      *) TOOL_ARGS+=("$1"); shift ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# Node.js LTS resolution + install
# ---------------------------------------------------------------------------

# latest_lts — resolve the current Node.js LTS version (e.g. 24.8.2) from
# https://nodejs.org/dist/index.json. Falls back to a pinned version.
latest_lts() {
  local json v
  json="$(download_stdout "https://nodejs.org/dist/index.json" 2>/dev/null || true)"
  if [ -n "$json" ]; then
    v="$(printf '%s' "$json" | sed 's/},{/}\n{/g' | grep '"lts":"' | head -1 | sed -n 's/.*"version":"v\([^"]*\)".*/\1/p')"
    if [ -n "$v" ]; then
      printf '%s' "$v"
      return 0
    fi
  fi
  printf '%s' "${NODE_LTS_FALLBACK}"
}

install_node_macos() {
  if has brew; then
    log "installing Node.js via Homebrew (brew install node)"
    if brew install node 2>/dev/null; then
      if ! has node; then
        local brew_prefix
        brew_prefix="$(brew --prefix 2>/dev/null || true)"
        [ -n "$brew_prefix" ] && export PATH="${brew_prefix}/bin:${PATH}"
      fi
      return 0
    fi
    warn "Homebrew install failed — falling back to the official macOS installer."
  fi

  local ver pkg
  ver="$(latest_lts)"
  pkg="${ALI_KIRO_HOME}/node-${ver}.pkg"
  log "Homebrew not found — installing Node.js ${ver} via the official macOS installer (.pkg)"
  mkdir -p "$ALI_KIRO_HOME"
  download "https://nodejs.org/dist/v${ver}/node-v${ver}.pkg" "$pkg" \
    || die "failed to download Node.js (https://nodejs.org/dist/v${ver}/node-v${ver}.pkg). Install it from https://nodejs.org and re-run."
  if has sudo; then
    sudo installer -pkg "$pkg" -target /
  else
    installer -pkg "$pkg" -target /
  fi
  rm -f "$pkg"
  export PATH="/usr/local/bin:${PATH}"
}

install_node_linux_system() { # <prefix> <sudo-cmd>
  local prefix="$1" sudo_cmd="$2"
  log "installing Node.js into /usr/local"
  ${sudo_cmd} rm -rf /usr/local/nodejs
  ${sudo_cmd} mkdir -p /usr/local/nodejs
  ${sudo_cmd} cp -R "${prefix}/." /usr/local/nodejs/
  ${sudo_cmd} ln -sf /usr/local/nodejs/bin/node /usr/local/bin/node
  ${sudo_cmd} ln -sf /usr/local/nodejs/bin/npm  /usr/local/bin/npm
  ${sudo_cmd} ln -sf /usr/local/nodejs/bin/npx  /usr/local/bin/npx
  export PATH="/usr/local/bin:${PATH}"
  rm -rf "$prefix"
}

install_node_linux_tarball() {
  local ver url tarball prefix
  ver="$(latest_lts)"
  url="https://nodejs.org/dist/v${ver}/node-v${ver}-linux-${ARCH}.tar.xz"
  tarball="${ALI_KIRO_HOME}/node-${ver}-linux-${ARCH}.tar.xz"
  prefix="${ALI_KIRO_HOME}/node"
  log "downloading ${url}"
  download "$url" "$tarball" \
    || die "failed to download Node.js (${url}). Install it from https://nodejs.org and re-run."

  rm -rf "$prefix"
  mkdir -p "$prefix"
  tar -xJf "$tarball" -C "$prefix" --strip-components=1
  rm -f "$tarball"

  if [ "$(id -u)" -eq 0 ]; then
    install_node_linux_system "$prefix" ""
    return 0
  fi
  if has sudo && [ -d /usr/local ]; then
    if sudo -n true 2>/dev/null; then
      install_node_linux_system "$prefix" "sudo"
      return 0
    fi
    warn "sudo is not passwordless — using ~/.ali-kiro/node instead of /usr/local"
  fi
  export PATH="${prefix}/bin:${PATH}"
  log "Node.js ready at ${prefix}/bin (add ${prefix}/bin to your shell PATH to use it globally)"
}

install_node_linux() {
  # Preferred: NodeSource setup script on Debian/Ubuntu when sudo is available.
  if has apt-get && has sudo; then
    log "installing Node.js LTS via NodeSource (apt)"
    local setup="${ALI_KIRO_HOME}/nodesource_setup.sh"
    if download "https://deb.nodesource.com/setup_lts.x" "$setup" 2>/dev/null; then
      (sudo -E bash "$setup" >/dev/null 2>&1 || true)
      rm -f "$setup"
      if sudo apt-get install -y nodejs >/dev/null 2>&1; then
        hash -r 2>/dev/null || true
        has node && return 0
      fi
    fi
    warn "NodeSource install failed — falling back to the official binary tarball."
  fi
  install_node_linux_tarball
}

install_node() {
  case "${OS}" in
    macos) install_node_macos ;;
    linux) install_node_linux ;;
  esac
}

# ---------------------------------------------------------------------------
# Prebuilt binary path
# ---------------------------------------------------------------------------

BINARY_NAME_PREFIX="ali-kiro-${OS}-${ARCH}"

# verify_checksum <file> <asset-name> — verify against SHA-256SUMS if the
# release publishes one; skip with a warning when absent.
verify_checksum() {
  local file="$1" asset="$2"
  local sums_url tmp expected actual
  sums_url="${RELEASES_URL}/SHA-256SUMS"
  tmp="${file}.sha256"
  if ! download "$sums_url" "$tmp" 2>/dev/null; then
    warn "SHA-256SUMS not found for this release — skipping checksum verification."
    rm -f "$tmp"
    return 0
  fi
  if ! has sha256sum && ! has shasum; then
    warn "no sha256 tool available — skipping checksum verification."
    rm -f "$tmp"
    return 0
  fi
  expected="$(awk -v a="$asset" '$2==a {print $1}' "$tmp" | head -1)"
  if [ -z "$expected" ]; then
    warn "no checksum entry for ${asset} in SHA-256SUMS — skipping verification."
    rm -f "$tmp"
    return 0
  fi
  actual="$(compute_sha256 "$file")"
  if [ -z "$actual" ] || [ "$actual" != "$expected" ]; then
    warn "checksum mismatch for ${asset}."
    warn "  expected: ${expected}"
    warn "  actual:   ${actual:-<unavailable>}"
    rm -f "$tmp"
    return 1
  fi
  log "checksum OK (${actual:0:16}…)"
  rm -f "$tmp"
  return 0
}

# install_binary — download + verify + chmod +x the prebuilt binary.
install_binary() {
  if ! has curl && ! has wget; then
    print_download_links
    return 1
  fi
  mkdir -p "$BIN_DIR"
  local name="${BINARY_NAME_PREFIX}"
  local url="${RELEASES_URL}/${name}"
  local tmp="${BIN_DIR}/.${name}.tmp"
  rm -f "$tmp"
  log "downloading ${url}"
  if ! download "$url" "$tmp"; then
    warn "binary download failed (${url}) — the release may not be published for ${OS}-${ARCH} yet; falling back to source."
    rm -f "$tmp"
    return 1
  fi
  if [ ! -s "$tmp" ]; then
    warn "downloaded file was empty — falling back to source."
    rm -f "$tmp"
    return 1
  fi
  if ! verify_checksum "$tmp" "$name"; then
    warn "checksum verification failed — not using the downloaded binary."
    rm -f "$tmp"
    return 1
  fi
  chmod +x "$tmp"
  mv -f "$tmp" "${BIN_DIR}/${name}"
  BIN_PATH="${BIN_DIR}/${name}"

  # Assets bundle: release binaries ship without embedded assets, so fetch the
  # assets archive alongside the binary and extract it into BIN_DIR — assets/
  # then sits beside the binary (see src/core/assets.mjs probe (c)). At runtime
  # ALI_KIRO_ASSETS can point the binary at a different assets location.
  local assets_url="${RELEASES_URL}/ali-kiro-assets.tar.gz"
  local assets_tmp="${BIN_DIR}/.ali-kiro-assets.tar.gz.tmp"
  rm -f "$assets_tmp"
  log "downloading ${assets_url}"
  if download "$assets_url" "$assets_tmp" && [ -s "$assets_tmp" ]; then
    if tar xzf "$assets_tmp" -C "$BIN_DIR"; then
      rm -f "$assets_tmp"
      log "assets ready at ${BIN_DIR}/assets"
    else
      rm -f "$assets_tmp"
      warn "assets bundle extraction failed — continuing with the binary only."
    fi
  else
    rm -f "$assets_tmp"
    warn "assets bundle download failed (${assets_url}) — continuing with the binary only."
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Source fallback (node ali-kiro.mjs)
# ---------------------------------------------------------------------------

ensure_source() {
  mkdir -p "$ALI_KIRO_HOME"
  if has git; then
    if [ -d "${SRC_DIR}/.git" ]; then
      log "updating existing source checkout at ${SRC_DIR}"
      if (cd "$SRC_DIR" && git fetch --depth 1 origin main && git reset --hard origin/main) >/dev/null 2>&1; then
        return 0
      fi
      warn "could not update the existing checkout — using what is already there."
      return 0
    fi
    rm -rf "$SRC_DIR"
    log "cloning ${GITHUB_URL} into ${SRC_DIR}"
    git clone --depth 1 "https://github.com/${REPO}.git" "$SRC_DIR" \
      || die "failed to clone ${REPO}. Check your network connection and re-run."
    return 0
  fi

  # No git: extract the tarball.
  if [ -f "${SRC_DIR}/ali-kiro.mjs" ]; then
    log "using existing source at ${SRC_DIR} (install git to enable updates)"
    return 0
  fi
  if ! has curl && ! has wget; then
    print_download_links
    return 1
  fi
  local tarball="${ALI_KIRO_HOME}/ali-kiro-main.tar.gz"
  log "git not found — downloading the source tarball instead"
  rm -f "$tarball"
  download "https://codeload.github.com/${REPO}/tar.gz/refs/heads/main" "$tarball" \
    || die "failed to download the source tarball (https://codeload.github.com/${REPO}/tar.gz/refs/heads/main)."
  rm -rf "$SRC_DIR"
  mkdir -p "$SRC_DIR"
  tar -xzf "$tarball" -C "$SRC_DIR" --strip-components=1
  rm -f "$tarball"
  return 0
}

# launch_exec <command> [args...] — exec the tool, attaching a TTY when the
# installer itself was piped in (e.g. `curl … | bash`) so interactive UIs work.
launch_exec() {
  local cmd="$1"; shift
  if [ -t 0 ] || [ ! -e /dev/tty ]; then
    exec "$cmd" "$@"
  else
    exec "$cmd" "$@" </dev/tty
  fi
}

install_from_source() {
  if ! has node; then
    log "Node.js was not found — installing Node.js LTS for ${OS}-${ARCH}."
    install_node || die "could not install Node.js. Install it from https://nodejs.org and re-run the installer."
    hash -r 2>/dev/null || true
  fi
  if ! has node; then
    die "Node.js is still unavailable after the install attempt. Install it from https://nodejs.org and re-run."
  fi
  local node_ver
  node_ver="$(node --version 2>/dev/null || echo 'unknown')"
  log "using node ${node_ver}"
  case "${node_ver}" in
    unknown|v0.*|v1[0-7].*)
      warn "ali-kiro requires Node.js >= 18; you have ${node_ver}. Install a newer Node.js LTS and re-run." ;;
  esac

  if ! ensure_source; then
    die "could not obtain the ali-kiro source. See the links above and install manually."
  fi
  if [ ! -f "${SRC_DIR}/ali-kiro.mjs" ]; then
    die "ali-kiro.mjs not found after fetching the source — is ${REPO} ready?"
  fi
  log "launching ali-kiro from source"
  cd "$SRC_DIR"
  launch_exec node ali-kiro.mjs ${TOOL_ARGS[@]+"${TOOL_ARGS[@]}"}
  die "could not launch ali-kiro from source"
}

# ---------------------------------------------------------------------------
# Dry run
# ---------------------------------------------------------------------------

plan() {
  echo
  echo "ali-kiro installer ${INSTALLER_VERSION} — dry run (nothing will be changed)"
  echo
  echo "  Home directory : ${ALI_KIRO_HOME}"
  echo "  Platform       : ${OS}-${ARCH}"
  if has node; then
    echo "  Node.js        : $(node --version 2>/dev/null || echo 'found')"
  else
    echo "  Node.js        : not found (would auto-install Node.js LTS)"
  fi
  if has curl; then echo "  Downloader     : curl"; elif has wget; then echo "  Downloader     : wget"; else echo "  Downloader     : none (would print manual download links)"; fi
  if has git; then echo "  Git            : yes"; else echo "  Git            : no (would use the source tarball)"; fi
  echo
  echo "  Planned steps:"
  echo "    1. Download the prebuilt binary from:"
  echo "         ${RELEASES_URL}/ali-kiro-${OS}-${ARCH}"
  echo "       into ${BIN_DIR}/ (verified against SHA-256SUMS when present)."
  echo "       Then download and extract ali-kiro-assets.tar.gz into ${BIN_DIR}/assets beside the binary."
  if ! { has curl || has wget; }; then
    echo "       (skipped: no curl/wget — manual download links would be printed instead)"
  fi
  echo "    2. Launch ali-kiro with arguments: $(printf '%s ' ${TOOL_ARGS[@]+"${TOOL_ARGS[@]}"})"
  echo "       (if the binary is unavailable or fails to run, fall back to 'node ali-kiro.mjs' from ${SRC_DIR})"
  if ! has node; then
    echo "       (Node.js is missing — the installer would install Node.js LTS first)"
  fi
  echo
  echo "  Nothing was installed or modified."
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

BIN_PATH=""

main() {
  parse_args "$@"
  log "ali-kiro installer ${INSTALLER_VERSION} for ${OS}-${ARCH}"
  [ "$FLAG_YES" -eq 1 ] && log "--yes set: proceeding automatically"

  if [ "$FLAG_DRY_RUN" -eq 1 ]; then
    plan
    exit 0
  fi

  if install_binary; then
    log "prebuilt binary ready at ${BIN_PATH}"
    log "launching ali-kiro…"
    launch_exec "${BIN_PATH}" ${TOOL_ARGS[@]+"${TOOL_ARGS[@]}"} \
      || warn "failed to execute the prebuilt binary — falling back to source."
  fi

  install_from_source
  die "unexpected: install_from_source returned without launching ali-kiro"
}

main "$@"