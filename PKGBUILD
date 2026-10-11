# Maintainer: Alpha <maintainer@alpha.local>
#
# Сборка пакета для Arch Linux (без ruby/fpm, только pacman):
#   npm run pkg
# или вручную:
#   npm run build && npx electron-builder --linux dir && makepkg -f
#
pkgname=alpha
pkgver=0.1.27
pkgrel=1
pkgdesc="Desktop GUI for pi with its own embedded pi runtime"
arch=('x86_64')
url="https://github.com/alpha-app/alpha"
license=('MIT')
depends=()
provides=("$pkgname")
source=()
sha256sums=()

prepare() {
  if [ ! -d "$startdir/dist/linux-unpacked" ]; then
    echo "Нет dist/linux-unpacked. Сначала: npm run build && npx electron-builder --linux dir" >&2
    exit 1
  fi
}

package() {
  install -dm755 "$pkgdir/opt/alpha"
  cp -a "$startdir/dist/linux-unpacked/." "$pkgdir/opt/alpha/"

  install -dm755 "$pkgdir/usr/bin"
  ln -sf /opt/alpha/alpha "$pkgdir/usr/bin/alpha"

  install -Dm644 "$startdir/build/icon.png" \
    "$pkgdir/usr/share/icons/hicolor/512x512/apps/alpha.png"

  install -dm755 "$pkgdir/usr/share/applications"
  cat > "$pkgdir/usr/share/applications/alpha.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Alpha
Comment=Desktop GUI for pi with its own embedded pi runtime
Exec=/opt/alpha/alpha %U
Icon=alpha
Terminal=false
Categories=Development;Utility;
StartupWMClass=alpha
EOF
}