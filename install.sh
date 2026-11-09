#!/bin/sh
set -eu

root=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
source_dir="$root/.github/extensions/wayfinder-map"

if [ ! -f "$source_dir/extension.mjs" ]; then
    printf '%s\n' "Cannot find the Wayfinder extension in $source_dir." >&2
    exit 1
fi

if [ -n "${COPILOT_HOME:-}" ]; then
    copilot_home=$COPILOT_HOME
elif [ -n "${HOME:-}" ]; then
    copilot_home=$HOME/.copilot
else
    printf '%s\n' 'Set HOME or COPILOT_HOME before installing.' >&2
    exit 1
fi

target_dir="$copilot_home/extensions/wayfinder-map"
if [ -L "$target_dir" ]; then
    printf '%s\n' "Refusing to modify the symlinked extension directory $target_dir." >&2
    exit 1
fi
mkdir -p "$target_dir"
target_dir=$(CDPATH= cd "$target_dir" && pwd -P)
case "$target_dir/" in
    "$root/"*)
        printf '%s\n' 'The user extension directory must be outside this checkout.' >&2
        exit 1
        ;;
esac

check_destination() {
    check_source=$1
    check_target=$2
    if [ -L "$check_target" ]; then
        if [ "$(readlink "$check_target")" != "$check_source" ]; then
            printf '%s\n' "Refusing to replace an existing link: $check_target" >&2
            exit 1
        fi
    elif [ -e "$check_target" ]; then
        if [ ! -f "$check_target" ] || ! cmp -s "$check_source" "$check_target"; then
            printf '%s\n' "Refusing to replace a different or unreadable file: $check_target" >&2
            exit 1
        fi
    fi
}

# Check every destination before replacing any existing files.
for source in "$source_dir"/*; do
    [ -f "$source" ] || continue
    name=${source##*/}
    check_destination "$source" "$target_dir/$name"
done

pending=
cleanup() {
    if [ -n "$pending" ] && [ -L "$pending" ]; then
        rm -f "$pending"
    fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

for source in "$source_dir"/*; do
    [ -f "$source" ] || continue
    name=${source##*/}
    destination="$target_dir/$name"
    check_destination "$source" "$destination"
    [ ! -L "$destination" ] || continue

    pending="$target_dir/.wayfinder-install-$$-$name"
    if [ -e "$pending" ] || [ -L "$pending" ]; then
        printf '%s\n' "Temporary installation path already exists: $pending" >&2
        exit 1
    fi
    ln -s "$source" "$pending"
    check_destination "$source" "$destination"
    mv -f "$pending" "$destination"
    pending=
done

printf '%s\n' "Wayfinder Map is linked to $source_dir." \
    'Reload Copilot extensions or start a new session to use the checkout.'
