#!/usr/bin/env bash
# The single local-repo script:
#   1. repo folder /srv/alpha-repo — world-traversable, because pacman downloads
#      as DownloadUser = alpm and cannot enter a 0700 home directory
#   2. publishes the built package into the alpha-local.db database (the name
#      must match the [alpha-local] section; pacman 7 also requires the
#      file:// scheme in Server, a bare path gives "url ... is invalid")
#   3. cleans superseded packages (repo + project root) and old AppImages
#   4. registers / repairs [alpha-local] in /etc/pacman.conf (sudo)
#   5. syncs the pacman databases (sudo)
#
# Runs from any directory. For tests: ALPHA_REPO_DIR=/tmp/x ./local-repo.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="${ALPHA_REPO_DIR:-/srv/alpha-repo}"
OLD_REPO="$HOME/projects/alpha-repo"
REPO_NAME="alpha-local" # must match the [section] in /etc/pacman.conf
DB_FILE="$REPO_DIR/$REPO_NAME.db.tar.gz"
VERSION="$(node -p "require('$ROOT/package.json').version")"

sudo_available() { [ -t 0 ] || sudo -n true 2>/dev/null; }

# 1) the folder must exist and belong to us, so later publishes stay passwordless
if ! mkdir -p "$REPO_DIR" 2>/dev/null; then
  if sudo_available; then
    sudo mkdir -p "$REPO_DIR"
    sudo chown "$(id -u):$(id -g)" "$REPO_DIR"
    echo "created $REPO_DIR (owned by you)"
  else
    echo "cannot create $REPO_DIR — run this script once from a terminal (sudo password needed)" >&2
    exit 1
  fi
fi

# migrate packages from the old home-based repo (the alpm user cannot read ~)
if [ -d "$OLD_REPO" ] && [ "$(readlink -f "$OLD_REPO")" != "$(readlink -f "$REPO_DIR")" ]; then
  find "$OLD_REPO" -maxdepth 1 -name 'alpha-*.pkg.tar.zst' -exec cp -f {} "$REPO_DIR/" \; 2>/dev/null || true
fi

# 2) publish: the current version wins, the database always ends up on disk
shopt -s nullglob
PUBLISHED=0
ROOT_PKGS=("$ROOT"/alpha-"$VERSION"-*.pkg.tar.zst)
if [ "${#ROOT_PKGS[@]}" -gt 0 ]; then
  cp -f "${ROOT_PKGS[@]}" "$REPO_DIR/"
fi
CUR_PKGS=("$REPO_DIR"/alpha-"$VERSION"-*.pkg.tar.zst)
if [ "${#CUR_PKGS[@]}" -gt 0 ]; then
  # prune other versions first so disk and database agree, then rebuild
  find "$REPO_DIR" -maxdepth 1 -name 'alpha-*.pkg.tar.zst' ! -name "alpha-$VERSION-*" -delete
  (
    cd "$REPO_DIR"
    repo-add -R "$DB_FILE" "$(basename "${CUR_PKGS[0]}")"
  )
  PUBLISHED=1
elif [ -f "$REPO_DIR/$REPO_NAME.db" ]; then
  echo "no package for $VERSION — keeping the published one"
else
  ANY_PKGS=("$REPO_DIR"/alpha-*.pkg.tar.zst)
  if [ "${#ANY_PKGS[@]}" -eq 0 ]; then
    echo "no packages in $REPO_DIR — run 'npm run pkg' first" >&2
    exit 1
  fi
  (
    cd "$REPO_DIR"
    names=()
    for f in *.pkg.tar.zst; do names+=("$f"); done
    repo-add -R "$DB_FILE" "${names[@]}"
  )
  echo "database restored from the migrated packages"
fi

# 3) leftovers: repo-add backups and the old alpha.db names
rm -f "$REPO_DIR"/*.old \
      "$REPO_DIR"/alpha.db "$REPO_DIR"/alpha.db.tar.gz \
      "$REPO_DIR"/alpha.files "$REPO_DIR"/alpha.files.tar.gz

# after a successful publish drop superseded versions everywhere:
# in the repo, in the project root, AppImages, and the old home-based repo
if [ "$PUBLISHED" = "1" ]; then
  find "$ROOT" -maxdepth 1 -name 'alpha-*.pkg.tar.zst' ! -name "alpha-$VERSION-*" -delete
  find "$ROOT/dist" -maxdepth 1 -name 'Alpha-*.AppImage' -delete 2>/dev/null || true
  if [ -z "${ALPHA_REPO_DIR:-}" ] && [ -d "$OLD_REPO" ] && [ -f "$REPO_DIR/$REPO_NAME.db" ]; then
    rm -rf "$OLD_REPO"
    echo "removed the old repo folder $OLD_REPO (migrated to $REPO_DIR)"
  fi
fi

# 4) register or repair the section (pacman 7: file:// scheme is mandatory)
SERVER_LINE="Server = file://$REPO_DIR"
if ! grep -q "^\[$REPO_NAME\]" /etc/pacman.conf; then
  if sudo_available; then
    printf '\n# Local Alpha builds (scripts/local-repo.sh)\n[%s]\nSigLevel = Never\n%s\n' \
      "$REPO_NAME" "$SERVER_LINE" | sudo tee -a /etc/pacman.conf >/dev/null
    echo "registered [$REPO_NAME] in /etc/pacman.conf"
  else
    echo "[$REPO_NAME] is missing in /etc/pacman.conf — run this script from a terminal (sudo password needed)"
  fi
elif ! grep -A4 "^\[$REPO_NAME\]" /etc/pacman.conf | grep -qx "$SERVER_LINE"; then
  if sudo_available; then
    tmp="$(mktemp)"
    if awk -v sect="[$REPO_NAME]" -v rep="$SERVER_LINE" '
        $0 == sect { insec = 1; print; next }
        /^\[/ { insec = 0 }
        insec && /^Server = / { print rep; seen = 1; next }
        { print }
        END { exit(seen ? 0 : 1) }' /etc/pacman.conf > "$tmp"; then
      sudo tee /etc/pacman.conf < "$tmp" > /dev/null
      echo "fixed Server line -> $SERVER_LINE"
    else
      echo "section [$REPO_NAME] has no Server line — add '$SERVER_LINE' to /etc/pacman.conf"
    fi
    rm -f "$tmp"
  else
    echo "Server in /etc/pacman.conf is not '$SERVER_LINE' — run this script from a terminal (sudo password needed)"
  fi
fi

# 5) sync databases: plain sudo on a terminal, cached sudo elsewhere
if [ -t 0 ]; then
  if sudo pacman -Sy >/dev/null; then
    echo "pacman databases synced"
  else
    echo "sync failed — run 'sudo pacman -Sy' to see why"
  fi
elif sudo -n pacman -Sy >/dev/null 2>&1; then
  echo "pacman databases synced"
else
  echo "sync skipped — run 'sudo pacman -Sy' once, then: sudo pacman -S alpha"
fi

echo "published $VERSION -> $REPO_DIR"
ls -1 "$REPO_DIR"/alpha-*.pkg.tar.zst
