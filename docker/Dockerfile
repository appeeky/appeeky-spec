# Appeeky Spec outside GitHub Actions. MODE=daily|push|weekly runs one routine and
# exits (for a scheduler you already have). MODE=schedule stays up and runs them on a
# schedule itself: docker compose on your own VM, Railway, Fly. See docker-compose.yml.
#
#   docker build -f docker/Dockerfile -t appeeky-spec .
#   docker build -f docker/Dockerfile --build-arg AGENT=1 -t appeeky-spec:agent .   # adds Claude Code and gh for MODE=weekly
#
# See "Running without GitHub Actions" in README.md.

FROM node:22-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci --ignore-scripts
COPY src ./src
COPY skills ./skills
COPY README.md LICENSE ./
RUN npm run build && npm pack --silent && mv appeeky-spec-*.tgz /tmp/appeeky-spec.tgz

FROM node:22-slim
ARG AGENT=0
ARG GH_VERSION=2.62.0
ARG SUPERCRONIC_VERSION=0.2.33
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
# MODE=schedule: a cron that runs in the foreground, logs to stdout and never starts a job that is still running.
RUN arch="$(dpkg --print-architecture)" \
 && curl -fsSL -o /usr/local/bin/supercronic "https://github.com/aptible/supercronic/releases/download/v${SUPERCRONIC_VERSION}/supercronic-linux-${arch}" \
 && chmod +x /usr/local/bin/supercronic
RUN if [ "$AGENT" = "1" ]; then \
      npm install -g @anthropic-ai/claude-code \
      && arch="$(dpkg --print-architecture)" \
      && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz" \
         | tar -xz -C /tmp \
      && mv "/tmp/gh_${GH_VERSION}_linux_${arch}/bin/gh" /usr/local/bin/gh \
      && rm -rf /tmp/gh_*; \
    fi
COPY --from=build /tmp/appeeky-spec.tgz /tmp/appeeky-spec.tgz
RUN npm install -g /tmp/appeeky-spec.tgz && rm /tmp/appeeky-spec.tgz && npm cache clean --force
COPY docker/run.sh /usr/local/bin/appeeky-spec-run
RUN chmod +x /usr/local/bin/appeeky-spec-run

USER node
WORKDIR /home/node
ENTRYPOINT ["appeeky-spec-run"]
