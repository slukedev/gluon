#!/usr/bin/env bash
# Gluon's self-updater. Gluon copies this file to the host and runs it as a transient systemd unit
# (systemd-run), so it keeps going while the Gluon container it replaces stops and starts.
#
#   gluon-update.sh github  <repo> <ref> <version> <commit> <mode> [mode args…]
#   gluon-update.sh pull    <mode> [mode args…]
#
# github: download <repo>@<ref> from GitHub, build it as gluon:<version>, then put it in place.
# pull:   pull the newer image the compose file already names (CasaOS / registry installs).
#
# mode args:
#   umbrel  <appId> <appDataDir> <umbrelContainer|-> <container>
#           Tags the build as <appId>:<version>, points <appDataDir>/Dockerfile at it and asks
#           umbreld to restart the app (which rebuilds from that Dockerfile).
#   compose <workdir> <project> <service> <image> <container> <configFile>[,<configFile>…]
#           Tags the build as the service's own image and recreates the service.
#
# Progress goes to stdout as lines the app reads: "::stage <name>", "::done ok <msg>",
# "::done failed <msg>". Everything else is plain log output.
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

say() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }
stage() { printf '::stage %s\n' "$1"; say "$2"; }
fail() { printf '::done failed %s\n' "$1"; exit 1; }
# Once the running Gluon has been touched, `undo` puts it back; any unexpected error runs it first.
undo() { :; }
trap 'trap - ERR; undo; fail "The update stopped unexpectedly (line $LINENO)."' ERR

action=$1; shift
WORK=""
cleanup() { [ -n "$WORK" ] && rm -rf "$WORK"; }
trap cleanup EXIT

# One updater at a time, whoever started it: two would build over each other and fight over the container.
if command -v flock >/dev/null 2>&1; then
  mkdir -p /var/lib/gluon
  exec 9>/var/lib/gluon/update.lock
  flock -n 9 || fail "Another update is already running."
fi

# Free kilobytes under a folder, or nothing when it can't be told.
free_kb() { { df -Pk "$1" 2>/dev/null || true; } | awk 'NR==2 {print $4}'; }

# ---------------------------------------------------------------- build from GitHub
if [ "$action" = github ]; then
  repo=$1 ref=$2 version=$3 commit=$4; shift 4
  [[ $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "That isn't a GitHub repository name."
  # Always a full commit sha, so what gets built is exactly what was checked, even if a tag moves later.
  [[ $ref =~ ^[0-9a-f]{40}$ ]] || fail "That isn't a version Gluon can download."
  [[ $version =~ ^[A-Za-z0-9_.+-]{1,64}$ ]] || fail "That isn't a version name Gluon can use."
  # Unpack where there's room: /var is often a small partition on home servers.
  tmpbase=/var/tmp best=0
  for d in /var/tmp /tmp /root; do
    [ -d "$d" ] && [ -w "$d" ] || continue
    free=$(free_kb "$d")
    [ -n "$free" ] && [ "$free" -gt "$best" ] && { best=$free; tmpbase=$d; }
  done
  [ "$best" -gt 204800 ] || fail "There isn't enough free space to download Gluon (it needs about 200 MB)."
  # The build writes into Docker's own folder, which needs room for the build and the new image.
  root=$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || true)
  dfree=""
  [ -n "$root" ] && dfree=$(free_kb "$root")
  if [ -n "$dfree" ] && [ "$dfree" -lt 2097152 ]; then
    fail "There isn't enough free space for Docker to build Gluon (it needs about 2 GB in $root)."
  fi
  WORK=$(mktemp -d "$tmpbase/gluon-update.XXXXXX")
  mkdir "$WORK/src"

  stage download "Downloading $repo at $ref…"
  # To a file first: a retry after a dropped connection starts the file over instead of feeding
  # tar half of one download and then all of the next.
  curl -fsSL --retry 3 --connect-timeout 20 --max-time 600 -o "$WORK/src.tar.gz" "https://codeload.github.com/$repo/tar.gz/$ref"
  # GitHub names the archive's folder after the commit: proof this is the commit that was checked.
  top=$(tar -tzf "$WORK/src.tar.gz" | sed -n 1p)
  [[ $top == *-"$ref"/ ]] || fail "The download from GitHub wasn't the version that was checked. Try again later."
  tar -xzf "$WORK/src.tar.gz" --strip-components=1 --no-same-owner -C "$WORK/src"
  rm -f "$WORK/src.tar.gz"
  [ -f "$WORK/src/docker/Dockerfile" ] || fail "That version of Gluon has no docker/Dockerfile to build."

  stage build "Building Gluon $version (this takes a few minutes)…"
  # Older commits' Dockerfiles lack the label that keeps Coolify's daily cleanup off the image.
  docker build --progress=plain -t "gluon:$version" --label coolify.managed=true --label gluon.updater=1 \
    --build-arg GLUON_VERSION="$version" --build-arg GLUON_COMMIT="$commit" --build-arg GLUON_BUILD="github" \
    -f "$WORK/src/docker/Dockerfile" "$WORK/src" 2>&1
  NEW="gluon:$version"
elif [ "$action" = pull ]; then
  NEW="" commit=""
else
  fail "Unknown update action: $action"
fi

mode=$1; shift

# Every update leaves a full image behind. After a good one, keep the new build and the one it
# replaced (to go back to) and drop the updater's older builds. Errors are ignored: an image a
# container still uses stays, and the update has already succeeded.
prune_builds() { # <repository> <image id to keep>…
  local repo=$1 ref id keep k
  shift
  while read -r ref id; do
    case "$ref" in *"<none>"*) continue ;; esac
    keep=0
    for k in "$@"; do [ -n "$k" ] && [[ $k == "sha256:$id"* || $k == "$id"* ]] && keep=1; done
    [ "$keep" = 1 ] || docker image rm "$ref" >/dev/null 2>&1 || true
  done < <(docker image ls --format '{{.Repository}}:{{.Tag}} {{.ID}}' "$repo" 2>/dev/null || true)
  docker image prune -f --filter label=gluon.updater=1 >/dev/null 2>&1 || true
}

wait_healthy() { # <container> <image id> [commit] → 0 when it runs that image (and commit) and is healthy (or has no healthcheck)
  local c=$1 want=$2 commit=${3:-}
  for _ in $(seq 1 90); do
    sleep 4
    local img state health env
    img=$(docker inspect -f '{{.Image}}' "$c" 2>/dev/null || true)
    if [ -n "$commit" ]; then
      env=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$c" 2>/dev/null || true)
      grep -qx "GLUON_COMMIT=$commit" <<<"$env" || continue
    fi
    state=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || true)
    health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c" 2>/dev/null || true)
    if [ -n "$want" ] && [ "$img" != "$want" ]; then continue; fi
    if [ "$state" = running ] && { [ "$health" = healthy ] || [ "$health" = none ]; }; then return 0; fi
  done
  return 1
}

# ---------------------------------------------------------------- put it in place: Umbrel
if [ "$mode" = umbrel ]; then
  app=$1 appdata=$2 umbrel=$3 container=$4
  [[ $app =~ ^[a-z0-9-]+$ ]] || fail "That isn't an Umbrel app id."
  [ -f "$appdata/Dockerfile" ] || fail "Umbrel's copy of Gluon has no Dockerfile at $appdata."
  umbreld() {
    if [ "$umbrel" != "-" ]; then
      docker exec -w /opt/umbreld -e UMBREL_DATA_DIR=/srv/umbrel -e UMBREL_TRPC_ENDPOINT=http://localhost/trpc "$umbrel" ./umbreld client "$@"
    else
      umbreld client "$@"
    fi
  }
  [ -n "$NEW" ] || fail "Umbrel updates come from its app store; use \"Update through Umbrel\"."
  # Umbrel renders every *.template in the app's folder each time it starts the app (then runs
  # `compose up --build`), so the new base image has to go into Dockerfile.template as well:
  # writing only Dockerfile is undone by the restart.
  files=("$appdata/Dockerfile")
  [ -f "$appdata/Dockerfile.template" ] && files+=("$appdata/Dockerfile.template")
  # Whole files are kept, so going back restores exactly what Umbrel had.
  for f in "${files[@]}"; do cp -p "$f" "$WORK/$(basename "$f").prev"; done
  prev=$(head -n1 "${files[-1]}")
  prevcommit=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$container" 2>/dev/null | sed -n 's/^GLUON_COMMIT=//p' | head -n1 || true)
  undo() {
    undo() { :; }
    for f in "${files[@]}"; do cp -p "$WORK/$(basename "$f").prev" "$f" || true; done
    umbreld apps.restart.mutate --appId "$app" >/dev/null 2>&1 || true
  }
  tag="$app:${NEW#gluon:}"
  stage apply "Handing Gluon $tag to Umbrel…"
  docker tag "$NEW" "$tag"
  for f in "${files[@]}"; do printf 'FROM %s\n' "$tag" > "$f"; done
  umbreld apps.restart.mutate --appId "$app" >/dev/null
  stage verify "Waiting for Gluon to come back…"
  # Umbrel rebuilds a thin image on top of the new one, so the image id differs; the build's own
  # commit (carried in its environment) proves the new version is the one running.
  sleep 10
  if wait_healthy "$container" "" "$commit"; then
    keepnew=$(docker image inspect -f '{{.Id}}' "$NEW" 2>/dev/null || true)
    keepold=$(docker image inspect -f '{{.Id}}' "${prev#FROM }" 2>/dev/null || true)
    prune_builds gluon "$keepnew" "$keepold"
    prune_builds "$app" "$keepnew" "$keepold"
    printf '::done ok %s\n' "Gluon ${NEW#gluon:} is running."
    exit 0
  fi
  say "Gluon didn't come back on the new version; going back to ${prev#FROM }."
  undo
  sleep 10
  if wait_healthy "$container" "" "$prevcommit"; then
    fail "The new version didn't start, so Gluon went back to the previous one."
  fi
  fail "The new version didn't start, and the previous one hasn't come back yet. Restart Gluon from Umbrel."
fi

# ---------------------------------------------------------------- put it in place: Compose (incl. CasaOS)
if [ "$mode" = compose ]; then
  workdir=$1 project=$2 service=$3 image=$4 container=$5 configs=$6
  args=(-p "$project")
  IFS=',' read -r -a files <<< "$configs"
  for f in "${files[@]}"; do [ -n "$f" ] && args+=(-f "$f"); done
  cd "$workdir"
  previd=$(docker inspect -f '{{.Image}}' "$container" 2>/dev/null || true)
  if [ -n "$NEW" ]; then
    stage apply "Replacing $container with Gluon ${NEW#gluon:}…"
    docker tag "$NEW" "$image"
  else
    stage download "Pulling the newest $image…"
    docker compose "${args[@]}" pull "$service" 2>&1
    stage apply "Replacing $container…"
  fi
  # Only once the tag has moved: a failed pull leaves the running Gluon alone.
  if [ -n "$previd" ]; then
    undo() {
      undo() { :; }
      say "Putting the previous image back."
      docker tag "$previd" "$image" || true
      docker compose "${args[@]}" up -d --no-build --no-deps --force-recreate "$service" 2>&1 || true
    }
  fi
  newid=$(docker image inspect -f '{{.Id}}' "$image")
  if [ "$newid" = "$previd" ]; then
    printf '::done ok %s\n' "Gluon is already on the newest image."
    exit 0
  fi
  # A failed `up` may already have removed the old container, so it goes back rather than stopping here.
  up=0
  docker compose "${args[@]}" up -d --no-build --no-deps "$service" 2>&1 || up=$?
  stage verify "Waiting for Gluon to come back…"
  if [ "$up" = 0 ] && wait_healthy "$container" "$newid"; then
    if [ -n "$NEW" ]; then prune_builds gluon "$newid" "$previd"; fi
    printf '::done ok %s\n' "Gluon is running the new version."
    exit 0
  fi
  [ -n "$previd" ] || fail "The new version didn't start and there was no previous image to go back to. Run docker compose up -d in $workdir on the server."
  say "Gluon didn't come back healthy on the new version."
  undo
  if wait_healthy "$container" "$previd"; then
    fail "The new version didn't start, so Gluon went back to the previous one."
  fi
  fail "The new version didn't start, and the previous one hasn't come back yet. Run docker compose up -d in $workdir on the server."
fi

fail "Gluon doesn't know how to replace itself in \"$mode\" mode."
