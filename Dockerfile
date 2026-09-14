# Crystal Group Agent Dashboard
#
# A long-running Node process, not a static site: it holds a poll loop that talks to Zoom
# every few seconds and caches a snapshot every request reads (see services/poller.js).
# That shapes everything below — the container must stay up between requests, and its
# /app/data directory must survive restarts or the day's opt-out history is lost.

# Pinned to the Node the app is developed and tested against. Alpine keeps the image small;
# the app has no native dependencies, so there's nothing to compile.
FROM node:24-alpine

ENV NODE_ENV=production

WORKDIR /app

# Dependencies first, as their own layer: package.json changes far less often than source,
# so edits to src/ or public/ reuse the cached npm install instead of repeating it.
COPY package.json package-lock.json ./

# `npm ci` (not `install`) installs exactly the lockfile, so the image matches what was
# tested. `--omit=dev` skips devDependencies; this project has none today, but that stops
# adding one later from quietly bloating the production image.
RUN npm ci --omit=dev && npm cache clean --force

COPY src/ ./src/
COPY public/ ./public/

# The event store writes here. Created and chowned explicitly because the container runs as
# the unprivileged `node` user, and a volume mounted over this path otherwise arrives owned
# by root and the first write fails at runtime rather than at build time.
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]

# Never run as root. The `node` user ships with the official image.
USER node

EXPOSE 3000

# Measured on a 59-agent account: ~103 MB RSS steady state. Without an explicit cap V8 sizes
# its heap from the HOST's memory, not the container limit, so on a small instance Node
# happily grows past the cgroup limit and gets OOM-killed. 192 MB leaves generous headroom
# while keeping the process comfortably inside a 512 MB container.
ENV NODE_OPTIONS=--max-old-space-size=192

# Hits a real Express route rather than a static file, so the check fails if routing is up
# but the app isn't. Uses node itself — the Alpine image has neither curl nor wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/auth/me',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Exec form, so the process is PID 1 and receives SIGTERM directly. Run the container with
# --init (or `init: true` in compose) to get a real init that reaps zombies; src/index.js
# handles SIGTERM itself to stop the poller and flush the event store before exiting.
CMD ["node", "src/index.js"]
