# Maestrly bot toolchain for login shells (terminals). Debian's /etc/profile resets PATH,
# so repeat what the image ENV sets for the app and its non-login shells.
case ":$PATH:" in *":$HOME/.local/share/mise/shims:"*) ;; *) PATH="$HOME/.local/share/mise/shims:$PATH" ;; esac
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$HOME/.local/bin:$PATH" ;; esac
export PATH
export NPM_CONFIG_PREFIX="$HOME/.local"
export PIP_BREAK_SYSTEM_PACKAGES=1
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export MISE_IDIOMATIC_VERSION_FILE_ENABLE_TOOLS=node
