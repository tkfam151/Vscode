# ClassCode workspace image: code-server (VS Code in the browser) plus the tools
# a student's terminal needs to work like a real computer:
#   - Node.js 22 + npm   (npm i icoa-cli, npm i -g ..., npx ...)
#   - Python 3 + pip     (pip install ... goes to ~/.local)
#   - git, curl, compilers (build-essential), and what Homebrew's installer needs,
#     so the official one-line Homebrew install works:
#       /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
#
# The server builds this automatically the first time (see SERVER.md), or by hand:
#   docker build -t classcode-workspace workspace-image

FROM codercom/code-server:latest

USER root

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential procps file git curl ca-certificates xz-utils unzip zip less nano \
      python3 python3-pip python3-venv python-is-python3 \
 && rm -rf /var/lib/apt/lists/*

ARG NODE_VERSION=22.23.5
RUN arch="$(dpkg --print-architecture)"; case "$arch" in amd64) arch=x64;; arm64) arch=arm64;; *) echo "unsupported arch $arch"; exit 1;; esac \
 && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.gz" \
    | tar -xz -C /usr/local --strip-components=1 --no-same-owner --exclude='*.md' --exclude=LICENSE \
 && node --version && npm --version

# Homebrew lives in /home/linuxbrew. The server mounts a volume there for each
# student, so a Homebrew they install is still there next time.
RUN mkdir -p /home/linuxbrew && chown coder:coder /home/linuxbrew

COPY classcode-env.sh /etc/profile.d/classcode-env.sh
RUN chmod 644 /etc/profile.d/classcode-env.sh \
 && echo '. /etc/profile.d/classcode-env.sh' >> /etc/bash.bashrc

# npm -g and pip install go to the student's home folder (kept between sessions; no sudo needed)
ENV NPM_CONFIG_PREFIX=/home/coder/.npm-global \
    PIP_USER=1 \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PATH=/home/coder/.npm-global/bin:/home/coder/.local/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:$PATH

USER coder
