#!/usr/bin/env bash
# ShellGuardian's per-user Linux installer. No sudo, OpenShell changes, or agent state.
set -euo pipefail

fail() { printf 'ShellGuardian: %s\n' "$*" >&2; exit 1; }
usage() {
  printf '%s\n' 'Usage: bash install.sh [--version X.Y.Z] [--no-desktop]' \
    'Installs the stable Linux x86_64 AppImage into your user account.' \
    'Automatic signed app updates default to on; change this in app settings.' \
    'SHELLGUARDIAN_INSTALL_DIR and SHELLGUARDIAN_BIN_DIR override user install paths.'
}

version=''
desktop=1
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) [ "$#" -ge 2 ] || fail '--version needs X.Y.Z'; version="$2"; shift 2 ;;
    --no-desktop) desktop=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done
[ "$(id -u)" != 0 ] || fail 'Run as your ordinary user, not root. No sudo is needed.'
[ "$(uname -s)" = Linux ] || fail 'This release supports Linux only. See the website for platform status.'
case "$(uname -m)" in x86_64|amd64) ;; *) fail 'This release requires Linux x86_64.' ;; esac
for dependency in curl sha256sum mktemp install; do
  command -v "$dependency" >/dev/null 2>&1 || fail "Install $dependency first."
done
[ -n "${HOME:-}" ] || fail 'Your home directory is not set.'
install_dir="${SHELLGUARDIAN_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/shellguardian}"
bin_dir="${SHELLGUARDIAN_BIN_DIR:-$HOME/.local/bin}"
desktop_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
for directory in "$install_dir" "$bin_dir" "$desktop_dir"; do
  [[ "$directory" =~ ^/[A-Za-z0-9_./\ -]+$ ]] && [ "$directory" != / ] \
    || fail 'Install paths must be absolute and use letters, digits, spaces, ., /, _, or -.'
done
[ "$install_dir" != "$bin_dir" ] || fail 'Use separate application and launcher directories.'

task_tmp=$(mktemp -d)
staged=''
cleanup() { [ -z "$staged" ] || rm -f -- "$staged"; rm -rf -- "$task_tmp"; }
trap cleanup EXIT
fetch() {
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --tlsv1.2 --retry 2 --connect-timeout 10 --max-time 180 "$1" --output "$2"
}
repo='https://github.com/pierce403/shellguardian/releases'
if [ -z "$version" ]; then
  fetch "$repo/latest/download/version.txt" "$task_tmp/version.txt"
  [ "$(wc -c < "$task_tmp/version.txt")" -le 32 ] || fail 'Invalid release version.'
  version=$(tr -d '\r\n' < "$task_tmp/version.txt")
fi
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'Only stable X.Y.Z release versions are accepted.'
asset="ShellGuardian_${version}_amd64.AppImage"
base="$repo/download/v$version"
printf 'Downloading ShellGuardian %s for Linux x86_64…\n' "$version"
fetch "$base/$asset" "$task_tmp/$asset"
fetch "$base/SHA256SUMS" "$task_tmp/SHA256SUMS"
[ "$(wc -c < "$task_tmp/SHA256SUMS")" -le 65536 ] || fail 'Invalid checksum manifest.'
checksum=$(awk -v name="$asset" '$2 == name { print $1 }' "$task_tmp/SHA256SUMS")
[[ "$checksum" =~ ^[a-f0-9]{64}$ ]] || fail 'Release is missing a unique valid SHA256 checksum.'
actual=$(sha256sum "$task_tmp/$asset")
[ "${actual%% *}" = "$checksum" ] || fail 'Checksum mismatch. Nothing was installed.'

appimage="$install_dir/ShellGuardian.AppImage"
launcher="$bin_dir/shellguardian"
marker="$install_dir/.shellguardian-install"
[ ! -L "$appimage" ] && [ ! -L "$launcher" ] || fail 'Refusing to replace a symbolic link.'
if [ -e "$appimage" ] && [ ! -f "$marker" ]; then fail 'This path contains an unmanaged app. Choose another install directory.'; fi
if [ -e "$launcher" ] && ! head -n 3 "$launcher" | grep -Fq '# ShellGuardian managed launcher'; then
  fail 'A different shellguardian launcher already exists. Choose another bin directory.'
fi
mkdir -p -- "$install_dir" "$bin_dir"
# Stage on the same filesystem so replacement is atomic. Retain one rollback copy.
staged=$(mktemp "$install_dir/.ShellGuardian.XXXXXXXX")
install -m 755 "$task_tmp/$asset" "$staged"
if [ -f "$appimage" ]; then cp -p -- "$appimage" "$install_dir/ShellGuardian.previous.AppImage"; fi
mv -f -- "$staged" "$appimage"
staged=''
printf '%s\n' "$version" > "$marker"
{
  printf '%s\n' '#!/usr/bin/env bash' '# ShellGuardian managed launcher' \
    '# Extraction avoids requiring FUSE; OpenShell stays untouched.'
  printf 'export APPIMAGE_EXTRACT_AND_RUN=1\nexec %q "$@"\n' "$appimage"
} > "$task_tmp/launcher"
install -m 755 "$task_tmp/launcher" "$launcher"
if [ "$desktop" = 1 ]; then
  mkdir -p -- "$desktop_dir"
  printf '[Desktop Entry]\nType=Application\nName=ShellGuardian\nComment=Control room for NVIDIA OpenShell agents\nExec="%s"\nTerminal=false\nCategories=Development;Utility;\n' \
    "$launcher" > "$task_tmp/shellguardian.desktop"
  install -m 644 "$task_tmp/shellguardian.desktop" "$desktop_dir/bot.recurse.shellguardian.desktop"
fi
printf '\nInstalled %s\nLaunch: %s\n' "$appimage" "$launcher"
case ":${PATH:-}:" in *":$bin_dir:"*) ;; *) printf 'Add %s to your PATH to use the shellguardian command.\n' "$bin_dir" ;; esac
printf '%s\n' 'Automatic signed ShellGuardian updates are ON by default. Turn them off in OpenShell & settings.' \
  'OpenShell must already be installed and configured. This installer never installs or upgrades it.' \
  'Linux requires GTK 3 and WebKitGTK 4.1 runtime libraries. See the website for prerequisites.'
