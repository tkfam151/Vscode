# ClassCode: tools installed by the student stay on PATH in every terminal.
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PIP_USER=1 PIP_BREAK_SYSTEM_PACKAGES=1
case ":$PATH:" in *":$HOME/.npm-global/bin:"*) ;; *) PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH" ;; esac
# Homebrew, once installed (it lives in /home/linuxbrew)
if [ -x /home/linuxbrew/.linuxbrew/bin/brew ]; then
  eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
fi
export PATH
