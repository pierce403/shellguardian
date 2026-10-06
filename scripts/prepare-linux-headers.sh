#!/usr/bin/env bash
# Development-only workaround for a Debian/Ubuntu host with GUI runtime packages
# already installed but no permission to install development headers globally.
set -euo pipefail

task_repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
task_sysroot_dir="$task_repo_dir/.cache/native/sysroot"
task_download_dir="$task_repo_dir/.cache/native/debs"
mkdir -p "$task_sysroot_dir" "$task_download_dir"

mapfile -t task_packages < <(apt-get -s install libgtk-3-dev libwebkit2gtk-4.1-dev | awk '$1 == "Inst" { print $2 }')
if (( ${#task_packages[@]} == 0 )); then
  printf '%s\n' 'Development packages are already installed; use the normal native build.'
  exit 0
fi

cd -- "$task_download_dir"
apt-get download "${task_packages[@]}"
for task_archive in "$task_download_dir"/*.deb; do
  dpkg-deb -x "$task_archive" "$task_sysroot_dir"
done

# -dev archives have linker symlinks pointing at already-installed runtime
# libraries. Resolve those missing targets to the corresponding host library.
while IFS= read -r -d '' task_link; do
  task_target=$(realpath -m -- "$task_link")
  case "$task_target" in
    "$task_sysroot_dir"/usr/lib/*)
      task_host_library=${task_target#"$task_sysroot_dir"}
      if [[ -e "$task_host_library" ]]; then
        mkdir -p -- "$(dirname -- "$task_target")"
        ln -s -- "$task_host_library" "$task_target"
      fi
      ;;
  esac
done < <(find "$task_sysroot_dir/usr/lib" -type l ! -exec test -e {} \; -print0)

printf '\n%s\n' 'Headers extracted. For this checkout, use:'
printf 'export PKG_CONFIG_SYSROOT_DIR=%q\n' "$task_sysroot_dir"
printf 'export PKG_CONFIG_PATH=%q\n' "$task_sysroot_dir/usr/lib/x86_64-linux-gnu/pkgconfig:$task_sysroot_dir/usr/lib/pkgconfig:$task_sysroot_dir/usr/share/pkgconfig"
